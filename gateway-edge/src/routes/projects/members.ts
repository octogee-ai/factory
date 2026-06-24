import { Router, Request, Response } from "express";
import { strictRateLimit } from "../../middleware/security.js";
import { db, FieldValue } from "../../lib/db.js";
import { mmApi } from "../../lib/mattermost.js";
import { giteaApi } from "../../lib/gitea.js";
import { workspaceGiteaOrg, projectRepoName } from "../../lib/gitea-naming.js";
import { logger } from "../../middleware/logging.js";
import { withProject, type ProjectCtx } from "../../lib/withProject.js";
import { readChannel } from "../../lib/firestoreReads.js";

const router = Router();

interface GuestActor {
  mmUserId: string | undefined;
  giteaUser: string | null;
}

interface ProjectChannels {
  mmChannelId: string | undefined;
  activityChannelId: string | undefined;
}

async function removableGuestMemberRef(
  ctx: ProjectCtx,
  guestUid: string,
  res: Response,
): Promise<FirebaseFirestore.DocumentReference | null> {
  if (guestUid === ctx.project.ownerUid) {
    res.status(400).json({ error: "Cannot remove the project owner" });
    return null;
  }

  const memberRef = ctx.projectRef.collection("members").doc(guestUid);
  const memberDoc = await memberRef.get();
  if (!memberDoc.exists) {
    res.json({ success: true, notAMember: true });
    return null;
  }

  return memberRef;
}

async function removeGuestMember(
  ctx: ProjectCtx,
  memberRef: FirebaseFirestore.DocumentReference,
): Promise<void> {
  await memberRef.delete();
  await ctx.projectRef.update({
    memberCount: FieldValue.increment(-1),
    updatedAt: FieldValue.serverTimestamp(),
  });
}

async function readGuestActor(guestUid: string): Promise<GuestActor> {
  const guestDoc = await db.doc(`users/${guestUid}`).get();
  const guestData = guestDoc.data();
  const username = guestData?.username;
  return {
    mmUserId: guestData?.mattermost?.userId,
    giteaUser: username ? `ws-${username}` : null,
  };
}

async function readProjectChannels(projectRef: FirebaseFirestore.DocumentReference): Promise<ProjectChannels> {
  const generalChan = await readChannel(projectRef.collection("channels").doc("general"));
  return {
    mmChannelId: generalChan?.mattermost?.channelId,
    activityChannelId: generalChan?.mattermost?.activityChannelId,
  };
}

async function removePrimaryChannelMember(channels: ProjectChannels, mmUserId: string | undefined): Promise<void> {
  if (!channels.mmChannelId || !mmUserId) return;
  try {
    await mmApi(`/channels/${channels.mmChannelId}/members/${mmUserId}`, "DELETE");
  } catch (err) {
    logger.warn(`[projects] MM channel removal failed:`, { err });
  }
}

async function removeActivityChannelMember(channels: ProjectChannels, mmUserId: string | undefined): Promise<void> {
  if (!channels.activityChannelId || !mmUserId) return;
  try {
    const { syncActivityMembershipRemove } = await import("../../lib/activityPair.js");
    await syncActivityMembershipRemove(channels.activityChannelId, mmUserId);
  } catch (err) {
    logger.warn(`[projects] activity-channel removal failed:`, { err });
  }
}

async function revokeGuestGiteaAccess(ctx: ProjectCtx, guest: GuestActor): Promise<void> {
  if (!ctx.project.giteaRepoName || !guest.giteaUser) return;
  try {
    await giteaApi(
      workspaceGiteaOrg(ctx.wid),
      `${projectRepoName(ctx.pid)}/collaborators/${guest.giteaUser}`,
      "DELETE",
    );
  } catch (err) {
    logger.warn(`[projects] Gitea removal failed:`, { err });
  }
}

async function removeProjectGuest(ctx: ProjectCtx, guestUid: string, res: Response): Promise<void> {
  const memberRef = await removableGuestMemberRef(ctx, guestUid, res);
  if (!memberRef) return;

  await removeGuestMember(ctx, memberRef);
  const guest = await readGuestActor(guestUid);
  const channels = await readProjectChannels(ctx.projectRef);
  await removePrimaryChannelMember(channels, guest.mmUserId);
  await removeActivityChannelMember(channels, guest.mmUserId);
  await revokeGuestGiteaAccess(ctx, guest);

  logger.info(`[projects] ${ctx.uid} removed ${guestUid} from ${ctx.wid}/${ctx.pid}`);
  res.json({ success: true });
}

router.delete("/:wid/:pid/members/:guestUid", strictRateLimit, async (req: Request, res: Response) => {
  const { wid, pid, guestUid } = req.params as { wid: string; pid: string; guestUid: string };
  await withProject(req, res, wid, pid, {
    ownerOnly: true,
    ownerErrorMessage: "Only the project owner can remove guests",
    logTag: "[projects] Remove guest failed for",
    errorMessage: "Failed to remove guest",
  }, async (ctx) => removeProjectGuest(ctx, guestUid, res));
});

export default router;
