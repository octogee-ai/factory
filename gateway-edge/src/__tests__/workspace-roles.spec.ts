import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("../middleware/auth.js", () => ({ requireAuthenticatedUid: (req: { uid?: string }, _res: unknown, next: () => void) => { req.uid = "caller"; next(); } }));
import { createWorkspaceRolesRouter } from "../routes/workspace-roles.js";
const resolveIdentity = vi.fn();
const openClient = vi.fn();
const call = vi.fn();
const close = vi.fn();
function app() {
  const app = express(); app.use(express.json());
  app.use('/api/g/:gatewayId/workspace-roles', createWorkspaceRolesRouter({ resolveIdentity, openClient }));
  return app;
}
beforeEach(() => {
  vi.clearAllMocks(); vi.stubEnv('GATEWAY_CLASS', 'builder'); vi.stubEnv('OPENCLAW_CONTROL_IDENTITY', 'per-user');
  resolveIdentity.mockImplementation(async input => ({ uid: 'caller', gatewayId: 'bender', workspaceSlug: 'alice', targetUid: input.targetUid }));
  openClient.mockResolvedValue({ scopes: new Set(['operator.admin']), call, close });
});
afterEach(() => vi.unstubAllEnvs());
describe('native workspace role settings', () => {
  it('reads native assignments and updates as the caller without a membership role write', async () => {
    let role = 'member';
    call.mockImplementation(async (method, params) => {
      if (method === 'users.list') return { ok: true, result: { profiles: [{ id: 'native-member', emails: ['member'], role }] } };
      if (method === 'config.get') return { ok: true, result: { config: { gateway: { roles: { default: 'member', definitions: { member: {}, admin: {}, custom: {} } } } } } };
      if (method === 'users.setRole') { role = params.role; return { ok: true, result: { profile: { role } } }; }
      throw new Error('unexpected method');
    });
    expect((await request(app()).get('/api/g/bender/workspace-roles')).body).toMatchObject({ roles: ['member','admin','custom'], profiles: [{ role: 'member' }] });
    expect((await request(app()).patch('/api/g/bender/workspace-roles/member').send({ role: 'admin' })).body).toEqual({ role: 'admin' });
    expect(call).toHaveBeenCalledWith('users.setRole', { profileId: 'native-member', role: 'admin' });
    expect((await request(app()).get('/api/g/bender/workspace-roles')).body.profiles[0].role).toBe('admin');
    expect(openClient.mock.calls.every(([uid]) => uid === 'caller')).toBe(true);
  });
  it('preserves OpenClaw permission denials', async () => {
    call.mockResolvedValue({ ok: false, reason: 'missing scope: operator.admin' });
    const res = await request(app()).patch('/api/g/bender/workspace-roles/member').send({ role: 'admin' });
    expect(res.status).toBe(403); expect(res.body.error).toContain('operator.admin');
    expect(call).not.toHaveBeenCalledWith('users.setRole', expect.anything());
  });
  it('does not show role management when native scopes lack admin', async () => {
    openClient.mockResolvedValueOnce({ scopes: new Set(['operator.read']), call, close });
    expect((await request(app()).get('/api/g/bender/workspace-roles')).body.canManageRoles).toBe(false);
    expect(call).not.toHaveBeenCalled();
  });
  it('never reaches the broker or runtime on a shared gateway', async () => {
    vi.stubEnv('GATEWAY_CLASS', 'shared');
    expect((await request(app()).get('/api/g/bender/workspace-roles')).status).toBe(404);
    expect(resolveIdentity).not.toHaveBeenCalled(); expect(openClient).not.toHaveBeenCalled();
  });
  it('confirms self-demotion through a new native connection after OpenClaw disconnects the caller', async () => {
    let role = 'admin';
    call.mockImplementation(async (method, params) => {
      if (method === 'users.list') return { ok: true, result: { profiles: [{ id: 'self', emails: ['caller'], role }] } };
      if (method === 'users.setRole') { role = params.role; return { ok: false, reason: 'upstream-ws-closed' }; }
      throw new Error('unexpected method');
    });
    const res = await request(app()).patch('/api/g/bender/workspace-roles/caller').send({ role: 'member' });
    expect(res.status).toBe(200); expect(res.body).toEqual({ role: 'member' });
    expect(openClient).toHaveBeenCalledTimes(2);
    expect(openClient.mock.calls.every(([uid]) => uid === 'caller')).toBe(true);
    expect(call.mock.calls.filter(([method]) => method === 'users.setRole')).toHaveLength(1);
  });
});
