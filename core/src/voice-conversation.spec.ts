import { describe, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock('./internal-fetch.js', () => ({ internalFetch: h.fetch }));
import { isVoiceTurnRequest, postVoiceTurn, resolveVoiceConversation, voiceTurnMessage } from './voice-conversation.js';
const channelId = 'a'.repeat(26);
const env = { OPENCLAW_RUNTIME_BROKER_URL: 'http://octogee-api:3001' };
const args = { uid: 'u', gatewayId: 'b-alice', channelId, expectedAgentId: 'octogee-alice-coach', env };
const answer = { uid: 'u', gatewayId: 'b-alice', channelId, workspaceSlug: 'alice', agentId: args.expectedAgentId, sessionKey: `agent:${args.expectedAgentId}:mattermost:group:${channelId}`, callerMmUserId: 'b'.repeat(26), nativeInterrupt: true };
function brokerCall(index = 0) {
  const [url, init, options] = h.fetch.mock.calls[index] as [string, RequestInit, Record<string, unknown>];
  const parsed = new URL(url);
  return { origin: parsed.origin, path: parsed.pathname, body: JSON.parse(String(init.body)), redirect: init.redirect, options };
}
describe('voice conversation broker', () => {
  it('uses projected service authentication and returns the canonical server context', async () => {
    h.fetch.mockReset(); h.fetch.mockResolvedValue(new Response(JSON.stringify(answer)));
    await expect(resolveVoiceConversation(args)).resolves.toEqual(answer);
    expect(brokerCall()).toMatchObject({ origin: env.OPENCLAW_RUNTIME_BROKER_URL, path: '/internal/voice/conversation', body: { uid: 'u', gatewayId: 'b-alice', channelId }, redirect: 'error', options: { requireProjectedToken: true } });
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
  const turn = { uid: 'u', gatewayId: 'b-alice', channelId, text: 'Open the news', env };
  const posted = { postId: 'p'.repeat(26), channelId, userId: 'b'.repeat(26) };
  it('asks the broker to post the turn and returns the verified post identity', async () => {
    h.fetch.mockReset(); h.fetch.mockResolvedValue(new Response(JSON.stringify(posted)));
    await expect(postVoiceTurn({ ...turn, ingressToken: 'native-token', turnId: 'turn-1' })).resolves.toEqual(posted);
    expect(brokerCall()).toMatchObject({ path: '/internal/voice/turn', body: { uid: 'u', gatewayId: 'b-alice', channelId, text: 'Open the news', ingressToken: 'native-token', turnId: 'turn-1' }, options: { requireProjectedToken: true } });
    expect(brokerCall().body).not.toHaveProperty('mmToken');
  });
  it.each([{ channelId: 'z'.repeat(26) }, { postId: 'short' }, { userId: null }])('rejects a post reported outside the requested conversation %j', async (patch) => {
    h.fetch.mockReset(); h.fetch.mockResolvedValue(new Response(JSON.stringify({ ...posted, ...patch })));
    await expect(postVoiceTurn(turn)).rejects.toThrow('outside the requested conversation');
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
    [{ uid: 'u', gatewayId: 'g', channelId, text: 'hi' }, true],
    [{ uid: 'u', gatewayId: 'g', channelId, text: 'hi', turnId: 'turn_1', ingressToken: 'tok-1' }, true],
    [{ uid: 'u', gatewayId: 'g', channelId, text: '' }, false],
    [{ uid: 'u', gatewayId: 'g', channelId, text: 'x'.repeat(8001) }, false],
    [{ uid: 'u', gatewayId: 'g', channelId: 'short', text: 'hi' }, false],
    [{ uid: 'a/b', gatewayId: 'g', channelId, text: 'hi' }, false],
    [{ uid: 'u', gatewayId: 'g', channelId, text: 'hi', turnId: 'bad turn' }, false],
    [{ uid: 'u', gatewayId: 'g', channelId, text: 'hi', ingressToken: 'has space' }, false],
    [{ uid: 'u', gatewayId: 'g', channelId, text: 'hi', mmToken: 'forged' }, false],
    [null, false],
  ])('validates turn request shape %j → %s', (value, expected) => {
    expect(isVoiceTurnRequest(value)).toBe(expected);
  });
});
