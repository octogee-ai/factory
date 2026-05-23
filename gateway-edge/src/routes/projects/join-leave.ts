import { Router, Request, Response } from "express";
import { strictRateLimit } from "../../middleware/security.js";
import { db, FieldValue } from "../../lib/db.js";
import { mmApi } from "../../lib/mattermost.js";
import { giteaApi } from "../../lib/gitea.js";
import { workspaceGiteaOrg, projectRepoName } from "../../lib/gitea-naming.js";
import { logger } from "../../middleware/logging.js";
import { getWorkspaceMmContext } from "../../lib/mattermost-context.js";
import { withProject } from "../../lib/withProject.js";
import { readChannel } from "../../lib/firestoreReads.js";

const router = Router();

router.post("/:wid/:pid/join", strictRateLimit, async (req: Request, res: Response) => {
  const { wid, pid } = req.params as { wid: string; pid: string };
  await withProject(req, res, wid, pid, {
    logTag: "[projects] Join failed for",
    errorMessage: "Failed to join project",
  }, async ({ projectRef, project, uid }) => {
    if (project.ownerUid === uid) {
      res.status(400).json({ error: "You already own this project" });
      return;
    }

    if (project.visibility === "private") {
      res.status(403).json({ error: "This project is private. You need an invite to join." });
      return;
    }

    const memberRef = projectRef.collection("members").doc(uid);
    const existingMember = await memberRef.get();
    if (existingMember.exists) {
      res.json({ success: true, alreadyMember: true });
      return;
    }

const ownerCtx = await getWorkspaceMmContext(project.ownerUid, wid);
    const teamId = ownerCtx?.teamId;
    const joinerDoc = await db.doc(`users/${uid}`).get();
    const joinerData = joinerDoc.data();
    const joinerMmUserId = joinerData?.mattermost?.userId;

    if (teamId && joinerMmUserId) {
      try {
        await mmApi(`/teams/${teamId}/members/${joinerMmUserId}`);
      } catch {
        try {
          await mmApi(`/teams/${teamId}/members`, "POST", {
            team_id: teamId,
            user_id: joinerMmUserId,
          });
        } catch (addErr) {
          const msg = addErr instanceof Error ? addErr.message : String(addErr);
          if (!msg.includes("409")) {
            logger.error(`[projects] Failed to add user to MM team:`, { err: addErr });
            res.status(500).json({ error: "Failed to join project — could not add to chat team" });
            return;
          }
        }
      }
    }

    await memberRef.set({
      id: uid,
      role: "member",
      joinedAt: FieldValue.serverTimestamp(),
    });
    await projectRef.update({
      memberCount: FieldValue.increment(1),
      updatedAt: FieldValue.serverTimestamp(),
    });

const generalChan = await readChannel(projectRef.collection("channels").doc("general"));
    const mmChannelId = generalChan?.mattermost?.channelId;
    const activityChannelId = generalChan?.mattermost?.activityChannelId;
    if (mmChannelId && joinerMmUserId) {
      try {
        await mmApi(`/channels/${mmChannelId}/members`, "POST", {
          user_id: joinerMmUserId,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (!msg.includes("409")) {
          logger.warn(`[projects] MM channel join failed:`, { err });
        }
      }
    }

if (activityChannelId && joinerMmUserId) {
      try {
        const { syncActivityMembershipAdd } = await import("../../lib/activityPair.js");
        await syncActivityMembershipAdd(activityChannelId, joinerMmUserId);
      } catch (err) {
        logger.warn(`[projects] activity-channel join failed:`, { err });
      }
    }

const joinerGiteaUser = joinerData?.username ? `ws-${joinerData.username}` : null;
    if (project.giteaRepoName && joinerGiteaUser) {
      try {
        await giteaApi(
          workspaceGiteaOrg(wid),
          `${projectRepoName(pid)}/collaborators/${joinerGiteaUser}`,
          "PUT",
          { permission: "read" },
        );
      } catch (err) {
        logger.warn(`[projects] Gitea access grant failed:`, { err });
      }
    }

    logger.info(`[projects] ${uid} joined ${wid}/${pid}`);
    res.json({ success: true });
  });
});

router.post("/:wid/:pid/leave", strictRateLimit, async (req: Request, res: Response) => {
  const { wid, pid } = req.params as { wid: string; pid: string };
  await withProject(req, res, wid, pid, {
    logTag: "[projects] Leave failed for",
    errorMessage: "Failed to leave project",
  }, async ({ projectRef, project, uid }) => {
    if (project.ownerUid === uid) {
      res.status(400).json({ error: "You cannot leave your own project" });
      return;
    }

    const memberRef = projectRef.collection("members").doc(uid);
    const memberDoc = await memberRef.get();
    if (!memberDoc.exists) {
      res.json({ success: true, notAMember: true });
      return;
    }

    await memberRef.delete();
    await projectRef.update({
      memberCount: FieldValue.increment(-1),
      updatedAt: FieldValue.serverTimestamp(),
    });

    const leaverDoc = await db.doc(`users/${uid}`).get();
    const leaverData = leaverDoc.data();
    const leaverMmUserId = leaverData?.mattermost?.userId;

    const generalChan = await readChannel(projectRef.collection("channels").doc("general"));
    const mmChannelId = generalChan?.mattermost?.channelId;
    const activityChannelId = generalChan?.mattermost?.activityChannelId;
    if (mmChannelId && leaverMmUserId) {
      try {
        await mmApi(`/channels/${mmChannelId}/members/${leaverMmUserId}`, "DELETE");
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (!msg.includes("404")) {
          logger.warn(`[projects] MM channel leave failed:`, { err });
        }
      }
    }
    
    if (activityChannelId && leaverMmUserId) {
      try {
        const { syncActivityMembershipRemove } = await import("../../lib/activityPair.js");
        await syncActivityMembershipRemove(activityChannelId, leaverMmUserId);
      } catch (err) {
        logger.warn(`[projects] activity-channel leave failed:`, { err });
      }
    }

    const leaverGiteaUser = leaverData?.username ? `ws-${leaverData.username}` : null;
    if (project.giteaRepoName && leaverGiteaUser) {
      try {
        await giteaApi(
          workspaceGiteaOrg(wid),
          `${projectRepoName(pid)}/collaborators/${leaverGiteaUser}`,
          "DELETE",
        );
      } catch (err) {
        logger.warn(`[projects] Gitea leave failed:`, { err });
      }
    }

    logger.info(`[projects] ${uid} left ${wid}/${pid}`);
    res.json({ success: true });
  });
});

export default router;
