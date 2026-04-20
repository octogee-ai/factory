/**
 * PATCH /display-name — rename the Builder's MM team.
 *
 * Spec: docs/WORKSPACE-NAMING-CANONICAL-SPEC §"Phase 5 — Settings modal".
 * MM is canonical for workspace team display_name; Firestore stores only
 * opaque identity (slug + teamId). This route reads the caller's workspace
 * from Firestore (lookup only), verifies ownership, then writes the new
 * display_name to MM via the admin API. Zero Firestore writes — the
 * sidebar re-reads team name from the MM websocket feed automatically.
 *
 * Fails loudly on missing/invalid input (400), missing workspace (404),
 * missing teamId (409, provisioning not finished), non-owner (403), or
 * MM error (surfaced as 5xx via the error middleware).
 */
import { Router, Request, Response, NextFunction } from "express";
import { readWorkspace } from "../../lib/firestoreReads";
import { mmApi } from "../../lib/mattermost";
import { logger } from "../../middleware/logging";

const router = Router();

const MM_TEAM_DISPLAY_NAME_MAX = 64; // MM's own limit on the display_name field

router.patch("/display-name", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const uid = req.uid!;
    const raw = typeof req.body?.displayName === "string" ? req.body.displayName : "";
    const displayName = raw.trim();
    if (displayName.length === 0) {
      res.status(400).json({ error: "displayName is required" });
      return;
    }
    if (displayName.length > MM_TEAM_DISPLAY_NAME_MAX) {
      res.status(400).json({
        error: `displayName exceeds ${MM_TEAM_DISPLAY_NAME_MAX}-char MM limit`,
      });
      return;
    }

    // Resolve the caller's workspace. Per v3 §2 the user's username IS the
    // workspace slug; `workspaceId` is the denormalized copy used on the
    // user doc for convenient lookup without a join.
    const userData = req.user ?? {};
    const slug = userData.workspaceId || userData.username;
    if (!slug) {
      res.status(404).json({ error: "No workspace for caller" });
      return;
    }

    const workspace = await readWorkspace(slug);
    if (!workspace) {
      res.status(404).json({ error: "Workspace not found" });
      return;
    }
    if (workspace.ownerUid !== uid) {
      res.status(403).json({ error: "Only the workspace owner can rename" });
      return;
    }

    const teamId = workspace.mattermost.teamId;
    if (!teamId) {
      // Workspace exists but MM provisioning hasn't produced a team id yet.
      // 409 (Conflict) signals "try again once provisioning finishes" rather
      // than 404 ("no such thing") — the thing exists, it's just not ready.
      res.status(409).json({ error: "Workspace is not yet provisioned" });
      return;
    }

    await mmApi(`/teams/${teamId}`, "PUT", { display_name: displayName });

    // Deliberately no Firestore write. MM is canonical for display_name;
    // the app reads it back via the MM websocket.
    res.json({ ok: true, displayName });
  } catch (err) {
    logger.error(`[workspace] PATCH /display-name failed`, {
      uid: req.uid,
      error: err instanceof Error ? err.message : String(err),
    });
    next(err);
  }
});

export default router;
