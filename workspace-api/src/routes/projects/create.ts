import { Router, Request, Response } from "express";
import { strictRateLimit } from "../../middleware/security";
import { db, FieldValue } from "../../lib/db";
import { mmApi } from "../../lib/mattermost";
import { logger } from "../../middleware/logging";
import {
  projectGeneralChannelName,
  isValidProjectId,
  PROJECT_ID_MIN_LENGTH,
  PROJECT_ID_MAX_LENGTH,
} from "@shared/types/identity";
import { getWorkspaceMmContext } from "../../lib/mattermost-context";
import { ensureProjectGiteaRepo } from "./provisioning";

const router = Router();

// Reserved project slugs — URL fragments + channel kinds we might add later.
// Shape validation (charset, length) is delegated to isValidProjectId from
// the canonical identity module (docs/DATA-MODEL-REVIEW.md §11.3).
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

// ── GET /slug-available?slug=foo — check availability in caller's workspace ──

router.get("/slug-available", async (req: Request, res: Response) => {
  const uid = req.uid!;
  const slug = String(req.query.slug ?? "").trim();

  const err = validateProjectSlug(slug);
  if (err) {
    res.json({ available: false, reason: err });
    return;
  }

  const userDoc = await db.doc(`users/${uid}`).get();
  const workspaceId = userDoc.data()?.workspaceId ?? userDoc.data()?.username;
  if (!workspaceId) {
    res.status(422).json({ error: "Workspace not provisioned" });
    return;
  }

  const existing = await db.doc(`workspaces/${workspaceId}/projects/${slug}`).get();
  res.json({ available: !existing.exists });
});

// ── POST / — Create project ─────────────────────────────────────────────────

router.post("/", strictRateLimit, async (req: Request, res: Response) => {
  const uid = req.uid!;

  try {
    const { name, slug, tagline, category, projectType, status, visibility } = req.body as {
      name?: string;
      slug?: string;
      tagline?: string;
      category?: string;
      projectType?: string;
      status?: string;
      visibility?: string;
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

    const userDoc = await db.doc(`users/${uid}`).get();
    const userData = userDoc.data();
    const workspaceId = userData?.workspaceId ?? userData?.username;
    if (!workspaceId) {
      res.status(422).json({ error: "Workspace not provisioned" });
      return;
    }

    // Workspace-unique check.
    const projectRef = db.doc(`workspaces/${workspaceId}/projects/${slug}`);
    const existing = await projectRef.get();
    if (existing.exists) {
      res.status(409).json({ error: "A project with this slug already exists in your workspace" });
      return;
    }

    // Target visibility the caller asked for. `visibility` stays `private`
    // while `provisioningState` is not yet `active` so half-provisioned docs
    // never surface in public discovery; `pendingVisibility` preserves the
    // caller's intent so a failed → retry flow can apply it without the
    // client re-submitting. `giteaRepoName` is deterministic (function of
    // `workspaceId + slug`), so we persist it up-front — no reason to defer.
    const targetVisibility = visibility || "private";
    const giteaRepoName = `${workspaceId}-proj-${slug}`;

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
      starCount: 0,
      memberCount: 1, // owner
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });

    // Seed the owner as a member (the subcollection replaces guestUids[]).
    await projectRef.collection("members").doc(uid).set({
      id: uid,
      role: "owner",
      joinedAt: FieldValue.serverTimestamp(),
    });

    // Provisioning: MM channel + Gitea repo. MM channel creation is a hard
    // requirement — a project without a chat channel is unusable. Per
    // docs/PROJECTS-CANVAS-SPEC.md §D4, any MM failure flips the project
    // to `provisioningState: 'failed'` and surfaces 502 to the client so
    // the UI can show a retry affordance. No silent swallowing.
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
        // Project channels carry an Octo agent — they're always private.
        // (Open channels expose agent activity to anyone on the team and
        // also don't auto-add the owner, who'd then be missing from
        // their own project's chat. See scripts/lib/mattermost/channels.ts
        // — the canonical project channel pattern in the provisioner.)
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

    // Add owner + agent (Octo) as channel members. The MM admin token
    // creates the channel which makes the admin user the only auto-member;
    // without explicit adds the owner can't see their own project channel
    // and — more importantly — the agent isn't there to receive OpenClaw
    // RPCs. The agent in the channel is the entire reason the channel
    // exists. Treat missing IDs / add failures as hard errors that flip
    // the project to `provisioningState: 'failed'` so /retry-provisioning
    // can reconcile cleanly. Best-effort here would hide a broken state
    // behind a green "active" flag.
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

    // Activity sibling channel (Activity Stream Phase 1, spec §4.1). Atomic
    // with primary: if the sibling create or member-add fails, flip the
    // project's provisioningState to "failed" so /retry-provisioning can
    // reconcile rather than leaving a half-provisioned pair.
    try {
      const { provisionActivityPair } = await import("../../lib/activityPair");
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

    // Gitea repo + seeded README (PROJECTS-CANVAS-SPEC §D12).
    // Failure here flips the project to `failed` so the UI can retry;
    // the repo is as load-bearing as the MM channel — Canvas has nothing
    // to render without it.
    try {
      await ensureProjectGiteaRepo({
        workspaceId,
        slug,
        name: name.trim(),
        tagline: (tagline || "").trim(),
        projectType: projectType ?? null,
        visibility: targetVisibility,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await projectRef.update({
        provisioningState: "failed",
        provisioningError: message.slice(0, 500),
        updatedAt: FieldValue.serverTimestamp(),
      });
      logger.error(`[projects] Gitea repo creation failed for ${workspaceId}/${slug}:`, { err });
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
