import { Router, Request, Response } from "express";
import { strictRateLimit } from "../../middleware/security.js";
import { db, FieldValue } from "../../lib/db.js";
import { mmApi } from "../../lib/mattermost.js";
import { logger } from "../../middleware/logging.js";
import { projectGeneralChannelName } from "@shared/types/identity.js";
import { getWorkspaceMmContext } from "../../lib/mattermost-context.js";
import { withProject } from "../../lib/withProject.js";
import { provisionProjectRepo } from "./provisioning.js";
import { projectRepoName } from "../../lib/gitea-naming.js";

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

let existing: { id?: string; type?: string } | null = null;
      try {
        existing = (await mmApi(`/teams/${teamId}/channels/name/${channelName}`)) as { id?: string; type?: string } | null;
      } catch (lookupErr) {

if ((lookupErr as { status?: number } | null)?.status !== 404) throw lookupErr;
      }
      if (existing?.id) {
        mmChannelId = existing.id;

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

const restoredVisibility =
      typeof project.pendingVisibility === "string" ? project.pendingVisibility : project.visibility;
    const deterministicGiteaRepo = projectRepoName(pid);

    const repoErr = await provisionProjectRepo({
      workspaceId: wid,
      slug: pid,
      name: project.name || pid,
      tagline: typeof project.tagline === "string" ? project.tagline : "",
      projectType: typeof project.projectType === "string" ? project.projectType : null,
      visibility: restoredVisibility,
    });
    if (repoErr) {
      await projectRef.update({
        provisioningState: "failed",
        provisioningError: repoErr.slice(0, 500),
        updatedAt: FieldValue.serverTimestamp(),
      });
      logger.error(`[projects] Gitea reconcile failed for ${wid}/${pid}: ${repoErr}`);
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
