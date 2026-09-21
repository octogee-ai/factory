import { beforeEach, describe, expect, it, vi } from "vitest";
const h = vi.hoisted(() => ({ resolve: vi.fn(), open: vi.fn(), close: vi.fn() }));
vi.mock("./workspace-native-access.js", async importOriginal => ({ ...await importOriginal<typeof import('./workspace-native-access.js')>(), resolveWorkspaceNativeIdentity: h.resolve }));
vi.mock("../openclaw-control/native-user-client.js", () => ({ openNativeUserClient: h.open }));
import { WorkspaceNativeAccessError } from "./workspace-native-access.js";
import { resolveNativeAdminAccess } from "./native-admin-access.js";
const args = { gatewayId: 'b-alice', authorization: 'Bearer user' };
beforeEach(() => { vi.clearAllMocks(); h.resolve.mockResolvedValue({ uid: 'member', gatewayId: 'b-alice', workspaceSlug: 'alice' }); });
describe('native admin permissions', () => {
  it('uses live OpenClaw scopes and loses admin access immediately after native demotion', async () => {
    h.open.mockResolvedValueOnce({ scopes: new Set(['operator.admin']), close: h.close });
    expect(await resolveNativeAdminAccess(args)).toEqual({ kind: 'allowed', gatewayId: 'b-alice', workspaceSlug: 'alice', canControl: true });
    h.open.mockResolvedValueOnce({ scopes: new Set(['operator.read', 'operator.write']), close: h.close });
    expect(await resolveNativeAdminAccess(args)).toEqual({ kind: 'forbidden' });
    expect(h.open).toHaveBeenCalledTimes(2); expect(h.close).toHaveBeenCalledTimes(2);
  });
  it.each([[401,'unauthenticated'],[403,'forbidden'],[404,'not_found']] as const)('never reaches the native gateway after broker status %s', async (status, kind) => {
    h.resolve.mockRejectedValueOnce(new WorkspaceNativeAccessError(status, 'denied'));
    expect(await resolveNativeAdminAccess(args)).toEqual({ kind }); expect(h.open).not.toHaveBeenCalled();
  });
  it('fails loudly when effective native permissions cannot be loaded', async () => {
    h.open.mockRejectedValueOnce(new Error('native unavailable'));
    await expect(resolveNativeAdminAccess(args)).rejects.toThrow('native unavailable');
  });
});
