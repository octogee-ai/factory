/**
 * POST /:wid/:pid/retry-provisioning — idempotent MM channel + Gitea repair.
 *
 * Two entry points (docs/PROJECTS-CANVAS-SPEC.md §D4):
 *   1. provisioningState === 'failed' — initial create couldn't reach MM.
 *   2. provisioningState === 'active' but channels/general is missing —
 *      legacy pre-PR data where the old silent catch swallowed the error.
 * Idempotent: if the MM channel already exists (by name), reuses its id.
 */
import { Router, Request, Response } from "express";
import { strictRateLimit } from "../../middleware/security";
import { db, FieldValue } from "../../lib/db";
import { mmApi } from "../../lib/mattermost";
import { logger } from "../../middleware/logging";
import { projectGeneralChannelName } from "@shared/types/identity";
import { getWorkspaceMmContext } from "../../lib/mattermost-context";
import { withProject } from "../../lib/withProject";
import { ensureProjectGiteaRepo } from "./provisioning";

const router = Router();

router.post("/:wid/:pid/retry-provisioning", strictRateLimit, async (req: Request, res: Response) => {
  const { wid, pid } = req.params;
  await withProject(req, res, wid, pid, {
    ownerOnly: true,
    ownerErrorMessage: "Only the project owner can retry provisioning",
    logTag: "[projects] Retry provisioning crashed for",
    errorMessage: "Retry provisioning failed",
  }, async ({ projectRef, project, uid }) => {
    const userDoc = await db.doc(`users/${uid}`).get();
    const callerCtx = await getWorkspaceMmContext(uid, wid, userDoc.data());
    const teamId = callerCtx?.teamId;
    if (!teamId) {
      await projectRef.update({
        provisioningState: "failed",
        provisioningError: "Workspace has no Mattermost team context",
        updatedAt: FieldValue.serverTimestamp(),
      });
      res.status(502).json({
        error: "Retry failed — workspace chat is not ready",
      });
      return;
    }

    const channelName = projectGeneralChannelName(wid, pid);
    let mmChannelId: string;
    try {
      // Look up existing channel by name first so retry is idempotent when
      // the MM channel was created on a prior attempt but the Firestore
      // subdoc write was interrupted.
      let existing: { id?: string } | null = null;
      try {
        existing = (await mmApi(`/teams/${teamId}/channels/name/${channelName}`)) as { id?: string } | null;
      } catch (lookupErr) {
        // A 404 here means the channel doesn't exist yet — fall through to
        // create. Any other status bubbles up as a real failure. `status`
        // is attached by mmApi so we don't parse the error message.
        if ((lookupErr as { status?: number } | null)?.status !== 404) throw lookupErr;
      }
      if (existing?.id) {
        mmChannelId = existing.id;
      } else {
        const ch = (await mmApi("/channels", "POST", {
          team_id: teamId,
          name: channelName,
          display_name: project.name || pid,
          type: "O",
        })) as { id?: string };
        if (!ch?.id) throw new Error("MM returned no channel id");
        mmChannelId = ch.id;
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await projectRef.update({
        provisioningState: "failed",
        provisioningError: message.slice(0, 500),
        updatedAt: FieldValue.serverTimestamp(),
      });
      logger.error(`[projects] Retry provisioning failed for ${wid}/${pid}:`, { err });
      res.status(502).json({ error: "Retry failed — could not create chat channel" });
      return;
    }

    await projectRef.collection("channels").doc("general").set({
      id: "general",
      kind: "general",
      name: "general",
      mattermost: { channelId: mmChannelId },
      createdAt: FieldValue.serverTimestamp(),
    });

    // Restore the caller's originally-requested visibility (captured at
    // creation in `pendingVisibility`) and backfill `giteaRepoName` if the
    // doc predates the up-front write. For legacy data without
    // `pendingVisibility`, leave the current `visibility` untouched.
    const restoredVisibility =
      typeof project.pendingVisibility === "string" ? project.pendingVisibility : project.visibility;
    const deterministicGiteaRepo = `${wid}-proj-${pid}`;

    // Gitea reconcile (PROJECTS-CANVAS-SPEC §D12): retry drives the repo
    // to the same ready state a fresh create would produce. Both helpers
    // below are idempotent — 409 on repo-exists, short-circuit on
    // README-already-present — so repeated retries don't double-write.
    try {
      await ensureProjectGiteaRepo({
        workspaceId: wid,
        slug: pid,
        name: project.name || pid,
        tagline: typeof project.tagline === "string" ? project.tagline : "",
        projectType: typeof project.projectType === "string" ? project.projectType : null,
        visibility: restoredVisibility,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await projectRef.update({
        provisioningState: "failed",
        provisioningError: message.slice(0, 500),
        updatedAt: FieldValue.serverTimestamp(),
      });
      logger.error(`[projects] Gitea reconcile failed for ${wid}/${pid}:`, { err });
      res.status(502).json({ error: "Retry failed — could not reconcile code repo" });
      return;
    }

    await projectRef.update({
      provisioningState: "active",
      provisioningError: null,
      visibility: restoredVisibility,
      pendingVisibility: null,
      giteaRepoName: project.giteaRepoName || deterministicGiteaRepo,
      updatedAt: FieldValue.serverTimestamp(),
    });

    logger.info(`[projects] Retry provisioning succeeded for ${wid}/${pid}`);
    res.json({ success: true, channelId: mmChannelId });
  });
});

export default router;
