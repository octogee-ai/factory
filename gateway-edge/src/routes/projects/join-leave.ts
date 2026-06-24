import { Router, Request, Response } from "express";
import { strictRateLimit } from "../../middleware/security.js";
import { db, FieldValue } from "../../lib/db.js";
import { mmApi } from "../../lib/mattermost.js";
import { giteaApi } from "../../lib/gitea.js";
import { workspaceGiteaOrg, projectRepoName } from "../../lib/gitea-naming.js";
import { logger } from "../../middleware/logging.js";
import { getWorkspaceMmContext } from "../../lib/mattermost-context.js";
import { withProject, type ProjectCtx } from "../../lib/withProject.js";
import { readChannel } from "../../lib/firestoreReads.js";

const router = Router();

interface ProjectActor {
  mmUserId: string | undefined;
  giteaUser: string | null;
}

interface ProjectChannels {
  mmChannelId: string | undefined;
  activityChannelId: string | undefined;
}

function errorIncludes(err: unknown, expected: string): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.includes(expected);
}

async function readProjectActor(uid: string): Promise<ProjectActor> {
  const actorDoc = await db.doc(`users/${uid}`).get();
  const data = actorDoc.data();
  const username = data?.username;
  return {
    mmUserId: data?.mattermost?.userId,
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

async function joinMemberRef(
  ctx: ProjectCtx,
  res: Response,
): Promise<FirebaseFirestore.DocumentReference | null> {
  if (ctx.project.ownerUid === ctx.uid) {
    res.status(400).json({ error: "You already own this project" });
    return null;
  }

  if (ctx.project.visibility === "private") {
    res.status(403).json({ error: "This project is private. You need an invite to join." });
    return null;
  }

  const memberRef = ctx.projectRef.collection("members").doc(ctx.uid);
  const existingMember = await memberRef.get();
  if (existingMember.exists) {
    res.json({ success: true, alreadyMember: true });
    return null;
  }

  return memberRef;
}

async function addMattermostTeamMember(
  teamId: string,
  mmUserId: string,
  res: Response,
): Promise<boolean> {
  try {
    await mmApi(`/teams/${teamId}/members/${mmUserId}`);
    return true;
  } catch {
    try {
      await mmApi(`/teams/${teamId}/members`, "POST", {
        team_id: teamId,
        user_id: mmUserId,
      });
      return true;
    } catch (addErr) {
      if (errorIncludes(addErr, "409")) return true;
      logger.error(`[projects] Failed to add user to MM team:`, { err: addErr });
      res.status(500).json({ error: "Failed to join project — could not add to chat team" });
      return false;
    }
  }
}

async function ensureProjectJoinerTeamMember(
  ctx: ProjectCtx,
  actor: ProjectActor,
  res: Response,
): Promise<boolean> {
  const ownerCtx = await getWorkspaceMmContext(ctx.project.ownerUid, ctx.wid);
  const teamId = ownerCtx?.teamId;
  if (!teamId || !actor.mmUserId) return true;
  return addMattermostTeamMember(teamId, actor.mmUserId, res);
}

async function writeProjectJoin(
  ctx: ProjectCtx,
  memberRef: FirebaseFirestore.DocumentReference,
): Promise<void> {
  await memberRef.set({
    id: ctx.uid,
    role: "member",
    joinedAt: FieldValue.serverTimestamp(),
  });
  await ctx.projectRef.update({
    memberCount: FieldValue.increment(1),
    updatedAt: FieldValue.serverTimestamp(),
  });
}

async function addMattermostChannelMember(channels: ProjectChannels, mmUserId: string | undefined): Promise<void> {
  if (!channels.mmChannelId || !mmUserId) return;
  try {
    await mmApi(`/channels/${channels.mmChannelId}/members`, "POST", {
      user_id: mmUserId,
    });
  } catch (err) {
    if (!errorIncludes(err, "409")) {
      logger.warn(`[projects] MM channel join failed:`, { err });
    }
  }
}

async function addActivityChannelMember(channels: ProjectChannels, mmUserId: string | undefined): Promise<void> {
  if (!channels.activityChannelId || !mmUserId) return;
  try {
    const { syncActivityMembershipAdd } = await import("../../lib/activityPair.js");
    await syncActivityMembershipAdd(channels.activityChannelId, mmUserId);
  } catch (err) {
    logger.warn(`[projects] activity-channel join failed:`, { err });
  }
}

async function grantProjectGiteaAccess(ctx: ProjectCtx, actor: ProjectActor): Promise<void> {
  if (!ctx.project.giteaRepoName || !actor.giteaUser) return;
  try {
    await giteaApi(
      workspaceGiteaOrg(ctx.wid),
      `${projectRepoName(ctx.pid)}/collaborators/${actor.giteaUser}`,
      "PUT",
      { permission: "read" },
    );
  } catch (err) {
    logger.warn(`[projects] Gitea access grant failed:`, { err });
  }
}

async function joinProject(ctx: ProjectCtx, res: Response): Promise<void> {
  const memberRef = await joinMemberRef(ctx, res);
  if (!memberRef) return;

  const actor = await readProjectActor(ctx.uid);
  if (!(await ensureProjectJoinerTeamMember(ctx, actor, res))) return;

  await writeProjectJoin(ctx, memberRef);
  const channels = await readProjectChannels(ctx.projectRef);
  await addMattermostChannelMember(channels, actor.mmUserId);
  await addActivityChannelMember(channels, actor.mmUserId);
  await grantProjectGiteaAccess(ctx, actor);

  logger.info(`[projects] ${ctx.uid} joined ${ctx.wid}/${ctx.pid}`);
  res.json({ success: true });
}

router.post("/:wid/:pid/join", strictRateLimit, async (req: Request, res: Response) => {
  const { wid, pid } = req.params as { wid: string; pid: string };
  await withProject(req, res, wid, pid, {
    logTag: "[projects] Join failed for",
    errorMessage: "Failed to join project",
  }, async (ctx) => joinProject(ctx, res));
});

async function leaveMemberRef(
  ctx: ProjectCtx,
  res: Response,
): Promise<FirebaseFirestore.DocumentReference | null> {
  if (ctx.project.ownerUid === ctx.uid) {
    res.status(400).json({ error: "You cannot leave your own project" });
    return null;
  }

  const memberRef = ctx.projectRef.collection("members").doc(ctx.uid);
  const memberDoc = await memberRef.get();
  if (!memberDoc.exists) {
    res.json({ success: true, notAMember: true });
    return null;
  }

  return memberRef;
}

async function writeProjectLeave(
  ctx: ProjectCtx,
  memberRef: FirebaseFirestore.DocumentReference,
): Promise<void> {
  await memberRef.delete();
  await ctx.projectRef.update({
    memberCount: FieldValue.increment(-1),
    updatedAt: FieldValue.serverTimestamp(),
  });
}

async function removeMattermostChannelMember(channels: ProjectChannels, mmUserId: string | undefined): Promise<void> {
  if (!channels.mmChannelId || !mmUserId) return;
  try {
    await mmApi(`/channels/${channels.mmChannelId}/members/${mmUserId}`, "DELETE");
  } catch (err) {
    if (!errorIncludes(err, "404")) {
      logger.warn(`[projects] MM channel leave failed:`, { err });
    }
  }
}

async function removeActivityChannelMember(channels: ProjectChannels, mmUserId: string | undefined): Promise<void> {
  if (!channels.activityChannelId || !mmUserId) return;
  try {
    const { syncActivityMembershipRemove } = await import("../../lib/activityPair.js");
    await syncActivityMembershipRemove(channels.activityChannelId, mmUserId);
  } catch (err) {
    logger.warn(`[projects] activity-channel leave failed:`, { err });
  }
}

async function revokeProjectGiteaAccess(ctx: ProjectCtx, actor: ProjectActor): Promise<void> {
  if (!ctx.project.giteaRepoName || !actor.giteaUser) return;
  try {
    await giteaApi(
      workspaceGiteaOrg(ctx.wid),
      `${projectRepoName(ctx.pid)}/collaborators/${actor.giteaUser}`,
      "DELETE",
    );
  } catch (err) {
    logger.warn(`[projects] Gitea leave failed:`, { err });
  }
}

async function leaveProject(ctx: ProjectCtx, res: Response): Promise<void> {
  const memberRef = await leaveMemberRef(ctx, res);
  if (!memberRef) return;

  await writeProjectLeave(ctx, memberRef);
  const actor = await readProjectActor(ctx.uid);
  const channels = await readProjectChannels(ctx.projectRef);
  await removeMattermostChannelMember(channels, actor.mmUserId);
  await removeActivityChannelMember(channels, actor.mmUserId);
  await revokeProjectGiteaAccess(ctx, actor);

  logger.info(`[projects] ${ctx.uid} left ${ctx.wid}/${ctx.pid}`);
  res.json({ success: true });
}

router.post("/:wid/:pid/leave", strictRateLimit, async (req: Request, res: Response) => {
  const { wid, pid } = req.params as { wid: string; pid: string };
  await withProject(req, res, wid, pid, {
    logTag: "[projects] Leave failed for",
    errorMessage: "Failed to leave project",
  }, async (ctx) => leaveProject(ctx, res));
});

export default router;
