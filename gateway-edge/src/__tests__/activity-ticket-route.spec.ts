import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({ authorize: vi.fn(), mint: vi.fn() }));
vi.mock('../middleware/auth.js', () => ({ requireAuth: (req: { uid: string }, _res: unknown, next: () => void) => { req.uid = 'member'; next(); } }));
vi.mock('../lib/activity-conversation.js', () => ({ resolveActivityConversation: h.authorize }));
vi.mock('../lib/gateway-ticket.js', () => ({ mintTicket: h.mint }));
const { default: router } = await import('../routes/openclaw.js');
const scope = { gatewayId: 'shared-123456789abc', ownerUid: 'owner', channelId: 'c'.repeat(26), expectedAgentId: 'octogee-alice-proj-web', sessionKey: `agent:octogee-alice-proj-web:mattermost:group:${'c'.repeat(26)}` };
function app() { const a = express(); a.use(express.json()); a.use('/api/openclaw', router); return a; }
beforeEach(() => { h.authorize.mockReset().mockResolvedValue(scope); h.mint.mockReset().mockResolvedValue({ ticket: 'ticket' }); });
describe('native Activity tickets', () => {
  it('mints the exact server-derived channel scope without activation or control grants', async () => {
    const result = await request(app()).post('/api/openclaw/ticket').send({ channelId: scope.channelId });
    expect(result.status).toBe(200); expect(result.body).toMatchObject({ gatewayId: scope.gatewayId, sessionKey: scope.sessionKey, wsTicket: 'ticket' });
    expect(h.mint).toHaveBeenCalledWith({ uid: 'member', gatewayId: scope.gatewayId, purpose: 'openclaw-ws', payload: { ownerUid: scope.ownerUid, channelId: scope.channelId, expectedAgentId: scope.expectedAgentId, sessionKey: scope.sessionKey } });
    expect(result.headers['cache-control']).toBe('no-store');
  });
  it.each([{ channelId: 'bad' }, { channelId: scope.channelId, expectedAgentId: 'other' }, { channelId: scope.channelId, sessionKey: 'forged' }])('rejects client-assigned authority %j', async body => {
    expect((await request(app()).post('/api/openclaw/ticket').send(body)).status).toBe(400); expect(h.mint).not.toHaveBeenCalled();
  });
  it('does not mint for a removed member', async () => {
    h.authorize.mockResolvedValue(null); expect((await request(app()).post('/api/openclaw/ticket').send({ channelId: scope.channelId })).status).toBe(403); expect(h.mint).not.toHaveBeenCalled();
  });
});
