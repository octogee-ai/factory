import { Router, Request, Response } from "express";
import { strictRateLimit } from "../../middleware/security.js";
import { db, FieldValue } from "../../lib/db.js";
import { mmApi } from "../../lib/mattermost.js";
import { logger } from "../../middleware/logging.js";
import { projectGeneralChannelName } from "@shared/types/identity.js";
import { getWorkspaceMmContext } from "../../lib/mattermost-context.js";
import { withProject, type ProjectCtx } from "../../lib/withProject.js";
import { provisionProjectRepo } from "./provisioning.js";
import { projectRepoName } from "../../lib/gitea-naming.js";

const router = Router();

type WorkspaceMmContext = NonNullable<Awaited<ReturnType<typeof getWorkspaceMmContext>>>;
type RetryMattermostContext = WorkspaceMmContext & { teamId: string };

interface RetryMember {
  id: string | null;
  label: string;
}

interface RetryActivityInput {
  ctx: ProjectCtx;
  res: Response;
  teamId: string;
  channelName: string;
  mmChannelId: string;
  members: RetryMember[];
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function markRetryFailed(projectRef: FirebaseFirestore.DocumentReference, provisioningError: string): Promise<void> {
  await projectRef.update({
    provisioningState: "failed",
    provisioningError: provisioningError.slice(0, 500),
    updatedAt: FieldValue.serverTimestamp(),
  });
}

async function retryMattermostContext(ctx: ProjectCtx, res: Response): Promise<RetryMattermostContext | null> {
  const userDoc = await db.doc(`users/${ctx.uid}`).get();
  const callerCtx = await getWorkspaceMmContext(ctx.uid, ctx.wid, userDoc.data());
  if (callerCtx?.teamId) return { ...callerCtx, teamId: callerCtx.teamId };
  await markRetryFailed(ctx.projectRef, "Workspace has no Mattermost team context");
  res.status(502).json({ error: "Retry failed — workspace chat is not ready" });
  return null;
}

async function lookupRetryChannel(
  teamId: string,
  channelName: string,
): Promise<{ id?: string; type?: string } | null> {
  try {
    return (await mmApi(`/teams/${teamId}/channels/name/${channelName}`)) as { id?: string; type?: string } | null;
  } catch (lookupErr) {
    if ((lookupErr as { status?: number } | null)?.status !== 404) throw lookupErr;
    return null;
  }
}

async function createRetryChannel(teamId: string, channelName: string, displayName: string): Promise<string> {
  const channel = (await mmApi("/channels", "POST", {
    team_id: teamId,
    name: channelName,
    display_name: displayName,
    type: "P",
  })) as { id?: string };
  if (!channel?.id) throw new Error("MM returned no channel id");
  return channel.id;
}

async function ensureRetryChannel(ctx: ProjectCtx, teamId: string, channelName: string): Promise<string> {
  const existing = await lookupRetryChannel(teamId, channelName);
  if (existing?.id) {
    if (existing.type === "O") {
      await mmApi(`/channels/${existing.id}/privacy`, "PUT", { privacy: "P" });
    }
    return existing.id;
  }
  return createRetryChannel(teamId, channelName, ctx.project.name || ctx.pid);
}

async function retryChannelId(
  ctx: ProjectCtx,
  res: Response,
  teamId: string,
  channelName: string,
): Promise<string | null> {
  try {
    return await ensureRetryChannel(ctx, teamId, channelName);
  } catch (err) {
    const message = errorMessage(err);
    await markRetryFailed(ctx.projectRef, message);
    logger.error(`[projects] Retry provisioning failed for ${ctx.wid}/${ctx.pid}:`, { err });
    res.status(502).json({ error: "Retry failed — could not create chat channel" });
    return null;
  }
}

function retryMembers(callerCtx: RetryMattermostContext): RetryMember[] {
  return [
    { id: callerCtx.userId, label: "owner" },
    { id: callerCtx.coachUserId, label: "agent" },
  ];
}

async function addRetryMembers(mmChannelId: string, members: RetryMember[]): Promise<string | null> {
  for (const member of members) {
    if (!member.id) return `${member.label} has no Mattermost userId — provisioning incomplete`;
    try {
      await mmApi(`/channels/${mmChannelId}/members`, "POST", { user_id: member.id });
    } catch (err) {
      return `Add ${member.label} ${member.id} failed: ${errorMessage(err)}`;
    }
  }
  return null;
}

async function addRetryMembersOrFail(
  ctx: ProjectCtx,
  res: Response,
  mmChannelId: string,
  members: RetryMember[],
): Promise<boolean> {
  const memberFailure = await addRetryMembers(mmChannelId, members);
  if (!memberFailure) return true;
  await markRetryFailed(ctx.projectRef, memberFailure);
  logger.error(`[projects] Retry membership failed for ${ctx.wid}/${ctx.pid}: ${memberFailure}`);
  res.status(502).json({ error: "Retry failed — could not add channel members" });
  return false;
}

async function provisionRetryActivity(
  ctx: ProjectCtx,
  teamId: string,
  channelName: string,
  mmChannelId: string,
  members: RetryMember[],
): Promise<void> {
  const { provisionActivityPair } = await import("../../lib/activityPair.js");
  await provisionActivityPair({
    primaryName: channelName,
    primaryChannelId: mmChannelId,
    teamId,
    type: "P",
    kind: "project",
    members: members.map((member) => member.id),
    recordActivityChannelId: async (activityChannelId) => {
      await ctx.projectRef
        .collection("channels")
        .doc("general")
        .set({ mattermost: { activityChannelId } }, { merge: true });
    },
  });
}

async function provisionRetryActivityOrFail(input: RetryActivityInput): Promise<boolean> {
  try {
    await provisionRetryActivity(input.ctx, input.teamId, input.channelName, input.mmChannelId, input.members);
    return true;
  } catch (err) {
    const message = errorMessage(err);
    await markRetryFailed(input.ctx.projectRef, message);
    logger.error(`[projects] Retry activity-pair failed for ${input.ctx.wid}/${input.ctx.pid}: ${message}`);
    input.res.status(502).json({ error: "Retry failed — could not provision activity channel" });
    return false;
  }
}

async function writeRetryGeneralChannel(ctx: ProjectCtx, mmChannelId: string): Promise<void> {
  await ctx.projectRef.collection("channels").doc("general").set({
    id: "general",
    kind: "general",
    name: "general",
    mattermost: { channelId: mmChannelId },
    createdAt: FieldValue.serverTimestamp(),
  }, { merge: true });
}

function restoredVisibility(ctx: ProjectCtx): string {
  return typeof ctx.project.pendingVisibility === "string"
    ? ctx.project.pendingVisibility
    : ctx.project.visibility;
}

async function reconcileRetryRepoOrFail(ctx: ProjectCtx, res: Response, visibility: string): Promise<boolean> {
  const repoErr = await provisionProjectRepo({
    workspaceId: ctx.wid,
    slug: ctx.pid,
    name: ctx.project.name || ctx.pid,
    tagline: typeof ctx.project.tagline === "string" ? ctx.project.tagline : "",
    projectType: typeof ctx.project.projectType === "string" ? ctx.project.projectType : null,
    visibility,
  });
  if (!repoErr) return true;
  await markRetryFailed(ctx.projectRef, repoErr);
  logger.error(`[projects] Gitea reconcile failed for ${ctx.wid}/${ctx.pid}: ${repoErr}`);
  res.status(502).json({ error: "Retry failed — could not reconcile code repo" });
  return false;
}

async function activateRetriedProject(ctx: ProjectCtx, visibility: string): Promise<void> {
  await ctx.projectRef.update({
    provisioningState: "active",
    provisioningError: null,
    visibility,
    pendingVisibility: null,
    giteaRepoName: ctx.project.giteaRepoName || projectRepoName(ctx.pid),
    updatedAt: FieldValue.serverTimestamp(),
  });
}

async function retryProjectProvisioning(ctx: ProjectCtx, res: Response): Promise<void> {
  const callerCtx = await retryMattermostContext(ctx, res);
  if (!callerCtx) return;

  const channelName = projectGeneralChannelName(ctx.wid, ctx.pid);
  const mmChannelId = await retryChannelId(ctx, res, callerCtx.teamId, channelName);
  if (!mmChannelId) return;

  const members = retryMembers(callerCtx);
  if (!(await addRetryMembersOrFail(ctx, res, mmChannelId, members))) return;
  if (!(await provisionRetryActivityOrFail({
    ctx,
    res,
    teamId: callerCtx.teamId,
    channelName,
    mmChannelId,
    members,
  }))) return;

  await writeRetryGeneralChannel(ctx, mmChannelId);
  const visibility = restoredVisibility(ctx);
  if (!(await reconcileRetryRepoOrFail(ctx, res, visibility))) return;
  await activateRetriedProject(ctx, visibility);

  logger.info(`[projects] Retry provisioning succeeded for ${ctx.wid}/${ctx.pid}`);
  res.json({ success: true, channelId: mmChannelId });
}

router.post("/:wid/:pid/retry-provisioning", strictRateLimit, async (req: Request, res: Response) => {
  const { wid, pid } = req.params as { wid: string; pid: string };
  await withProject(req, res, wid, pid, {
    ownerOnly: true,
    ownerErrorMessage: "Only the project owner can retry provisioning",
    logTag: "[projects] Retry provisioning crashed for",
    errorMessage: "Retry provisioning failed",
  }, async (ctx) => retryProjectProvisioning(ctx, res));
});

export default router;
