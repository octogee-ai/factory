import { trustedBrokerBaseUrl } from './trusted-broker-url.js';
import { internalFetch } from './internal-fetch.js';
export class VoiceConversationAccessError extends Error {
  constructor(readonly status: number, message: string) { super(message); this.name = 'VoiceConversationAccessError'; }
}

export const VOICE_TURN_POST_KIND = 'voice-turn';
export const VOICE_TURN_MARKER = '🎙';
export const VOICE_TURN_TEXT_MAX = 8000;
const MATTERMOST_ID_RE = /^[a-z0-9]{26}$/u;
const TURN_ID_RE = /^[A-Za-z0-9_-]{1,64}$/u;
const INGRESS_TOKEN_RE = /^[!-~]{1,512}$/u;

export function voiceTurnMessage(transcript: string): string {
  return `${VOICE_TURN_MARKER} ${transcript.trim()}`;
}

export interface VoiceConversation {
  uid: string;
  gatewayId: string;
  workspaceSlug: string;
  channelId: string;
  agentId: string;
  sessionKey: string;
  callerMmUserId: string;
  nativeInterrupt: boolean;
}

export interface VoiceTurnRequest {
  uid: string;
  gatewayId: string;
  channelId: string;
  text: string;
  turnId?: string;
  ingressToken?: string;
}

export interface VoiceTurnPost {
  postId: string;
  channelId: string;
  userId: string;
}

function boundedId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 128 && !value.includes('/');
}

function matches(pattern: RegExp, value: unknown): value is string {
  return typeof value === 'string' && pattern.test(value);
}

function validTurnText(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= VOICE_TURN_TEXT_MAX;
}

const VOICE_TURN_REQUEST_KEYS = ['uid', 'gatewayId', 'channelId', 'text', 'turnId', 'ingressToken'];

export function isVoiceTurnRequest(value: unknown): value is VoiceTurnRequest {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const body = value as Record<string, unknown>;
  return Object.keys(body).every(key => VOICE_TURN_REQUEST_KEYS.includes(key)) &&
    boundedId(body.uid) && boundedId(body.gatewayId) && matches(MATTERMOST_ID_RE, body.channelId) && validTurnText(body.text) &&
    (body.turnId === undefined || matches(TURN_ID_RE, body.turnId)) &&
    (body.ingressToken === undefined || matches(INGRESS_TOKEN_RE, body.ingressToken));
}

function validateConversationIdentity(body: Partial<VoiceConversation>, args: { uid: string; gatewayId: string; channelId: string; expectedAgentId?: string }): void {
  if (body.uid !== args.uid || body.gatewayId !== args.gatewayId || body.channelId !== args.channelId ||
    typeof body.workspaceSlug !== 'string' || !/^[a-z0-9-]{1,64}$/u.test(body.workspaceSlug) ||
    body.agentId !== `octogee-${body.workspaceSlug}-coach` ||
    (args.expectedAgentId !== undefined && body.agentId !== args.expectedAgentId) ||
    !['group', 'channel'].some(kind => body.sessionKey === `agent:${body.agentId}:mattermost:${kind}:${args.channelId}`)) {
    throw new Error('Voice conversation broker returned an invalid context');
  }
}

function validateConversationParticipant(body: Partial<VoiceConversation>): void {
  if (typeof body.nativeInterrupt !== 'boolean' || typeof body.callerMmUserId !== 'string' || !MATTERMOST_ID_RE.test(body.callerMmUserId)) {
    throw new Error('Voice conversation broker returned an invalid context');
  }
}

async function brokerPost(path: string, body: Record<string, unknown>, options: { env?: NodeJS.ProcessEnv; fetchImpl?: typeof fetch }): Promise<unknown> {
  const env = options.env ?? process.env;
  const rawBase = env.OPENCLAW_RUNTIME_BROKER_URL;
  if (!rawBase) throw new Error('OPENCLAW_RUNTIME_BROKER_URL is required');
  const base = trustedBrokerBaseUrl(rawBase, env);
  const response = await internalFetch(`${base}${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, redirect: 'error', body: JSON.stringify(body),
  }, { fetchImpl: options.fetchImpl, requireProjectedToken: true, timeoutMs: 5000 });
  if (!response.ok) throw new VoiceConversationAccessError([401, 403, 404].includes(response.status) ? response.status : 503, 'Voice conversation unavailable');
  return response.json();
}

export async function resolveVoiceConversation(args: {
  uid: string; gatewayId: string; channelId: string; expectedAgentId?: string;
  env?: NodeJS.ProcessEnv; fetchImpl?: typeof fetch;
}): Promise<VoiceConversation> {
  const body = await brokerPost('/internal/voice/conversation', { uid: args.uid, gatewayId: args.gatewayId, channelId: args.channelId }, args) as Partial<VoiceConversation>;
  validateConversationIdentity(body, args);
  validateConversationParticipant(body);
  const { uid, gatewayId, workspaceSlug, channelId, agentId, sessionKey, callerMmUserId, nativeInterrupt } = body as VoiceConversation;
  return { uid, gatewayId, workspaceSlug, channelId, agentId, sessionKey, callerMmUserId, nativeInterrupt };
}

export async function postVoiceTurn(args: VoiceTurnRequest & { env?: NodeJS.ProcessEnv; fetchImpl?: typeof fetch }): Promise<VoiceTurnPost> {
  const request: VoiceTurnRequest = {
    uid: args.uid, gatewayId: args.gatewayId, channelId: args.channelId, text: args.text,
    ...(args.turnId !== undefined ? { turnId: args.turnId } : {}),
    ...(args.ingressToken !== undefined ? { ingressToken: args.ingressToken } : {}),
  };
  if (!isVoiceTurnRequest(request)) throw new Error('Voice turn request is malformed');
  const body = await brokerPost('/internal/voice/turn', { ...request }, args) as Partial<VoiceTurnPost>;
  if (typeof body.postId !== 'string' || !MATTERMOST_ID_RE.test(body.postId) || body.channelId !== args.channelId ||
    typeof body.userId !== 'string' || !MATTERMOST_ID_RE.test(body.userId)) {
    throw new Error('Voice turn broker returned a post outside the requested conversation');
  }
  return { postId: body.postId, channelId: body.channelId, userId: body.userId };
}
