/**
 * Project creation endpoints.
 *
 * GET  /slug-available — check if a slug is free in the caller's workspace
 * POST /                — create a new project (user-typed slug)
 *
 * Create is the most complex single flow in the projects routes: Firestore
 * write → MM channel provision → Gitea repo seed. Any failure in the outer
 * chain flips the project to `provisioningState: 'failed'` + returns 502 so
 * the UI can show a retry affordance (PROJECTS-CANVAS-SPEC §D4). No silent
 * swallowing.
 */
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

    let mmChannelId: string;
    try {
      const channelName = projectGeneralChannelName(workspaceId, slug);
      const ch = (await mmApi("/channels", "POST", {
        team_id: teamId,
        name: channelName,
        display_name: name.trim(),
        type: "O", // public within the team
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

    await projectRef.collection("channels").doc("general").set({
      id: "general",
      kind: "general",
      name: "general",
      mattermost: { channelId: mmChannelId },
      createdAt: FieldValue.serverTimestamp(),
    });

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
