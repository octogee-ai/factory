import { describe, expect, it, vi } from 'vitest';
import { resolveActivityConversation } from './activity-conversation.js';

const channelId = 'c'.repeat(26);
const uid = 'member';
const gatewayId = 'shared-123456789abc';
function fixture(type = 'P') {
  const target = { ownerUid: 'owner', workspaceSlug: 'alice', agentId: 'octogee-alice-proj-web', agentMmUserId: 'a'.repeat(26), projectId: 'web' };
  const client = { getJson: vi.fn(async (path: readonly string[]) => path.length === 2
    ? { id: channelId, type, delete_at: 0 }
    : { channel_id: channelId, user_id: target.agentMmUserId }), postJson: vi.fn(async () => null), getCurrentUserId: vi.fn(async () => 'u'.repeat(26)), listChannelPosts: vi.fn(async () => ({ posts: [], reachedEnd: true })) };
  const authorize = vi.fn(async () => ({ forbidden: false as const, target, client, callerMmUserId: 'u'.repeat(26) }));
  const owner = { provisioning: { openclaw: { gatewayId, slug: 'alice' } }, username: 'alice' };
  const db = { doc: vi.fn(() => ({ get: async () => ({ exists: true, data: () => owner }) })) };
  return { db, authorize, client, target };
}
describe('native Activity conversation', () => {
  it.each([['O', 'channel', channelId], ['P', 'group', channelId], ['D', 'direct', 'u'.repeat(26)]])('uses the native %s conversation key', async (type, kind, peer) => {
    const f = fixture(type);
    expect((await resolveActivityConversation({ ...f, uid, channelId }))?.sessionKey).toBe(`agent:${f.target.agentId}:mattermost:${kind}:${peer}`);
  });
  it('uses the authorized project agent and exact private-channel session', async () => {
    const f = fixture();
    expect(await resolveActivityConversation({ ...f, uid, channelId })).toEqual({
      gatewayId, ownerUid: 'owner', channelId, expectedAgentId: f.target.agentId,
      sessionKey: `agent:${f.target.agentId}:mattermost:group:${channelId}`,
    });
    expect(f.authorize).toHaveBeenCalledWith(uid, channelId, undefined, { requireActiveLedger: true, includeCoachConversation: true });
  });
  it('denies a removed channel member', async () => {
    const f = fixture();
    f.authorize.mockResolvedValueOnce({ forbidden: true } as never);
    expect(await resolveActivityConversation({ ...f, uid, channelId })).toBeNull();
  });
  it('denies an agent that is not the selected channel member', async () => {
    const f = fixture();
    f.client.getJson.mockResolvedValueOnce({ id: channelId, type: 'P', delete_at: 0 }).mockResolvedValueOnce({ channel_id: 'other', user_id: f.target.agentMmUserId });
    expect(await resolveActivityConversation({ ...f, uid, channelId })).toBeNull();
  });
  it('refuses archived channels and absent owner assignments', async () => {
    const f = fixture();
    f.client.getJson.mockResolvedValueOnce({ id: channelId, type: 'P', delete_at: 1 });
    expect(await resolveActivityConversation({ ...f, uid, channelId })).toBeNull();
    f.db.doc.mockReturnValueOnce({ get: async () => ({ exists: true, data: () => ({}) }) } as never);
    expect(await resolveActivityConversation({ ...f, uid, channelId })).toBeNull();
  });
});
