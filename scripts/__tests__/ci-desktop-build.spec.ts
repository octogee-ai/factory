import { expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { desktopBuild, validateDesktopRelease, waitForMainBuild } from '../ci/desktop-build.mjs';
import { publishDesktopRelease } from '../ci/publish-desktop.mjs';

const sha = 'a'.repeat(40);
const digest = `sha256:${'b'.repeat(64)}`;
const gatewayDigest = `sha256:${'c'.repeat(64)}`;
const build = { digest, manifest: { sourceSha: sha, surfaces: { gateway: { 'octogee-gateway-builder': gatewayDigest } } } };
const artifact = { project: 'octogee-test', name: 'octogee-computer-fixture', id: '123', sourceSha: 'd'.repeat(40), inputFingerprint: 'e'.repeat(64), acceptance: 'resize-reboot-v1' };
const record = { schemaVersion: 1, sourceSha: sha, manifestDigest: digest, gatewayDigest, desktopImage: artifact };
const options = { sourceSha: sha, checkoutSha: sha, branch: 'main', clean: true, actions: true, runId: '123-2' };
function dependencies() {
  return {
    main: vi.fn(async () => build),
    lock: vi.fn(async (task: () => Promise<unknown>) => task()),
    lookup: vi.fn(async () => null),
    desktop: vi.fn(async () => artifact),
    publish: vi.fn(async () => ({ desktopImage: artifact, digest: `sha256:${'f'.repeat(64)}` })),
  };
}
it('publishes the desktop image with the same immutable main build selected before construction', async () => {
  const deps = dependencies();
  await desktopBuild(options, deps);
  expect(deps.main).toHaveBeenCalledOnce();
  expect(deps.desktop).toHaveBeenCalledWith(build);
  expect(deps.publish).toHaveBeenCalledExactlyOnceWith(record, build);
  expect(deps.publish.mock.invocationCallOrder[0]).toBeGreaterThan(deps.desktop.mock.invocationCallOrder[0]);
});
it('reuses an existing immutable desktop companion without rebuilding or rewriting it', async () => {
  const deps = dependencies();
  const existing = { desktopImage: artifact, digest };
  deps.lookup.mockResolvedValue(existing as never);
  await expect(desktopBuild(options, deps)).resolves.toEqual(existing);
  expect(deps.desktop).not.toHaveBeenCalled();
  expect(deps.publish).not.toHaveBeenCalled();
});
it.each([{ actions: false }, { branch: 'topic' }, { clean: false }, { checkoutSha: 'd'.repeat(40) }, { runId: 'local-123' }])('rejects desktop construction outside the explicit main Actions job: %j', async invalid => {
  const deps = dependencies();
  await expect(desktopBuild({ ...options, ...invalid }, deps)).rejects.toThrow();
  expect(deps.main).not.toHaveBeenCalled();
});
it.each(['main', 'desktop'] as const)('never publishes a desktop companion after %s fails', async step => {
  const deps = dependencies();
  deps[step].mockRejectedValue(new Error('failed'));
  await expect(desktopBuild(options, deps)).rejects.toThrow('failed');
  expect(deps.publish).not.toHaveBeenCalled();
});
it.each([{ sourceSha: 'f'.repeat(40) }, { manifestDigest: `sha256:${'f'.repeat(64)}` }, { gatewayDigest: `sha256:${'f'.repeat(64)}` }, { desktopImage: { ...artifact, acceptance: 'unchecked' } }])('rejects a desktop companion substituted for a different accepted build: %j', invalid => {
  expect(() => validateDesktopRelease({ ...record, ...invalid }, build)).toThrow();
});
it('binds reused accepted desktop inputs to the selected build without changing their original provenance', () => {
  expect(validateDesktopRelease(record, build)).toEqual(record);
});
it('waits for automatic main publication without starting a platform build on Actions', async () => {
  const read = vi.fn().mockRejectedValueOnce({ status: 404 }).mockResolvedValue(build);
  const sleep = vi.fn();
  await expect(waitForMainBuild(sha, { read, sleep })).resolves.toEqual(build);
  expect(read).toHaveBeenCalledTimes(2);
  expect(sleep).toHaveBeenCalledWith(30_000);
});
it('fails main publication waiting on denied access or a bounded timeout', async () => {
  const sleep = vi.fn();
  await expect(waitForMainBuild(sha, { read: async () => { throw new Error('denied'); }, sleep })).rejects.toThrow('denied');
  expect(sleep).not.toHaveBeenCalled();
  await expect(waitForMainBuild(sha, { read: async () => { throw { status: 404 }; }, sleep, timeout: 0 })).rejects.toThrow('ci:submit main');
});
it('rejects a conflicting existing desktop companion before any registry write', async () => {
  const run = vi.fn();
  await expect(publishDesktopRelease(record, build, '/unused', { read: async () => ({ ...record, desktopImage: { ...artifact, id: '456' } }), run })).rejects.toThrow('differs');
  expect(run).not.toHaveBeenCalled();
});
it('publishes once and verifies the registry artifact before reporting success', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'desktop-companion-test-'));
  const run = vi.fn();
  const read = vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce(record);
  try {
    await expect(publishDesktopRelease(record, build, directory, { read, run })).resolves.toEqual(record);
    expect(run.mock.calls.map(([, args]) => args[0])).toEqual(['build', 'push']);
    expect(run.mock.calls[1][1]).toEqual(['push', `us-central1-docker.pkg.dev/octogee/octogee/desktop-image-manifest:${sha}`]);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
it('fails when the written companion cannot be read back unchanged', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'desktop-companion-test-'));
  try {
    await expect(publishDesktopRelease(record, build, directory, { read: vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce({ ...record, desktopImage: { ...artifact, id: '456' } }), run: vi.fn() })).rejects.toThrow('differs');
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
