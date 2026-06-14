import { Router, Request, Response } from "express";
import { strictRateLimit } from "../../middleware/security.js";
import { db, FieldValue } from "../../lib/db.js";
import { mmApi } from "../../lib/mattermost.js";
import { logger } from "../../middleware/logging.js";
import {
  projectGeneralChannelName,
  isValidProjectId,
  PROJECT_ID_MIN_LENGTH,
  PROJECT_ID_MAX_LENGTH,
} from "@shared/types/identity.js";
import { getWorkspaceMmContext } from "../../lib/mattermost-context.js";
import { projectRepoName } from "../../lib/gitea-naming.js";
import { provisionProjectRepo } from "./provisioning.js";
import { isValidGithubRepoSource } from "../../lib/github.js";

const router = Router();

const RESERVED_PROJECT_SLUGS = new Set([
  "channels", "members", "files", "canvas", "chat",
  "settings", "discover", "admin", "new", "create",
]);

function validateProjectSlug(slug: string): string | null {
  if (!isValidProjectId(slug)) {
    return `Slug must be ${PROJECT_ID_MIN_LENGTH}–${PROJECT_ID_MAX_LENGTH} chars, lowercase letters and digits only (no hyphens).`;
  }
  if (RESERVED_PROJECT_SLUGS.has(slug)) return "That slug is reserved.";
  return null;
}

type RepoSourceResult =
  | { ok: true; value: { provider: "github"; owner: string; repo: string } | null }
  | { ok: false; status: number; error: string };

function resolveCreateRepoSource(repoSource: unknown, isAdmin: boolean): RepoSourceResult {
  if (repoSource === undefined || repoSource === null) return { ok: true, value: null };
  if (!isAdmin) return { ok: false, status: 403, error: "GitHub-backed projects are operator-only" };
  if (!isValidGithubRepoSource(repoSource)) {
    return { ok: false, status: 400, error: "Invalid repoSource (expected { provider: 'github', owner, repo })" };
  }
  return { ok: true, value: repoSource };
}

router.get("/slug-available", async (req: Request, res: Response) => {
  const slug = String(req.query.slug ?? "").trim();

  const err = validateProjectSlug(slug);
  if (err) {
    res.json({ available: false, reason: err });
    return;
  }

  const workspaceId = req.workspaceSlug;
  if (!workspaceId) {
    res.status(422).json({ error: "Workspace not provisioned" });
    return;
  }

  const existing = await db.doc(`workspaces/${workspaceId}/projects/${slug}`).get();
  res.json({ available: !existing.exists });
});

