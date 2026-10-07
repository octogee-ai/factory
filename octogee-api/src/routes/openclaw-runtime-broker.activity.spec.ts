import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Firestore } from 'firebase-admin/firestore';
import { createOpenClawRuntimeBrokerRoutes } from './openclaw-runtime-broker.js';
const authorize = vi.hoisted(() => vi.fn());
vi.mock('../../../gateway-edge/src/lib/activity-conversation.js', () => ({ resolveActivityConversation: authorize }));
const gatewayId = 'b-alice';
const scope = { gatewayId, ownerUid: 'owner', channelId: 'c'.repeat(26), expectedAgentId: 'octogee-alice-proj-web', sessionKey: `agent:octogee-alice-proj-web:mattermost:group:${'c'.repeat(26)}` };
function harness(payloadPatch: Record<string, unknown> = {}, ownerGateway = gatewayId) {
  const { gatewayId: _, ...payload } = scope;
  const ticket = { uid: 'member', gatewayId, purpose: 'openclaw-ws', expiresAt: Date.now() + 30_000, payload: { ...payload, ...payloadPatch } };
  const docs: Record<string, unknown> = {
    'gatewayTickets/ticket': ticket,
    'users/owner': { provisioning: { openclaw: { gatewayId: ownerGateway } } },
    [`gateways/${gatewayId}`]: { gatewayId, desiredRelease: 1, latestRelease: 1, liveRelease: 1, desiredStatus: 'running', configSchemaVersion: 1, profile: 'builder', gatewayClass: 'builder', imageProfile: 'builder', sizingTier: null, gcpProject: null, gatewayContainerSecurityContext: null, serviceAccountName: null, serviceAccount: null, builderAccess: { controlIdentity: 'per-user', controlUiEnabled: true }, ownerUid: 'owner', builderSlug: 'alice', modelBrokerLimits: null, preemption: null },
    [`glmGateways/${gatewayId}`]: { gatewayId, lifecycle: 'serving', heartbeat: { internalUrl: 'ws://native.internal:18789' } },
  };
  const deleted = vi.fn((ref: { path: string }) => { delete docs[ref.path]; });
  const set = vi.fn();
  const tx = { get: async (ref: { path: string }) => ({ exists: docs[ref.path] !== undefined, data: () => docs[ref.path] }), delete: deleted, set };
  const db = { doc: (path: string) => ({ path }), collection: (name: string) => ({ doc: (id: string) => ({ path: `${name}/${id}` }) }), runTransaction: async (fn: (value: typeof tx) => unknown) => fn(tx) } as unknown as Firestore;
  const app = express(); app.use(express.json());
  app.use((req, _res, next) => { req.boundTenant = { kind: 'gateway', gatewayId, ownerUid: 'owner' }; next(); });
  app.use('/internal/openclaw', createOpenClawRuntimeBrokerRoutes({ db }));
  return { deleted, set, post: () => request(app).post('/internal/openclaw/ws/redeem').send({ ticketId: 'ticket', purpose: 'openclaw-ws' }), access: () => request(app).post('/internal/openclaw/activity/conversation-access').send({ uid: 'member', channelId: scope.channelId }) };
}
beforeEach(() => authorize.mockReset().mockResolvedValue(scope));
describe('channel-scoped native Activity authority', () => {
  it('redeems once against the selected owner/agent without issuing a posting grant', async () => {
    const h = harness(); const result = await h.post();
    expect(result.status).toBe(200); expect(result.body).toMatchObject({ uid: 'member', expectedAgentId: scope.expectedAgentId, activityConversation: scope });
    expect(result.body.voiceGrant).toBeUndefined(); expect(h.set).not.toHaveBeenCalled(); expect(h.deleted).toHaveBeenCalledOnce();
    expect((await h.post()).status).toBe(401);
    expect(authorize).toHaveBeenCalledWith(expect.objectContaining({ uid: 'member', channelId: scope.channelId }));
  });
  it.each([{ ownerUid: 'foreign' }, { expectedAgentId: 'other' }, { sessionKey: 'forged' }, { channelId: 'bad' }, { extra: true }])('refuses forged persisted scope %j', async patch => {
    const h = harness(patch); expect((await h.post()).status).toBe(403); expect(h.deleted).not.toHaveBeenCalled();
  });
  it('rechecks membership and owner assignment before consuming the ticket', async () => {
    const h = harness(); authorize.mockResolvedValueOnce(null);
    expect((await h.post()).status).toBe(403); expect(h.deleted).not.toHaveBeenCalled();
    const moved = harness({}, 'b-moved'); expect((await moved.post()).status).toBe(403); expect(moved.deleted).not.toHaveBeenCalled();
  });
  it('keeps periodic access checks bound to this gateway', async () => {
    const h = harness(); expect((await h.access()).body).toEqual(scope);
    authorize.mockResolvedValueOnce({ ...scope, gatewayId: 'b-foreign' }); expect((await h.access()).status).toBe(403);
    authorize.mockResolvedValueOnce(null); expect((await h.access()).status).toBe(403);
  });
});
