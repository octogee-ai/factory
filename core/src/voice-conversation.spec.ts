import { describe, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock('./internal-fetch.js', () => ({ internalFetch: h.fetch }));
import { VoiceConversationConfigurationError, archiveVoiceCall, bindVoiceGrant, endVoiceGrant, isVoiceArchiveRequest, isVoiceGrantRequest, isVoiceGrantEndRequest, isVoiceTurnRequest, postVoiceTurn, resolveVoiceConversation, voiceTurnMessage } from './voice-conversation.js';
const channelId = 'a'.repeat(26);
const threadRootPostId = 'r'.repeat(26);
const env = { OPENCLAW_RUNTIME_BROKER_URL: 'http://octogee-api:3001' };
const args = { uid: 'u', gatewayId: 'b-alice', channelId, threadRootPostId, expectedAgentId: 'octogee-alice-coach', env };
const answer = { uid: 'u', gatewayId: 'b-alice', channelId, threadRootPostId, workspaceSlug: 'alice', agentId: args.expectedAgentId, sessionKey: `agent:${args.expectedAgentId}:mattermost:group:${channelId}:thread:${threadRootPostId}`, callerMmUserId: 'b'.repeat(26), nativeInterrupt: true };
function brokerCall(index = 0) {
  const [url, init, options] = h.fetch.mock.calls[index] as [string, RequestInit, Record<string, unknown>];
  const parsed = new URL(url);
  return { origin: parsed.origin, path: parsed.pathname, body: JSON.parse(String(init.body)), redirect: init.redirect, options };
}
describe('voice conversation broker', () => {
  it('uses projected service authentication and returns the canonical server context', async () => {
    h.fetch.mockReset(); h.fetch.mockResolvedValue(new Response(JSON.stringify(answer)));
    await expect(resolveVoiceConversation(args)).resolves.toEqual(answer);
    expect(brokerCall()).toMatchObject({ origin: env.OPENCLAW_RUNTIME_BROKER_URL, path: '/internal/voice/conversation', body: { uid: 'u', gatewayId: 'b-alice', channelId, threadRootPostId }, redirect: 'error', options: { requireProjectedToken: true } });
  });
  it('uses an explicitly configured broker and token path without edge-only environment variables', async () => {
    h.fetch.mockReset(); h.fetch.mockResolvedValue(new Response(JSON.stringify(answer)));
    await expect(resolveVoiceConversation({ ...args, env: {}, brokerUrl: 'http://localhost:3001', tokenPath: '/gateway/projected-token' })).resolves.toEqual(answer);
    expect(brokerCall()).toMatchObject({ origin: 'http://localhost:3001', options: { tokenPath: '/gateway/projected-token', requireProjectedToken: true } });
  });
  it('fails before sending authority when the broker is unconfigured or untrusted', async () => {
    h.fetch.mockReset();
    await expect(resolveVoiceConversation({ ...args, env: {} })).rejects.toBeInstanceOf(VoiceConversationConfigurationError);
    await expect(resolveVoiceConversation({ ...args, brokerUrl: 'https://foreign.example' })).rejects.toThrow('must target');
    expect(h.fetch).not.toHaveBeenCalled();
  });
  it('never accepts a member credential from the broker context', async () => {
    h.fetch.mockReset(); h.fetch.mockResolvedValue(new Response(JSON.stringify({ ...answer, mmToken: 'm'.repeat(26) })));
    await expect(resolveVoiceConversation(args)).resolves.not.toHaveProperty('mmToken');
  });
  it.each([{ uid: 'foreign' }, { gatewayId: 'b-other' }, { agentId: 'foreign' }, { sessionKey: 'agent:foreign:main' }, { callerMmUserId: 'short' }, { nativeInterrupt: 'yes' }])('rejects malformed or cross-context answers %j', async (patch) => {
    h.fetch.mockReset(); h.fetch.mockResolvedValue(new Response(JSON.stringify({ ...answer, ...patch })));
    await expect(resolveVoiceConversation(args)).rejects.toThrow();
  });
  it('does not turn a revoked conversation into usable context', async () => {
    h.fetch.mockReset(); h.fetch.mockResolvedValue(new Response('{}', { status: 403 }));
    await expect(resolveVoiceConversation(args)).rejects.toMatchObject({ status: 403 });
  });
});
describe('server-posted voice turns', () => {
  const turn = { voiceGrant: 'g'.repeat(43), sessionId: 'native-session', turnId: 'turn-1', text: 'Open the news', env };
  const posted = { postId: 'p'.repeat(26), channelId, threadRootPostId, userId: 'b'.repeat(26) };
  it('asks the broker to post the turn and returns the verified post identity', async () => {
    h.fetch.mockReset(); h.fetch.mockResolvedValue(new Response(JSON.stringify(posted)));
    await expect(postVoiceTurn({ ...turn, ingressToken: 'native-token', turnId: 'turn-1' })).resolves.toEqual(posted);
    expect(brokerCall()).toMatchObject({ path: '/internal/voice/turn', body: { voiceGrant: turn.voiceGrant, sessionId: turn.sessionId, text: 'Open the news', ingressToken: 'native-token', turnId: 'turn-1' }, options: { requireProjectedToken: true } });
    expect(brokerCall().body).not.toHaveProperty('mmToken');
  });
  it.each([{ channelId: 'short' }, { postId: 'short' }, { userId: null }])('rejects malformed post identities %j', async (patch) => {
    h.fetch.mockReset(); h.fetch.mockResolvedValue(new Response(JSON.stringify({ ...posted, ...patch })));
    await expect(postVoiceTurn(turn)).rejects.toThrow('invalid post');
  });
  it('surfaces revoked authority as an access error', async () => {
    h.fetch.mockReset(); h.fetch.mockResolvedValue(new Response('{}', { status: 403 }));
    await expect(postVoiceTurn(turn)).rejects.toMatchObject({ status: 403 });
  });
  it('refuses to send a malformed turn', async () => {
    h.fetch.mockReset();
    await expect(postVoiceTurn({ ...turn, text: '   ' })).rejects.toThrow('malformed');
    expect(h.fetch).not.toHaveBeenCalled();
  });
  it('composes the channel message the same way for every poster', () => {
    expect(voiceTurnMessage('  Open the news ')).toBe('🎙 Open the news');
  });
  it.each([
    [{ voiceGrant: 'g'.repeat(43), sessionId: 'native', turnId: 'turn-1', text: 'hi' }, true],
    [{ voiceGrant: 'g'.repeat(43), sessionId: 'native', turnId: 'turn-1', text: 'hi', ingressToken: 'tok-1' }, true],
    [{ uid: 'u', gatewayId: 'g', channelId, text: 'hi' }, false],
    [{ ...turn, env: undefined }, false],
    [{ voiceGrant: 'short', sessionId: 'native', turnId: 'turn-1', text: 'hi' }, false],
    [{ voiceGrant: 'g'.repeat(43), sessionId: 'native', text: 'hi' }, false],
    [{ voiceGrant: 'g'.repeat(43), sessionId: 'native', turnId: 'bad turn', text: 'hi' }, false],
    [{ voiceGrant: 'g'.repeat(43), sessionId: 'native', turnId: 'turn-1', text: 'x'.repeat(8001) }, false],
    [{ voiceGrant: 'g'.repeat(43), sessionId: 'native', turnId: 'turn-1', text: 'hi', ingressToken: 'has space' }, false],
    [null, false],
  ])('validates turn request shape %j → %s', (value, expected) => {
    expect(isVoiceTurnRequest(value)).toBe(expected);
  });
});


describe('voice posting grant client', () => {
  const grant = { voiceGrant: 'g'.repeat(43), sessionId: 'native-session', env };
  it('binds the opaque grant and returns only verified conversation metadata', async () => {
    const binding = { ...answer, sessionId: grant.sessionId, expiresAt: Date.now() + 10000 };
    h.fetch.mockReset(); h.fetch.mockResolvedValue(new Response(JSON.stringify({ ...binding, mmToken: 'private', voiceGrant: grant.voiceGrant })));
    await expect(bindVoiceGrant(grant)).resolves.toEqual(binding);
    expect(brokerCall()).toMatchObject({ path: '/internal/voice/bind', body: { voiceGrant: grant.voiceGrant, sessionId: grant.sessionId } });
  });
  it.each([{ sessionId: 'foreign' }, { expiresAt: 0 }, { sessionKey: 'foreign' }, { callerMmUserId: 'short' }])('rejects malformed grant bindings %j', async patch => {
    h.fetch.mockReset(); h.fetch.mockResolvedValue(new Response(JSON.stringify({ ...answer, sessionId: grant.sessionId, expiresAt: Date.now() + 10000, ...patch })));
    await expect(bindVoiceGrant(grant)).rejects.toThrow();
  });
  it('requires an acknowledged grant revocation and permits cleanup before native startup', async () => {
    h.fetch.mockReset(); h.fetch.mockResolvedValueOnce(new Response('{"revoked":true}')).mockResolvedValueOnce(new Response('{"revoked":false}'));
    await expect(endVoiceGrant({ voiceGrant: grant.voiceGrant, env })).resolves.toEqual({ revoked: true });
    expect(brokerCall().body).toEqual({ voiceGrant: grant.voiceGrant });
    await expect(endVoiceGrant(grant)).rejects.toThrow('confirm revocation');
  });
  it('rejects caller-shaped or malformed grant requests', () => {
    expect(isVoiceGrantRequest({ voiceGrant: grant.voiceGrant, sessionId: 'native' })).toBe(true);
    expect(isVoiceGrantRequest({ voiceGrant: grant.voiceGrant, sessionId: 'native', uid: 'forged' })).toBe(false);
    expect(isVoiceGrantEndRequest({ voiceGrant: grant.voiceGrant })).toBe(true);
    expect(isVoiceGrantEndRequest({ voiceGrant: 'bad' })).toBe(false);
  });
  it.each([409, 429, 502])('preserves posting failure status %s', async status => {
    h.fetch.mockReset(); h.fetch.mockResolvedValue(new Response('{}', { status }));
    await expect(postVoiceTurn({ ...grant, turnId: 'turn', text: 'Hello' })).rejects.toMatchObject({ status });
  });
});

describe('closed-call speech archive client', () => {
  const archive = { voiceGrant: 'g'.repeat(43), sessionId: 'native-session', entries: [
    { transcriptId: 'voice:native:1', role: 'user' as const, text: 'Open the news' },
    { transcriptId: 'voice:native:2', role: 'assistant' as const, text: 'Here are the headlines.' },
  ], truncated: false };
  it('uses the archive broker with projected service authentication and returns only the post receipt', async () => {
    const posted = { postId: 'p'.repeat(26), channelId, threadRootPostId, userId: 'c'.repeat(26) };
    h.fetch.mockReset(); h.fetch.mockResolvedValue(new Response(JSON.stringify({ ...posted, mmToken: 'private' })));
    await expect(archiveVoiceCall({ ...archive, env })).resolves.toEqual(posted);
    expect(brokerCall()).toMatchObject({ path: '/internal/voice/archive', body: archive, options: { requireProjectedToken: true } });
  });
  it.each([{ postId: 'short' }, { channelId: null }, { userId: 'short' }])('rejects an unverified archive receipt %j', async patch => {
    h.fetch.mockReset(); h.fetch.mockResolvedValue(new Response(JSON.stringify({ postId: 'p'.repeat(26), channelId, threadRootPostId, userId: 'c'.repeat(26), ...patch })));
    await expect(archiveVoiceCall({ ...archive, env })).rejects.toThrow('invalid post');
  });
  it.each([403, 409, 502])('preserves explicit archive denial, pending and failure status %s', async status => {
    h.fetch.mockReset(); h.fetch.mockResolvedValue(new Response('{}', { status }));
    await expect(archiveVoiceCall({ ...archive, env })).rejects.toMatchObject({ status });
  });
  it('refuses malformed speech before forwarding authority', async () => {
    h.fetch.mockReset();
    await expect(archiveVoiceCall({ ...archive, entries: [], env })).rejects.toThrow('malformed');
    expect(h.fetch).not.toHaveBeenCalled();
  });
  it.each([
    { voiceGrant: 'short' }, { sessionId: 'bad/id' }, { uid: 'forged' }, { truncated: 'yes' },
    { entries: [] }, { entries: Array.from({ length: 129 }, (_, index) => ({ transcriptId: String(index), role: 'user', text: 'Hi' })) },
    { entries: [{ transcriptId: 'bad id', role: 'user', text: 'Hi' }] },
    { entries: [{ transcriptId: 'x'.repeat(257), role: 'user', text: 'Hi' }] },
    { entries: [{ transcriptId: 'one', role: 'system', text: 'Hi' }] },
    { entries: [{ transcriptId: 'one', role: 'user', text: '  ' }] },
    { entries: [{ transcriptId: 'one', role: 'user', text: 'x'.repeat(2001) }] },
    { entries: [{ transcriptId: 'one', role: 'user', text: 'Hi', final: true }] },
    { entries: [{ transcriptId: 'one', role: 'user', text: 'Hi' }, { transcriptId: 'one', role: 'assistant', text: 'Hello' }] },
    { entries: Array.from({ length: 7 }, (_, index) => ({ transcriptId: String(index), role: 'user', text: 'x'.repeat(2000) })) },
  ])('rejects noncanonical or oversized archive shape %j', patch => {
    expect(isVoiceArchiveRequest({ ...archive, ...patch })).toBe(false);
  });
  it('accepts exact count, identity, per-entry and total boundaries', () => {
    expect(isVoiceArchiveRequest({ ...archive, entries: Array.from({ length: 128 }, (_, index) => ({ transcriptId: `voice:native:${index}`, role: 'user', text: 'Hi' })) })).toBe(true);
    expect(isVoiceArchiveRequest({ ...archive, entries: Array.from({ length: 6 }, (_, index) => ({ transcriptId: index === 0 ? 'x'.repeat(256) : String(index), role: 'assistant', text: 'x'.repeat(2000) })), truncated: true })).toBe(true);
  });
});
