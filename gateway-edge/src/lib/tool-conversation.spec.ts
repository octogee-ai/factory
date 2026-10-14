import { describe, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock('./internal-fetch.js', () => ({ internalFetch: h.fetch }));
import { resolveToolConversationForUid, resolveToolControlForUid } from './tool-conversation.js';
const channelId = 'a'.repeat(26);
const threadRootPostId = 'r'.repeat(26);
const args = { uid: 'u', gatewayId: 'b-alice', channelId, threadRootPostId, expectedAgentId: 'octogee-alice-coach', env: { OPENCLAW_RUNTIME_BROKER_URL: 'http://octogee-api:3001' } };
const answer = { uid: 'u', gatewayId: 'b-alice', channelId, threadRootPostId, workspaceSlug: 'alice', agentId: args.expectedAgentId, sessionKey: `agent:${args.expectedAgentId}:mattermost:group:${channelId}:thread:${threadRootPostId}`, callerMmUserId: 'b'.repeat(26) };
describe('tool conversation broker', () => {
  it('cannot turn an unbound Computer/theme control context into session custody', async () => {
    h.fetch.mockResolvedValue(new Response(JSON.stringify(answer)));
    await expect(resolveToolControlForUid(args)).rejects.toThrow('invalid context');
    const { agentId: _agent, sessionKey: _session, threadRootPostId: _root, ...control } = answer;
    h.fetch.mockResolvedValue(new Response(JSON.stringify(control)));
    await expect(resolveToolControlForUid(args)).resolves.toEqual(control);
    h.fetch.mockResolvedValue(new Response(JSON.stringify(control)));
    await expect(resolveToolConversationForUid(args)).rejects.toThrow('invalid context');
  });
  it('uses projected service authentication and returns the canonical server context', async () => {
    h.fetch.mockResolvedValue(new Response(JSON.stringify(answer)));
    await expect(resolveToolConversationForUid(args)).resolves.toEqual(answer);
    const [url, init, options] = h.fetch.mock.calls[0] as [string, RequestInit, Record<string, unknown>];
    expect(new URL(url).pathname).toBe('/internal/openclaw-control/tool-conversation');
    expect(init).toMatchObject({ body: JSON.stringify({ uid: 'u', gatewayId: 'b-alice', channelId, threadRootPostId, purpose: 'conversation' }), redirect: 'error' });
    expect(options).toMatchObject({ requireProjectedToken: true });
  });
  it('never carries a member credential into the sidecar', async () => {
    h.fetch.mockResolvedValue(new Response(JSON.stringify({ ...answer, mmToken: 'm'.repeat(26) })));
    await expect(resolveToolConversationForUid(args)).resolves.not.toHaveProperty('mmToken');
  });
  it.each([{ uid: 'foreign' }, { gatewayId: 'b-other' }, { agentId: 'foreign' }, { sessionKey: 'agent:foreign:main' }, { callerMmUserId: 'short' }])('rejects malformed or cross-context answers %j', async (patch) => {
    h.fetch.mockResolvedValue(new Response(JSON.stringify({ ...answer, ...patch })));
    await expect(resolveToolConversationForUid(args)).rejects.toThrow();
  });
  it('does not turn a revoked conversation into usable context', async () => {
    h.fetch.mockResolvedValue(new Response('{}', { status: 403 }));
    await expect(resolveToolConversationForUid(args)).rejects.toMatchObject({ status: 403 });
  });
});
