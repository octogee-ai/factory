import { Router, Request, Response } from "express";
import { strictRateLimit } from "../../middleware/security.js";
import { db, FieldValue } from "../../lib/db.js";
import { mmApi } from "../../lib/mattermost.js";
import { giteaApi } from "../../lib/gitea.js";
import { workspaceGiteaOrg, projectRepoName } from "../../lib/gitea-naming.js";
import { logger } from "../../middleware/logging.js";
import { getWorkspaceMmContext } from "../../lib/mattermost-context.js";
import { withProject, type ProjectCtx } from "../../lib/withProject.js";

const router = Router();

interface ProjectActor {
  mmUserId: string | undefined;
  giteaUser: string | null;
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
  if (!teamId || !actor.mmUserId) {
    res.status(422).json({ error: "Project chat membership is not provisioned" });
    return false;
  }
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

  const { addActivityPairMember } = await import("../../lib/activityPair.js");
  await addActivityPairMember(`${ctx.projectRef.path}/channels/general`, actor.mmUserId!);
  await writeProjectJoin(ctx, memberRef);
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

  const actor = await readProjectActor(ctx.uid);
  if (actor.mmUserId) {
    const { removeActivityPairMember } = await import("../../lib/activityPair.js");
    await removeActivityPairMember(`${ctx.projectRef.path}/channels/general`, actor.mmUserId);
  }
  await writeProjectLeave(ctx, memberRef);
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
