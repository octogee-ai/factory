import { Router, type NextFunction, type Request, type Response } from "express";
import rateLimit from "express-rate-limit";
import { parseAgentModelSelections } from "@octogee/shared/types/agent-models";
import { projectAgentId, workspaceCoachAgentId } from "@octogee/shared/types/identity";
import {
  channelSessionModelCommand,
  parseChannelSessionModelOperation,
} from "@octogee/shared/types/channel-session-models";
import {
  ChannelSessionMattermostError,
  createChannelSessionMattermostClient,
  parseNativeModelResult,
  pickCorrelatedAgentReply,
  type MattermostModelPost,
} from "../lib/channel-session-model-control.js";
import { db, FieldValue } from "../lib/db.js";
import { resolveWorkspaceUid } from "../lib/workspace-resolution.js";
import { requireAuth } from "../middleware/auth.js";
import { logger } from "../middleware/logging.js";

const router = Router();
const MATTERMOST_ID = /^[a-z0-9]{26}$/;
const channelSessionModelRateLimit = rateLimit({
  windowMs: 60_000,
  limit: 30,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  keyGenerator: (req) => req.uid!,
  message: { error: "Too many model control requests, please try again later." },
});

interface ChannelTarget {
  ownerUid: string;
  workspaceSlug: string;
  projectId?: string;
  agentId: string;
  agentMmUserId: string;
}

function pathScope(path: string): { workspaceSlug: string; projectId?: string } | null {
  const parts = path.split("/");
  if (parts.length === 4 && parts[0] === "workspaces" && parts[2] === "channels") {
    return { workspaceSlug: parts[1] };
  }
  if (parts.length === 6 && parts[0] === "workspaces" && parts[2] === "projects" && parts[4] === "channels") {
    return { workspaceSlug: parts[1], projectId: parts[3] };
  }
  return null;
}

async function resolveTarget(channelId: string): Promise<ChannelTarget | null> {
  const channels = await db.collectionGroup("channels").where("mattermost.channelId", "==", channelId).get();
  if (channels.docs.length !== 1) return null;
  const scope = pathScope(channels.docs[0].ref.path);
  if (!scope) return null;
  const ownerUid = await resolveWorkspaceUid(scope.workspaceSlug);
  if (!ownerUid) return null;

  if (scope.projectId) {
    const [project, secret] = await Promise.all([
      db.doc(`workspaces/${scope.workspaceSlug}/projects/${scope.projectId}`).get(),
      db.doc(`users/${ownerUid}/secrets/projectAgentMattermost-${scope.projectId}`).get(),
    ]);
    const projectCredential = secret.data();
    if (
      project.data()?.agent?.enabled === true &&
      typeof projectCredential?.mmUserId === "string" &&
      MATTERMOST_ID.test(projectCredential.mmUserId) &&
      typeof projectCredential.personalToken === "string" &&
      projectCredential.personalToken.length > 0
    ) {
      return {
        ...scope,
        ownerUid,
        agentId: projectAgentId(scope.workspaceSlug, scope.projectId),
        agentMmUserId: projectCredential.mmUserId,
      };
    }
  }

  const coachSecret = await db.doc(`users/${ownerUid}/secrets/coachMattermost`).get();
  const agentMmUserId = coachSecret.data()?.coachMmUserId;
  return typeof agentMmUserId === "string" && MATTERMOST_ID.test(agentMmUserId)
    ? { ...scope, ownerUid, agentId: workspaceCoachAgentId(scope.workspaceSlug), agentMmUserId }
    : null;
}

async function callerCredentials(uid: string): Promise<{ storedUserId: string; token: string } | null> {
  const [user, secret] = await Promise.all([
    db.doc(`users/${uid}`).get(),
    db.doc(`users/${uid}/secrets/mattermost`).get(),
  ]);
  const storedUserId = user.data()?.mattermost?.userId;
  const token = secret.data()?.personalToken;
  return typeof storedUserId === "string" && MATTERMOST_ID.test(storedUserId) && typeof token === "string"
    ? { storedUserId, token }
    : null;
}

function asPost(value: unknown): MattermostModelPost | null {
  if (!value || typeof value !== "object") return null;
  const post = value as Partial<MattermostModelPost>;
  return typeof post.id === "string" && MATTERMOST_ID.test(post.id) &&
    typeof post.root_id === "string" &&
    typeof post.channel_id === "string" && MATTERMOST_ID.test(post.channel_id) &&
    typeof post.user_id === "string" && MATTERMOST_ID.test(post.user_id) &&
    typeof post.create_at === "number" && Number.isSafeInteger(post.create_at) &&
    typeof post.message === "string"
    ? post as MattermostModelPost
    : null;
}

function threadPosts(value: unknown): MattermostModelPost[] {
  const posts = (value as { posts?: unknown } | null)?.posts;
  if (!posts || typeof posts !== "object" || Array.isArray(posts)) return [];
  return Object.values(posts).flatMap((post) => {
    const parsed = asPost(post);
    return parsed ? [parsed] : [];
  });
}

async function authorizeChannel(uid: string, channelId: string) {
  const [target, credentials] = await Promise.all([resolveTarget(channelId), callerCredentials(uid)]);
  if (!target || !credentials) return null;
  const client = createChannelSessionMattermostClient({
    baseUrl: process.env.MM_INTERNAL_URL ?? "",
    token: credentials.token,
  });
  const liveUserId = await client.getCurrentUserId();
  if (liveUserId !== credentials.storedUserId) return { forbidden: true as const };
  try {
    await client.getJson(["channels", channelId, "members", liveUserId]);
  } catch (error) {
    if (error instanceof ChannelSessionMattermostError && (error.status === 403 || error.status === 404)) {
      return { forbidden: true as const };
    }
    throw error;
  }
  return { forbidden: false as const, target, client, callerMmUserId: liveUserId };
}

