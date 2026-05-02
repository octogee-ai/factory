/**
 * Project membership — join + leave endpoints.
 *
 * POST /:wid/:pid/join  — add the caller as a project member (not owner).
 * POST /:wid/:pid/leave — remove the caller from a project they don't own.
 *
 * Membership model (epic #428): workspace and project membership are
 * independent. Joining a project adds the caller to the MM team for channel
 * access but does NOT add them to the workspace members subcollection.
 * Leaving a project removes them from the project channel only.
 */
import { Router, Request, Response } from "express";
import { strictRateLimit } from "../../middleware/security";
import { db, FieldValue } from "../../lib/db";
import { mmApi } from "../../lib/mattermost";
import { giteaApi } from "../../lib/gitea";
import { logger } from "../../middleware/logging";
import { getWorkspaceMmContext } from "../../lib/mattermost-context";
import { withProject } from "../../lib/withProject";
import { readChannel } from "../../lib/firestoreReads";

const router = Router();

router.post("/:wid/:pid/join", strictRateLimit, async (req: Request, res: Response) => {
  const { wid, pid } = req.params;
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

    // Independent membership: MM team membership is required for channel access.
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

    // Add to project MM channel (look up from channels subcollection).
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
    // Mirror membership to the activity sibling channel (Activity Stream
    // spec §4.1 + G.O — atomic membership across the pair).
    if (activityChannelId && joinerMmUserId) {
      try {
        const { syncActivityMembershipAdd } = await import("../../lib/activityPair");
        await syncActivityMembershipAdd(activityChannelId, joinerMmUserId);
      } catch (err) {
        logger.warn(`[projects] activity-channel join failed:`, { err });
      }
    }

    // Grant Gitea project repo read access.
    const joinerGiteaUser = joinerData?.username ? `ws-${joinerData.username}` : null;
    if (project.giteaRepoName && joinerGiteaUser) {
      try {
        await giteaApi(
          `${project.giteaRepoName}/collaborators/${joinerGiteaUser}`,
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
  const { wid, pid } = req.params;
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
    // Mirror leave on the activity sibling.
    if (activityChannelId && leaverMmUserId) {
      try {
        const { syncActivityMembershipRemove } = await import("../../lib/activityPair");
        await syncActivityMembershipRemove(activityChannelId, leaverMmUserId);
      } catch (err) {
        logger.warn(`[projects] activity-channel leave failed:`, { err });
      }
    }

    const leaverGiteaUser = leaverData?.username ? `ws-${leaverData.username}` : null;
    if (project.giteaRepoName && leaverGiteaUser) {
      try {
        await giteaApi(
          `${project.giteaRepoName}/collaborators/${leaverGiteaUser}`,
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
