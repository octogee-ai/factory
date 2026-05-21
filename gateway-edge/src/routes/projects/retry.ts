import { Router, Request, Response } from "express";
import { strictRateLimit } from "../../middleware/security";
import { db, FieldValue } from "../../lib/db";
import { mmApi } from "../../lib/mattermost";
import { logger } from "../../middleware/logging";
import { projectGeneralChannelName } from "@shared/types/identity";
import { getWorkspaceMmContext } from "../../lib/mattermost-context";
import { withProject } from "../../lib/withProject";
import { ensureProjectGiteaRepo } from "./provisioning";
import { projectRepoName } from "../../lib/gitea-naming";

const router = Router();

router.post("/:wid/:pid/retry-provisioning", strictRateLimit, async (req: Request, res: Response) => {
  const { wid, pid } = req.params as { wid: string; pid: string };
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
      let existing: { id?: string; type?: string } | null = null;
      try {
        existing = (await mmApi(`/teams/${teamId}/channels/name/${channelName}`)) as { id?: string; type?: string } | null;
      } catch (lookupErr) {
        // A 404 here means the channel doesn't exist yet — fall through to
        // create. Any other status bubbles up as a real failure. `status`
        // is attached by mmApi so we don't parse the error message.
        if ((lookupErr as { status?: number } | null)?.status !== 404) throw lookupErr;
      }
      if (existing?.id) {
        mmChannelId = existing.id;
        // Pre-§D4 channels were created as type "O" (open). Project
        // channels carry an Octo agent and MUST be private — convert
        // legacy data on retry. PUT is idempotent: P→P returns 200.
        // A failed conversion is a HARD failure: leaving an open
        // channel behind would leak agent activity to the whole team,
        // which violates the "all project channels are private"
        // invariant. Let it throw to the outer try/catch so the
        // project flips to provisioningState: 'failed' instead of
        // being silently marked active with an open channel.
        if (existing.type === "O") {
          await mmApi(`/channels/${mmChannelId}/privacy`, "PUT", { privacy: "P" });
        }
      } else {
        const ch = (await mmApi("/channels", "POST", {
          team_id: teamId,
          name: channelName,
          display_name: project.name || pid,
          type: "P",
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

    // Ensure owner + agent are channel members. The agent in the channel
    // is the whole point of the channel — without it OpenClaw RPCs land
    // in a void. Treat missing IDs / add failures as hard errors so the
    // project flips to `provisioningState: 'failed'` rather than masquerading
    // as healthy. MM's `POST /channels/{id}/members` is idempotent — a
    // re-add returns 200 with the existing membership.
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
      logger.error(`[projects] Retry membership failed for ${wid}/${pid}: ${memberFailure}`);
      res.status(502).json({ error: "Retry failed — could not add channel members" });
      return;
    }

    // Activity sibling — idempotent on retry (provisionActivityPair finds
    // the existing channel by name when MM rejects the second create).
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
      logger.error(`[projects] Retry activity-pair failed for ${wid}/${pid}: ${message}`);
      res.status(502).json({ error: "Retry failed — could not provision activity channel" });
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
    const deterministicGiteaRepo = projectRepoName(pid);

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