function channelIdParam(req: Request): string | null {
  const channelId = typeof req.params.channelId === "string" ? req.params.channelId : "";
  return MATTERMOST_ID.test(channelId) ? channelId : null;
}

function handleRouteError(error: unknown, res: Response, next: NextFunction): void {
  if (error instanceof ChannelSessionMattermostError) {
    res.status(502).json({ error: "Chat model control unavailable" });
    return;
  }
  if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
    res.status(504).json({ error: "Chat model control timed out" });
    return;
  }
  if (error instanceof Error && error.message === "invalid Mattermost internal base URL") {
    res.status(503).json({ error: "Chat model control misconfigured" });
    return;
  }
  next(error);
}

router.get("/:channelId", requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const channelId = channelIdParam(req);
    if (!channelId) { res.status(400).json({ error: "Invalid channel ID" }); return; }
    const authorization = await authorizeChannel(req.uid!, channelId);
    if (!authorization) { res.status(404).json({ error: "Channel model controls unavailable" }); return; }
    if (authorization.forbidden) { res.status(403).json({ error: "Channel access denied" }); return; }
    const config = await db.doc(`users/${authorization.target.ownerUid}/system/config`).get();
    res.json({
      channelId,
      agentId: authorization.target.agentId,
      workspaceSlug: authorization.target.workspaceSlug,
      ...(authorization.target.projectId ? { projectId: authorization.target.projectId } : {}),
      defaultModel: parseAgentModelSelections(config.data()?.agentModels)[authorization.target.agentId] ?? null,
    });
  } catch (error) { handleRouteError(error, res, next); }
});

router.post("/:channelId", requireAuth, channelSessionModelRateLimit, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const channelId = channelIdParam(req);
    if (!channelId) { res.status(400).json({ error: "Invalid channel ID" }); return; }
    const operation = parseChannelSessionModelOperation(req.body);
    if (!operation) { res.status(400).json({ error: "Invalid model operation" }); return; }
    const authorization = await authorizeChannel(req.uid!, channelId);
    if (!authorization) { res.status(404).json({ error: "Channel model controls unavailable" }); return; }
    if (authorization.forbidden) { res.status(403).json({ error: "Channel access denied" }); return; }
    if (operation.agentId !== authorization.target.agentId) {
      res.status(409).json({ error: "The channel Agent changed; refresh settings" });
      return;
    }

    const audit = db.collection("channelSessionModelAudit").doc();
    await audit.set({
      actorUid: req.uid,
      channelId,
      workspaceSlug: authorization.target.workspaceSlug,
      ...(authorization.target.projectId ? { projectId: authorization.target.projectId } : {}),
      agentId: authorization.target.agentId,
      operation: operation.operation,
      ...(operation.operation === "setSessionModel" ? { requestedModel: operation.modelRef } : {}),
      outcome: "pending",
      createdAt: FieldValue.serverTimestamp(),
    });

    let posted: MattermostModelPost;
    let reply: MattermostModelPost | null = null;
    try {
      const commandPost = asPost(await authorization.client.postJson(["posts"], {
        channel_id: channelId,
        message: channelSessionModelCommand(operation),
      }));
      if (
        !commandPost ||
        commandPost.channel_id !== channelId ||
        commandPost.user_id !== authorization.callerMmUserId
      ) {
        throw new ChannelSessionMattermostError("Mattermost command post response was invalid");
      }
      posted = commandPost;

      for (let attempt = 0; attempt < 20 && !reply; attempt += 1) {
        if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 250));
        const thread = await authorization.client.getJson(["posts", posted.id, "thread"]);
        reply = pickCorrelatedAgentReply(threadPosts(thread), {
          rootPostId: posted.id,
          channelId,
          agentUserId: authorization.target.agentMmUserId,
          commandCreatedAt: posted.create_at,
        });
      }
    } catch (error) {
      try {
        await audit.update({ outcome: "failed", completedAt: FieldValue.serverTimestamp() });
      } catch (auditError) {
        logger.error("channel session model audit failure update failed", {
          auditId: audit.id,
          channelId,
          operation: operation.operation,
          error: auditError instanceof Error ? auditError.message : String(auditError),
        });
      }
      logger.error("channel session model command failed", {
        auditId: audit.id,
        channelId,
        operation: operation.operation,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }

    const nativeMessage = reply?.message.slice(0, 8192) ?? "No correlated Agent reply was received.";
    const parsed = reply
      ? parseNativeModelResult(operation.operation, nativeMessage)
      : { outcome: "unknown" as const };
    try {
      await audit.update({
        commandPostId: posted.id,
        ...(reply ? { replyPostId: reply.id } : {}),
        outcome: parsed.outcome,
        ...(parsed.currentModel ? { resultingModel: parsed.currentModel } : {}),
        completedAt: FieldValue.serverTimestamp(),
      });
    } catch (error) {
      logger.error("channel session model audit completion failed", {
        auditId: audit.id,
        channelId,
        operation: operation.operation,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    res.json({
      ...parsed,
      nativeMessage,
      commandPostId: posted.id,
      ...(reply ? { replyPostId: reply.id } : {}),
    });
  } catch (error) { handleRouteError(error, res, next); }
});

export default router;
