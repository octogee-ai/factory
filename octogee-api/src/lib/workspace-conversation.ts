import type { Firestore } from "firebase-admin/firestore";
import { gatewayAuthorizationFromRootDocument } from "@octogee/core/gateway-live-release";
import { userAssignmentMatchesGateway } from "@octogee/core/assigned-roster";
import { isCanonicalWorkspaceMembership, workspacePermissionsEnabled } from "@octogee/core/gateway-principal-access";
import { VOICE_TURN_POST_KIND, voiceTurnMessage, type VoiceTurnPost, type VoiceTurnRequest } from "@octogee/core/voice-conversation";
import { accountAllowsInteractiveAccess } from "@octogee/shared/types/account-lifecycle";
import { isValidGatewayId, resolveGatewayClass } from "@octogee/shared/types/glm";
import type { DocumentReader } from "../../../gateway-edge/src/routes/builder/gateways.js";

export interface WorkspaceConversationDeps {
  db: Firestore;
  authorize?: typeof import("../../../gateway-edge/src/lib/channel-session-authorization.js").authorizeChannelCredentials;
  readChannel?: (token: string, channelId: string) => Promise<unknown>;
  createPost?: (token: string, body: Record<string, unknown>) => Promise<unknown>;
}
export interface WorkspaceConversationScopeClaim { uid: string; workspaceSlug: string; ownerUid: string; gatewayId?: string }
export class VoiceTurnPostError extends Error {
  constructor(message: string) { super(message); this.name = "VoiceTurnPostError"; }
}
const MATTERMOST_ID_RE = /^[a-z0-9]{26}$/u;
function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
function validScopeClaim(claim: WorkspaceConversationScopeClaim): boolean {
  return [claim.uid, claim.ownerUid].every(id => typeof id === "string" && id.length > 0 && id.length <= 128 && !id.includes("/")) &&
    typeof claim.workspaceSlug === "string" && /^[a-z0-9-]{1,64}$/u.test(claim.workspaceSlug);
}
async function workspacePrincipal(get: DocumentReader, { uid, workspaceSlug, ownerUid }: WorkspaceConversationScopeClaim) {
  const [workspace, owner, caller, membership] = await Promise.all([
    get(`workspaces/${workspaceSlug}`), get(`users/${ownerUid}`), get(`users/${uid}`), get(`workspaces/${workspaceSlug}/members/${uid}`),
  ]);
  const ownerData = record(owner.data());
  const callerData = record(caller.data());
  if (!workspace.exists || record(workspace.data())?.ownerUid !== ownerUid || !owner.exists || !caller.exists || !ownerData || !callerData) return null;
  if (!accountAllowsInteractiveAccess(ownerData) || !accountAllowsInteractiveAccess(callerData)) return null;
  if (uid !== ownerUid && !isCanonicalWorkspaceMembership(membership.data())) return null;
  return ownerData;
}
function assignedGateway(ownerData: Record<string, unknown>, claim: WorkspaceConversationScopeClaim): string | null {
  const gatewayId = record(record(ownerData.provisioning)?.openclaw)?.gatewayId;
  if (!isValidGatewayId(gatewayId) || (claim.gatewayId !== undefined && gatewayId !== claim.gatewayId) ||
    !userAssignmentMatchesGateway(ownerData, gatewayId, claim.workspaceSlug)) return null;
  return gatewayId;
}
export async function resolveWorkspaceConversationScope(get: DocumentReader, claim: WorkspaceConversationScopeClaim) {
  if (!validScopeClaim(claim)) return null;
  const ownerData = await workspacePrincipal(get, claim);
  if (!ownerData) return null;
  const gatewayId = assignedGateway(ownerData, claim);
  if (!gatewayId) return null;
  const root = await get(`gateways/${gatewayId}`);
  const auth = root.exists ? gatewayAuthorizationFromRootDocument(root.data(), gatewayId) : null;
  if (!auth || auth.gateway.desiredStatus !== "running") return null;
  const gatewayClass = resolveGatewayClass({ gatewayClass: auth.config.gatewayClass, profile: auth.config.profile ?? undefined, imageProfile: auth.config.imageProfile });
  const { uid, ownerUid, workspaceSlug } = claim;
  if (gatewayClass !== "shared" && (auth.config.ownerUid !== ownerUid || auth.config.builderSlug !== workspaceSlug)) return null;
  return { uid, ownerUid, workspaceSlug, gatewayId, auth, gatewayClass, nativeAccess: workspacePermissionsEnabled(auth.config, ownerData) };
}
async function mattermostClient(token: string) {
  const { createChannelSessionMattermostClient } = await import("../../../gateway-edge/src/lib/channel-session-model-control.js");
  return createChannelSessionMattermostClient({ baseUrl: process.env.MM_INTERNAL_URL ?? "", token });
}
async function readMattermostChannel(token: string, id: string): Promise<unknown> {
  return (await mattermostClient(token)).getJson(["channels", id]);
}
async function createMattermostPost(token: string, body: Record<string, unknown>): Promise<unknown> {
  return (await mattermostClient(token)).postJson(["posts"], body);
}
export async function resolveWorkspaceConversation(deps: WorkspaceConversationDeps, claim: { uid: string; channelId: string; gatewayId?: string }) {
  const authorize = deps.authorize ?? (await import("../../../gateway-edge/src/lib/channel-session-authorization.js")).authorizeChannelCredentials;
  const access = await authorize(claim.uid, claim.channelId, undefined, { workspaceConversation: true });
  if (!access || access.forbidden || access.target.projectId) return null;
  const { workspaceSlug, ownerUid, agentId } = access.target;
  if (agentId !== `octogee-${workspaceSlug}-coach`) return null;
  const scope = await resolveWorkspaceConversationScope(path => deps.db.doc(path).get(), { ...claim, workspaceSlug, ownerUid });
  if (!scope) return null;
  const channel = record(await (deps.readChannel ?? readMattermostChannel)(access.token, claim.channelId));
  if (!channel || channel.id !== claim.channelId || !["O", "P"].includes(String(channel.type)) || channel.delete_at !== 0) return null;
  const peerKind = channel.type === "P" ? "group" : "channel";
  return { scope, token: access.token, context: {
    uid: claim.uid, gatewayId: scope.gatewayId, workspaceSlug, channelId: claim.channelId, agentId,
    sessionKey: `agent:${agentId}:mattermost:${peerKind}:${claim.channelId}`,
    callerMmUserId: access.callerMmUserId,
  } };
}
export async function postWorkspaceVoiceTurn(deps: WorkspaceConversationDeps, request: VoiceTurnRequest): Promise<VoiceTurnPost | null> {
  const resolved = await resolveWorkspaceConversation(deps, { uid: request.uid, channelId: request.channelId, gatewayId: request.gatewayId });
  if (!resolved) return null;
  const props = {
    octogee: { kind: VOICE_TURN_POST_KIND, ...(request.turnId !== undefined ? { turnId: request.turnId } : {}) },
    ...(request.ingressToken !== undefined ? { openclaw_consult_ingress: request.ingressToken } : {}),
  };
  const post = record(await (deps.createPost ?? createMattermostPost)(resolved.token, { channel_id: request.channelId, message: voiceTurnMessage(request.text), props }));
  const { callerMmUserId } = resolved.context;
  if (!post || typeof post.id !== "string" || !MATTERMOST_ID_RE.test(post.id) || post.channel_id !== request.channelId || post.user_id !== callerMmUserId) {
    throw new VoiceTurnPostError("Mattermost attributed the voice turn to a different sender or conversation");
  }
  return { postId: post.id, channelId: request.channelId, userId: callerMmUserId };
}
