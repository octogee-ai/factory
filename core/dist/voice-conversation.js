import { trustedBrokerBaseUrl } from './trusted-broker-url.js';
import { internalFetch } from './internal-fetch.js';
import { isMattermostPostId } from '@octogee/shared/types/mattermost-session-route';
export class VoiceConversationAccessError extends Error {
    status;
    constructor(status, message) {
        super(message);
        this.status = status;
        this.name = 'VoiceConversationAccessError';
    }
}
export class VoiceConversationConfigurationError extends Error {
    constructor() { super('Voice conversation broker is not configured'); this.name = 'VoiceConversationConfigurationError'; }
}
export const VOICE_TURN_POST_KIND = 'voice-turn';
export const VOICE_TURN_MARKER = '🎙';
export const VOICE_TURN_TEXT_MAX = 8000;
export const VOICE_ARCHIVE_POST_KIND = 'voice-archive';
export const VOICE_ARCHIVE_ENTRIES_MAX = 128;
export const VOICE_ARCHIVE_ENTRY_TEXT_MAX = 2000;
export const VOICE_ARCHIVE_TEXT_MAX = 12000;
export const VOICE_ARCHIVE_TRANSCRIPT_ID_MAX = 256;
const MATTERMOST_ID_RE = /^[a-z0-9]{26}$/u;
const TURN_ID_RE = /^[A-Za-z0-9_-]{1,64}$/u;
const INGRESS_TOKEN_RE = /^[!-~]{1,512}$/u;
export function voiceTurnMessage(transcript) {
    return `${VOICE_TURN_MARKER} ${transcript.trim()}`;
}
function boundedId(value) {
    return typeof value === 'string' && value.length > 0 && value.length <= 128 && !value.includes('/');
}
function matches(pattern, value) {
    return typeof value === 'string' && pattern.test(value);
}
function validTurnText(value) {
    return typeof value === 'string' && value.trim().length > 0 && value.length <= VOICE_TURN_TEXT_MAX;
}
function requestRecord(value, keys) {
    if (typeof value !== 'object' || value === null || Array.isArray(value))
        return null;
    const body = value;
    return Object.keys(body).every(key => keys.includes(key)) ? body : null;
}
function validGrant(value) {
    return matches(/^[A-Za-z0-9_-]{43}$/u, value);
}
export function isVoiceGrantRequest(value) {
    const body = requestRecord(value, ['voiceGrant', 'sessionId']);
    return Boolean(body && validGrant(body.voiceGrant) && boundedId(body.sessionId));
}
export function isVoiceGrantEndRequest(value) {
    const body = requestRecord(value, ['voiceGrant', 'sessionId']);
    return Boolean(body && validGrant(body.voiceGrant) && (body.sessionId === undefined || boundedId(body.sessionId)));
}
export function isVoiceTurnRequest(value) {
    const body = requestRecord(value, ['voiceGrant', 'sessionId', 'turnId', 'text', 'ingressToken']);
    return Boolean(body && validGrant(body.voiceGrant) && boundedId(body.sessionId) && matches(TURN_ID_RE, body.turnId) && validTurnText(body.text) &&
        (body.ingressToken === undefined || matches(INGRESS_TOKEN_RE, body.ingressToken)));
}
function isVoiceArchiveEntry(value) {
    const entry = requestRecord(value, ['transcriptId', 'role', 'text']);
    return Boolean(entry && typeof entry.transcriptId === 'string' && entry.transcriptId.length <= VOICE_ARCHIVE_TRANSCRIPT_ID_MAX &&
        /^[A-Za-z0-9:_-]+$/u.test(entry.transcriptId) && (entry.role === 'user' || entry.role === 'assistant') &&
        typeof entry.text === 'string' && entry.text.trim() && entry.text.length <= VOICE_ARCHIVE_ENTRY_TEXT_MAX);
}
export function isVoiceArchiveRequest(value) {
    const body = requestRecord(value, ['voiceGrant', 'sessionId', 'entries', 'truncated']);
    if (!body || !validGrant(body.voiceGrant) || !boundedId(body.sessionId) || typeof body.truncated !== 'boolean' ||
        !Array.isArray(body.entries) || body.entries.length === 0 || body.entries.length > VOICE_ARCHIVE_ENTRIES_MAX)
        return false;
    const ids = new Set();
    let textChars = 0;
    for (const value of body.entries) {
        if (!isVoiceArchiveEntry(value) || ids.has(value.transcriptId))
            return false;
        ids.add(value.transcriptId);
        textChars += value.text.length;
        if (textChars > VOICE_ARCHIVE_TEXT_MAX)
            return false;
    }
    return true;
}
function validateConversationIdentity(body, args) {
    if (body.uid !== args.uid || body.gatewayId !== args.gatewayId || body.channelId !== args.channelId ||
        typeof body.workspaceSlug !== 'string' || !/^[a-z0-9-]{1,64}$/u.test(body.workspaceSlug) ||
        !isMattermostPostId(args.threadRootPostId) || body.threadRootPostId !== args.threadRootPostId || body.agentId !== `octogee-${body.workspaceSlug}-coach` ||
        (args.expectedAgentId !== undefined && body.agentId !== args.expectedAgentId) ||
        !['group', 'channel'].some(kind => body.sessionKey === `agent:${body.agentId}:mattermost:${kind}:${args.channelId}`)) {
        throw new Error('Voice conversation broker returned an invalid context');
    }
}
function validateConversationParticipant(body) {
    if (typeof body.nativeInterrupt !== 'boolean' || typeof body.callerMmUserId !== 'string' || !MATTERMOST_ID_RE.test(body.callerMmUserId)) {
        throw new Error('Voice conversation broker returned an invalid context');
    }
}
async function brokerPost(path, body, options) {
    const env = options.env ?? process.env;
    const rawBase = options.brokerUrl ?? env.OPENCLAW_RUNTIME_BROKER_URL;
    if (!rawBase)
        throw new VoiceConversationConfigurationError();
    const base = trustedBrokerBaseUrl(rawBase, env);
    const response = await internalFetch(`${base}${path}`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, redirect: 'error', body: JSON.stringify(body),
    }, { fetchImpl: options.fetchImpl, tokenPath: options.tokenPath ?? env.OCTOGEE_API_SA_TOKEN_PATH, requireProjectedToken: true, timeoutMs: 5000 });
    if (!response.ok)
        throw new VoiceConversationAccessError([401, 403, 404, 409, 429, 502].includes(response.status) ? response.status : 503, 'Voice conversation unavailable');
    return response.json();
}
export async function resolveVoiceConversation(args) {
    if (!isMattermostPostId(args.threadRootPostId))
        throw new Error('Voice conversation requires a selected thread');
    const body = await brokerPost('/internal/voice/conversation', { uid: args.uid, gatewayId: args.gatewayId, channelId: args.channelId, threadRootPostId: args.threadRootPostId }, args);
    validateConversationIdentity(body, args);
    validateConversationParticipant(body);
    const { uid, gatewayId, workspaceSlug, channelId, threadRootPostId, agentId, sessionKey, callerMmUserId, nativeInterrupt } = body;
    return { uid, gatewayId, workspaceSlug, channelId, threadRootPostId, agentId, sessionKey, callerMmUserId, nativeInterrupt };
}
export async function bindVoiceGrant(args) {
    const request = { voiceGrant: args.voiceGrant, sessionId: args.sessionId };
    if (!isVoiceGrantRequest(request))
        throw new Error('Voice grant request is malformed');
    const body = await brokerPost('/internal/voice/bind', request, args);
    if (!boundedId(body.uid) || !boundedId(body.gatewayId) || !matches(MATTERMOST_ID_RE, body.channelId) || body.sessionId !== args.sessionId ||
        typeof body.expiresAt !== 'number' || !Number.isFinite(body.expiresAt) || body.expiresAt <= Date.now())
        throw new Error('Voice grant broker returned an invalid binding');
    if (!isMattermostPostId(body.threadRootPostId))
        throw new Error('Voice grant broker returned an invalid binding');
    validateConversationIdentity(body, { uid: body.uid, gatewayId: body.gatewayId, channelId: body.channelId, threadRootPostId: body.threadRootPostId });
    validateConversationParticipant(body);
    const { uid, gatewayId, workspaceSlug, channelId, threadRootPostId, agentId, sessionKey, callerMmUserId, nativeInterrupt, sessionId, expiresAt } = body;
    return { uid, gatewayId, workspaceSlug, channelId, threadRootPostId, agentId, sessionKey, callerMmUserId, nativeInterrupt, sessionId, expiresAt };
}
export async function endVoiceGrant(args) {
    const request = { voiceGrant: args.voiceGrant, ...(args.sessionId === undefined ? {} : { sessionId: args.sessionId }) };
    if (!isVoiceGrantEndRequest(request))
        throw new Error('Voice grant end request is malformed');
    const body = await brokerPost('/internal/voice/end', request, args);
    if (body.revoked !== true)
        throw new Error('Voice grant broker did not confirm revocation');
    return { revoked: true };
}
export async function postVoiceTurn(args) {
    const request = {
        voiceGrant: args.voiceGrant, sessionId: args.sessionId, turnId: args.turnId, text: args.text,
        ...(args.ingressToken !== undefined ? { ingressToken: args.ingressToken } : {}),
    };
    if (!isVoiceTurnRequest(request))
        throw new Error('Voice turn request is malformed');
    const body = await brokerPost('/internal/voice/turn', { ...request }, args);
    if (!matches(MATTERMOST_ID_RE, body.postId) || !matches(MATTERMOST_ID_RE, body.channelId) || !matches(MATTERMOST_ID_RE, body.userId) || !isMattermostPostId(body.threadRootPostId)) {
        throw new Error('Voice turn broker returned an invalid post');
    }
    return { postId: body.postId, channelId: body.channelId, threadRootPostId: body.threadRootPostId, userId: body.userId };
}
export async function archiveVoiceCall(args) {
    const request = { voiceGrant: args.voiceGrant, sessionId: args.sessionId, entries: args.entries, truncated: args.truncated };
    if (!isVoiceArchiveRequest(request))
        throw new Error('Voice archive request is malformed');
    const body = await brokerPost('/internal/voice/archive', { ...request }, args);
    if (!matches(MATTERMOST_ID_RE, body.postId) || !matches(MATTERMOST_ID_RE, body.channelId) || !matches(MATTERMOST_ID_RE, body.userId) || !isMattermostPostId(body.threadRootPostId)) {
        throw new Error('Voice archive broker returned an invalid post');
    }
    return { postId: body.postId, channelId: body.channelId, threadRootPostId: body.threadRootPostId, userId: body.userId };
}
