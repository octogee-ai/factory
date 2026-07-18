import { Router, type NextFunction, type Request, type Response } from "express";
import { parseChannelSessionModelOperation, channelSessionModelCommand } from "@octogee/shared/types/channel-session-models";
import { parseAgentModelSelections } from "@octogee/shared/types/agent-models";
import { db, FieldValue } from "../lib/db.js";
import { requireAuth } from "../middleware/auth.js";
import { resolveWorkspaceUid } from "../lib/workspace-resolution.js";

const router = Router();
const mmBase = process.env.MM_INTERNAL_URL || "";
const MATTERMOST_ID = /^[a-z0-9]{26}$/;

function pathScope(path: string): { ownerUid: string; workspaceSlug: string; projectId?: string } | null {
  const parts = path.split("/");
  if (parts.length === 4 && parts[0] === "workspaces" && parts[2] === "channels") return { ownerUid: "", workspaceSlug: parts[1] };
  if (parts.length === 6 && parts[0] === "workspaces" && parts[2] === "projects" && parts[4] === "channels") return { ownerUid: "", workspaceSlug: parts[1], projectId: parts[3] };
  return null;
}

async function resolveTarget(channelId: string) {
  const channels = await db.collectionGroup("channels").where("mattermost.channelId", "==", channelId).get();
  if (channels.docs.length !== 1) return null;
  const scope = pathScope(channels.docs[0].ref.path);
  if (!scope) return null;
  const ownerUid = await resolveWorkspaceUid(scope.workspaceSlug);
  if (!ownerUid) return null;
  if (scope.projectId) {
    const project = await db.doc(`workspaces/${scope.workspaceSlug}/projects/${scope.projectId}`).get();
    const secret = await db.doc(`users/${ownerUid}/secrets/projectAgentMattermost-${scope.projectId}`).get();
    if (project.data()?.agent?.enabled === true && typeof secret.data()?.mmUserId === "string") {
      return { ...scope, ownerUid, agentId: `octogee-${scope.workspaceSlug}-proj-${scope.projectId}-coach`, agentMmUserId: secret.data()!.mmUserId as string };
    }
  }
  const coachSecret = await db.doc(`users/${ownerUid}/secrets/coachMattermost`).get();
  const agentMmUserId = coachSecret.data()?.coachMmUserId;
  return typeof agentMmUserId === "string" ? { ...scope, ownerUid, agentId: `octogee-${scope.workspaceSlug}-coach`, agentMmUserId } : null;
}

async function callerCredentials(uid: string) {
  const [user, secret] = await Promise.all([db.doc(`users/${uid}`).get(), db.doc(`users/${uid}/secrets/mattermost`).get()]);
  const userId = user.data()?.mattermost?.userId;
  const token = secret.data()?.personalToken;
  return typeof userId === "string" && typeof token === "string" ? { userId, token } : null;
}

async function mm(token: string, path: string, init?: RequestInit): Promise<any> {
  const response = await fetch(`${mmBase}/api/v4${path}`, { ...init, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" } });
  if (!response.ok) throw new Error(`Mattermost HTTP ${response.status}`);
  return response.json();
}

router.get("/:channelId", requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const channelId = String(req.params.channelId);
    if (!MATTERMOST_ID.test(channelId)) { res.status(400).json({ error: "Invalid channel ID" }); return; }
    const target = await resolveTarget(channelId);
    const creds = await callerCredentials(req.uid!);
    if (!target || !creds) { res.status(404).json({ error: "Channel model controls unavailable" }); return; }
    await mm(creds.token, `/channels/${req.params.channelId}/members/${creds.userId}`);
    const config = await db.doc(`users/${target.ownerUid}/system/config`).get();
    res.json({ channelId: req.params.channelId, agentId: target.agentId, workspaceSlug: target.workspaceSlug, ...(target.projectId ? { projectId: target.projectId } : {}), defaultModel: parseAgentModelSelections(config.data()?.agentModels)[target.agentId] ?? null });
  } catch (error) { next(error); }
});

router.post("/:channelId", requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const channelId = String(req.params.channelId);
    if (!MATTERMOST_ID.test(channelId)) { res.status(400).json({ error: "Invalid channel ID" }); return; }
    const operation = parseChannelSessionModelOperation(req.body);
    if (!operation) { res.status(400).json({ error: "Invalid model operation" }); return; }
    const target = await resolveTarget(channelId);
    const creds = await callerCredentials(req.uid!);
    if (!target || !creds || operation.agentId !== target.agentId) { res.status(403).json({ error: "Channel Agent changed or access denied" }); return; }
    await mm(creds.token, `/channels/${req.params.channelId}/members/${creds.userId}`);
    const post = await mm(creds.token, "/posts", { method: "POST", body: JSON.stringify({ channel_id: req.params.channelId, message: channelSessionModelCommand(operation) }) });
    let reply: any = null;
    for (let attempt = 0; attempt < 20 && !reply; attempt++) {
      if (attempt) await new Promise((resolve) => setTimeout(resolve, 250));
      const thread = await mm(creds.token, `/posts/${post.id}/thread`);
      reply = Object.values(thread.posts ?? {}).find((candidate: any) => candidate.id !== post.id && candidate.root_id === post.id && candidate.channel_id === req.params.channelId && candidate.user_id === target.agentMmUserId && candidate.create_at >= post.create_at);
    }
    const nativeMessage = typeof reply?.message === "string" ? reply.message.slice(0, 8192) : "No correlated Agent reply was received.";
    const outcome = !reply ? "unknown" : /not allowed|unknown provider|unavailable|error/i.test(nativeMessage) ? "rejected" : /Model (?:set|reset)/i.test(nativeMessage) ? "applied" : "unknown";
    await db.collection("channelSessionModelAudit").add({ actorUid: req.uid, channelId: req.params.channelId, workspaceSlug: target.workspaceSlug, ...(target.projectId ? { projectId: target.projectId } : {}), agentId: target.agentId, operation: operation.operation, ...(operation.operation === "setSessionModel" ? { requestedModel: operation.modelRef } : {}), commandPostId: post.id, ...(reply?.id ? { replyPostId: reply.id } : {}), outcome, createdAt: FieldValue.serverTimestamp() });
    res.json({ outcome, nativeMessage, commandPostId: post.id, ...(reply?.id ? { replyPostId: reply.id } : {}) });
  } catch (error) { next(error); }
});

export default router;
