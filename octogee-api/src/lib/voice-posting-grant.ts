import { createHash, randomBytes } from 'node:crypto';
import { Timestamp, type DocumentReference, type Firestore } from 'firebase-admin/firestore';
import { VOICE_TURN_POST_KIND, voiceTurnMessage, type VoiceConversation, type VoiceGrantBinding, type VoiceGrantEndRequest, type VoiceGrantRequest, type VoiceTurnPost, type VoiceTurnRequest } from '@octogee/core/voice-conversation';
import { resolveWorkspaceConversation, type WorkspaceConversationDeps } from './workspace-conversation.js';

const PURPOSE = 'voice.turn.post';
const GRANT_TTL_MS = 30 * 60_000;
const MAX_TURNS = 256;
const MATTERMOST_ID = /^[a-z0-9]{26}$/u;
interface GrantIdentity { uid: string; gatewayId: string; workspaceSlug: string; ownerUid: string; channelId: string; agentId: string; sessionKey: string }
type TurnReceipt = { digest: string; state: 'pending' | 'failed' } | { digest: string; state: 'posted'; post: VoiceTurnPost };
interface GrantDocument extends GrantIdentity {
  purpose: typeof PURPOSE;
  createdAt: number;
  expiresAt: number;
  expireAt: Timestamp;
  revokedAt: number | null;
  sessionId: string | null;
  callerMmUserId: string | null;
  turns: Record<string, TurnReceipt>;
}
export class VoicePostingGrantError extends Error {
  constructor(readonly status: number, readonly code: string) { super(code); this.name = 'VoicePostingGrantError'; }
}
function deny(): never { throw new VoicePostingGrantError(403, 'voice_grant_forbidden'); }
function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
function boundedId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 128 && !value.includes('/');
}
function validIdentity(body: Partial<GrantIdentity>): boolean {
  return [body.uid, body.gatewayId, body.ownerUid].every(boundedId) && typeof body.workspaceSlug === 'string' && /^[a-z0-9-]{1,64}$/u.test(body.workspaceSlug) &&
    typeof body.channelId === 'string' && MATTERMOST_ID.test(body.channelId) && body.agentId === `octogee-${body.workspaceSlug}-coach` &&
    ['channel', 'group'].some(kind => body.sessionKey === `agent:${body.agentId}:mattermost:${kind}:${body.channelId}`);
}
function grantHash(voiceGrant: string): string {
  if (!/^[A-Za-z0-9_-]{43}$/u.test(voiceGrant)) deny();
  return createHash('sha256').update(voiceGrant).digest('hex');
}
function grantRef(db: Firestore, voiceGrant: string): DocumentReference {
  return db.doc(`gatewayTickets/${grantHash(voiceGrant)}`);
}
export function createVoicePostingGrant(identity: GrantIdentity, now = Date.now()) {
  if (!validIdentity(identity)) throw new Error('Voice grant identity is invalid');
  const voiceGrant = randomBytes(32).toString('base64url');
  const expiresAt = now + GRANT_TTL_MS;
  const document: GrantDocument = { ...identity, purpose: PURPOSE, createdAt: now, expiresAt, expireAt: Timestamp.fromMillis(expiresAt), revokedAt: null, sessionId: null, callerMmUserId: null, turns: {} };
  return { voiceGrant, voiceGrantExpiresAt: expiresAt, path: `gatewayTickets/${grantHash(voiceGrant)}`, document };
}
function validLifetime(body: Partial<GrantDocument>): boolean {
  return typeof body.createdAt === 'number' && Number.isFinite(body.createdAt) && body.createdAt <= Date.now() &&
    typeof body.expiresAt === 'number' && Number.isFinite(body.expiresAt) && body.expiresAt > body.createdAt && body.expiresAt <= body.createdAt + GRANT_TTL_MS;
}
function parseGrant(value: unknown, gatewayId: string): GrantDocument {
  const body = record(value) as Partial<GrantDocument> | null;
  if (!body || body.purpose !== PURPOSE || body.gatewayId !== gatewayId || !validIdentity(body)) deny();
  if (!validLifetime(body) || !record(body.turns)) deny();
  if (body.sessionId !== null && !boundedId(body.sessionId)) deny();
  if (body.callerMmUserId !== null && (typeof body.callerMmUserId !== 'string' || !MATTERMOST_ID.test(body.callerMmUserId))) deny();
  return body as GrantDocument;
}
function activeGrant(value: unknown, gatewayId: string): GrantDocument {
  const grant = parseGrant(value, gatewayId);
  if (grant.revokedAt !== null || grant.expiresAt <= Date.now()) deny();
  return grant;
}
function matchesResolved(grant: GrantDocument, resolved: NonNullable<Awaited<ReturnType<typeof resolveWorkspaceConversation>>>): boolean {
  const { context, scope } = resolved;
  return grant.uid === context.uid && grant.gatewayId === context.gatewayId && grant.workspaceSlug === context.workspaceSlug &&
    grant.ownerUid === scope.ownerUid && grant.channelId === context.channelId && grant.agentId === context.agentId && grant.sessionKey === context.sessionKey &&
    (grant.callerMmUserId === null || grant.callerMmUserId === context.callerMmUserId);
}
async function authorizeGrant(deps: WorkspaceConversationDeps, grant: GrantDocument) {
  const resolved = await resolveWorkspaceConversation(deps, grant);
  if (!resolved || !matchesResolved(grant, resolved)) deny();
  return resolved;
}
function grantBinding(context: VoiceConversation, grant: GrantDocument, sessionId: string): VoiceGrantBinding {
  return { ...context, sessionId, expiresAt: grant.expiresAt };
}
export async function bindWorkspaceVoiceGrant(deps: WorkspaceConversationDeps, gatewayId: string, request: VoiceGrantRequest): Promise<VoiceGrantBinding> {
  const ref = grantRef(deps.db, request.voiceGrant);
  const initial = activeGrant((await ref.get()).data(), gatewayId);
  if (initial.sessionId !== null && initial.sessionId !== request.sessionId) deny();
  const resolved = await authorizeGrant(deps, initial);
  const grant = await deps.db.runTransaction(async tx => {
    const current = activeGrant((await tx.get(ref)).data(), gatewayId);
    if (!matchesResolved(current, resolved) || (current.sessionId !== null && current.sessionId !== request.sessionId)) deny();
    tx.update(ref, { sessionId: request.sessionId, callerMmUserId: resolved.context.callerMmUserId });
    return current;
  });
  const { scope } = resolved;
  return grantBinding({ ...resolved.context, nativeInterrupt: scope.gatewayClass === 'builder' && scope.nativeAccess && scope.auth.config.builderAccess?.controlUiEnabled === true }, grant, request.sessionId);
}
export async function endWorkspaceVoiceGrant(deps: WorkspaceConversationDeps, gatewayId: string, request: VoiceGrantEndRequest): Promise<{ revoked: true }> {
  const ref = grantRef(deps.db, request.voiceGrant);
  await deps.db.runTransaction(async tx => {
    const current = parseGrant((await tx.get(ref)).data(), gatewayId);
    if (request.sessionId !== undefined && current.sessionId !== null && current.sessionId !== request.sessionId) deny();
    if (current.revokedAt === null) tx.update(ref, { revokedAt: Date.now() });
  });
  return { revoked: true };
}
function turnDigest(request: VoiceTurnRequest): string {
  return createHash('sha256').update(JSON.stringify([voiceTurnMessage(request.text), request.ingressToken ?? null])).digest('hex');
}
function replayTurn(turn: TurnReceipt, digest: string): VoiceTurnPost {
  if (turn.digest !== digest) throw new VoicePostingGrantError(409, 'voice_turn_conflict');
  if (turn.state === 'posted') return turn.post;
  if (turn.state === 'failed') throw new VoicePostingGrantError(502, 'voice_turn_failed');
  throw new VoicePostingGrantError(409, 'voice_turn_pending');
}
async function reserveTurn(deps: WorkspaceConversationDeps, gatewayId: string, request: VoiceTurnRequest, resolved: NonNullable<Awaited<ReturnType<typeof resolveWorkspaceConversation>>>, digest: string) {
  const ref = grantRef(deps.db, request.voiceGrant);
  return deps.db.runTransaction(async tx => {
    const grant = activeGrant((await tx.get(ref)).data(), gatewayId);
    if (grant.sessionId !== request.sessionId || !matchesResolved(grant, resolved)) deny();
    if (Object.hasOwn(grant.turns, request.turnId)) return replayTurn(grant.turns[request.turnId], digest);
    if (Object.keys(grant.turns).length >= MAX_TURNS) throw new VoicePostingGrantError(429, 'voice_turn_limit');
    tx.update(ref, { turns: { ...grant.turns, [request.turnId]: { state: 'pending', digest } } });
    return null;
  });
}
async function finishTurn(deps: WorkspaceConversationDeps, gatewayId: string, request: VoiceTurnRequest, receipt: TurnReceipt): Promise<void> {
  const ref = grantRef(deps.db, request.voiceGrant);
  await deps.db.runTransaction(async tx => {
    const grant = parseGrant((await tx.get(ref)).data(), gatewayId);
    const existing = grant.turns[request.turnId];
    if (!existing || existing.digest !== receipt.digest || existing.state !== 'pending') throw new Error('Voice turn reservation changed before delivery settled');
    tx.update(ref, { turns: { ...grant.turns, [request.turnId]: receipt } });
  });
}
async function createTurnPost(deps: WorkspaceConversationDeps, token: string, context: { channelId: string; callerMmUserId: string }, request: VoiceTurnRequest): Promise<VoiceTurnPost> {
  const createPost = deps.createPost ?? (async (credential, body) => {
    const { createChannelSessionMattermostClient } = await import('../../../gateway-edge/src/lib/channel-session-model-control.js');
    return createChannelSessionMattermostClient({ baseUrl: process.env.MM_INTERNAL_URL ?? '', token: credential }).postJson(['posts'], body);
  });
  const props = { octogee: { kind: VOICE_TURN_POST_KIND, turnId: request.turnId }, ...(request.ingressToken === undefined ? {} : { openclaw_consult_ingress: request.ingressToken }) };
  const post = record(await createPost(token, { channel_id: context.channelId, message: voiceTurnMessage(request.text), props }));
  if (!post || typeof post.id !== 'string' || !MATTERMOST_ID.test(post.id) || post.channel_id !== context.channelId || post.user_id !== context.callerMmUserId) throw new VoicePostingGrantError(502, 'voice_turn_unverified');
  return { postId: post.id, channelId: context.channelId, userId: context.callerMmUserId };
}
export async function postWorkspaceVoiceTurn(deps: WorkspaceConversationDeps, gatewayId: string, request: VoiceTurnRequest): Promise<VoiceTurnPost> {
  const initial = activeGrant((await grantRef(deps.db, request.voiceGrant).get()).data(), gatewayId);
  if (initial.sessionId !== request.sessionId) deny();
  const resolved = await authorizeGrant(deps, initial);
  const digest = turnDigest(request);
  const replay = await reserveTurn(deps, gatewayId, request, resolved, digest);
  if (replay) return replay;
  let post: VoiceTurnPost;
  try { post = await createTurnPost(deps, resolved.token, resolved.context, request); }
  catch (error) {
    await finishTurn(deps, gatewayId, request, { digest, state: 'failed' });
    if (error instanceof VoicePostingGrantError) throw error;
    throw new VoicePostingGrantError(502, 'voice_turn_failed');
  }
  await finishTurn(deps, gatewayId, request, { digest, state: 'posted', post });
  return post;
}