router.post("/", strictRateLimit, async (req: Request, res: Response) => {
  const uid = req.uid!;

  try {
    const { name, slug, tagline, category, projectType, status, visibility, repoSource } = req.body as {
      name?: string;
      slug?: string;
      tagline?: string;
      category?: string;
      projectType?: string;
      status?: string;
      visibility?: string;
      repoSource?: unknown;
    };

    if (!name || name.trim().length === 0) {
      res.status(400).json({ error: "Project name is required" });
      return;
    }
    if (!slug || typeof slug !== "string") {
      res.status(400).json({ error: "Project slug is required" });
      return;
    }

    const slugErr = validateProjectSlug(slug);
    if (slugErr) {
      res.status(400).json({ error: slugErr });
      return;
    }

    const rs = resolveCreateRepoSource(repoSource, !!req.isAdmin);
    if (!rs.ok) {
      res.status(rs.status).json({ error: rs.error });
      return;
    }
    const ghRepoSource = rs.value;

    const userData = req.user;
    const workspaceId = req.workspaceSlug;
    if (!workspaceId) {
      res.status(422).json({ error: "Workspace not provisioned" });
      return;
    }

const projectRef = db.doc(`workspaces/${workspaceId}/projects/${slug}`);
    const existing = await projectRef.get();
    if (existing.exists) {
      res.status(409).json({ error: "A project with this slug already exists in your workspace" });
      return;
    }

const targetVisibility = visibility || "private";
    const giteaRepoName = projectRepoName(slug);

    await projectRef.set({
      id: slug,
      ownerUid: uid,
      workspaceId,
      slug,
      name: name.trim(),
      tagline: (tagline || "").trim(),
      description: "",
      category: category || "other",
      projectType: projectType || null,
      status: status || "building",
      visibility: "private",
      pendingVisibility: targetVisibility,
      provisioningState: "provisioning",
      canvasFile: "README.md",
      previewUrl: null,
      giteaRepoName,
      repoSource: ghRepoSource,
      starCount: 0,
      memberCount: 1, // owner
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });

await projectRef.collection("members").doc(uid).set({
      id: uid,
      role: "owner",
      joinedAt: FieldValue.serverTimestamp(),
    });

const callerCtx = await getWorkspaceMmContext(uid, workspaceId, userData);
    const teamId = callerCtx?.teamId;
    if (!teamId) {
      await projectRef.update({
        provisioningState: "failed",
        provisioningError: "Workspace has no Mattermost team context",
        updatedAt: FieldValue.serverTimestamp(),
      });
      logger.error(`[projects] Create failed — no MM teamId for workspace ${workspaceId}`);
      res.status(502).json({
        error: "Project provisioning failed — workspace chat is not ready",
        workspaceId,
        slug,
      });
      return;
    }

    const channelName = projectGeneralChannelName(workspaceId, slug);
    let mmChannelId: string;
    try {
      const ch = (await mmApi("/channels", "POST", {
        team_id: teamId,
        name: channelName,
        display_name: name.trim(),

type: "P",
      })) as { id?: string };
      if (!ch?.id) throw new Error("MM returned no channel id");
      mmChannelId = ch.id;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await projectRef.update({
        provisioningState: "failed",
        provisioningError: message.slice(0, 500),
        updatedAt: FieldValue.serverTimestamp(),
      });
      logger.error(`[projects] MM channel creation failed for ${workspaceId}/${slug}:`, { err });
      res.status(502).json({
        error: "Project provisioning failed — could not create chat channel",
        workspaceId,
        slug,
      });
      return;
    }

const memberAdds: Array<{ id: string | null; label: string }> = [
      { id: callerCtx.userId, label: "owner" },
      { id: callerCtx.coachUserId, label: "agent" },
    ];
    const memberFailure = await (async (): Promise<string | null> => {
      for (const m of memberAdds) {
        if (!m.id) {
          return `${m.label} has no Mattermost userId — provisioning incomplete`;
        }
        try {
          await mmApi(`/channels/${mmChannelId}/members`, "POST", { user_id: m.id });
        } catch (err) {
          return `Add ${m.label} ${m.id} failed: ${err instanceof Error ? err.message : String(err)}`;
        }
      }
      return null;
    })();
    if (memberFailure) {
      await projectRef.update({
        provisioningState: "failed",
        provisioningError: memberFailure.slice(0, 500),
        updatedAt: FieldValue.serverTimestamp(),
      });
      logger.error(`[projects] Channel membership failed for ${workspaceId}/${slug}: ${memberFailure}`);
      res.status(502).json({
        error: "Project provisioning failed — could not add channel members",
        workspaceId,
        slug,
      });
      return;
    }

    await projectRef.collection("channels").doc("general").set({
      id: "general",
      kind: "general",
      name: "general",
      mattermost: { channelId: mmChannelId },
      createdAt: FieldValue.serverTimestamp(),
    });

try {
      const { provisionActivityPair } = await import("../../lib/activityPair.js");
      await provisionActivityPair({
        primaryName: channelName,
        primaryChannelId: mmChannelId,
        teamId,
        type: "P",
        kind: "project",
        members: memberAdds.map((m) => m.id),
        recordActivityChannelId: async (activityChannelId) => {
          await projectRef
            .collection("channels")
            .doc("general")
            .set({ mattermost: { activityChannelId } }, { merge: true });
        },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await projectRef.update({
        provisioningState: "failed",
        provisioningError: message.slice(0, 500),
        updatedAt: FieldValue.serverTimestamp(),
      });
      logger.error(`[projects] activity-pair provisioning failed for ${workspaceId}/${slug}: ${message}`);
      res.status(502).json({
        error: "Project provisioning failed — could not create activity channel",
        workspaceId,
        slug,
      });
      return;
    }

    const repoErr = await provisionProjectRepo({
      workspaceId,
      slug,
      name: name.trim(),
      tagline: (tagline || "").trim(),
      projectType: projectType ?? null,
      visibility: targetVisibility,
    });
    if (repoErr) {
      await projectRef.update({
        provisioningState: "failed",
        provisioningError: repoErr.slice(0, 500),
        updatedAt: FieldValue.serverTimestamp(),
      });
      logger.error(`[projects] Gitea repo creation failed for ${workspaceId}/${slug}: ${repoErr}`);
      res.status(502).json({
        error: "Project provisioning failed — could not create code repo",
        workspaceId,
        slug,
      });
      return;
    }

    await projectRef.update({
      provisioningState: "active",
      provisioningError: null,
      visibility: targetVisibility,
      pendingVisibility: null,
      updatedAt: FieldValue.serverTimestamp(),
    });

    logger.info(`[projects] Created project ${workspaceId}/${slug}`);

    res.json({
      success: true,
      workspaceId,
      slug,
      channelId: mmChannelId,
    });
  } catch (err) {
    logger.error(`[projects] Create failed:`, { err });
    res.status(500).json({ error: "Failed to create project" });
  }
});

export default router;
