import { Router, Request, Response } from "express";
import { strictRateLimit } from "../../middleware/security";
import { db, FieldValue } from "../../lib/db";
import { mmApi } from "../../lib/mattermost";
import { giteaApi } from "../../lib/gitea";
import { workspaceGiteaOrg, projectRepoName } from "../../lib/gitea-naming";
import { logger } from "../../middleware/logging";
import { withProject } from "../../lib/withProject";
import { readChannel } from "../../lib/firestoreReads";

const router = Router();

router.delete("/:wid/:pid/members/:guestUid", strictRateLimit, async (req: Request, res: Response) => {
  const { wid, pid, guestUid } = req.params;
  await withProject(req, res, wid, pid, {
    ownerOnly: true,
    ownerErrorMessage: "Only the project owner can remove guests",
    logTag: "[projects] Remove guest failed for",
    errorMessage: "Failed to remove guest",
  }, async ({ projectRef, project, uid }) => {
    if (guestUid === project.ownerUid) {
      res.status(400).json({ error: "Cannot remove the project owner" });
      return;
    }

    const memberRef = projectRef.collection("members").doc(guestUid);
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

    const guestDoc = await db.doc(`users/${guestUid}`).get();
    const guestData = guestDoc.data();
    const guestMmUserId = guestData?.mattermost?.userId;

    const generalChan = await readChannel(projectRef.collection("channels").doc("general"));
    const mmChannelId = generalChan?.mattermost?.channelId;
    if (mmChannelId && guestMmUserId) {
      try {
        await mmApi(`/channels/${mmChannelId}/members/${guestMmUserId}`, "DELETE");
      } catch (err) {
        logger.warn(`[projects] MM channel removal failed:`, { err });
      }
    }

    const guestGiteaUser = guestData?.username ? `ws-${guestData.username}` : null;
    if (project.giteaRepoName && guestGiteaUser) {
      try {
        await giteaApi(
          workspaceGiteaOrg(wid),
          `${projectRepoName(pid)}/collaborators/${guestGiteaUser}`,
          "DELETE",
        );
      } catch (err) {
        logger.warn(`[projects] Gitea removal failed:`, { err });
      }
    }

    logger.info(`[projects] ${uid} removed ${guestUid} from ${wid}/${pid}`);
    res.json({ success: true });
  });
});

export default router;
