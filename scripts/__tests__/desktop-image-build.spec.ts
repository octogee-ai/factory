import { expect, it, vi } from 'vitest';
import { ensureDesktopImage, desktopFingerprint, resolveDesktopGatewayImage } from '../../.github/actions/release-digest-manifest/build-desktop-image.mjs';
const fingerprint = 'b'.repeat(64), sourceSha = 'a'.repeat(40);
const name = `octogee-computer-${fingerprint.slice(0, 24)}`;
const image = { name, id: '123', status: 'READY', labels: { source: sourceSha, 'input-a': fingerprint.slice(0, 32), 'input-b': fingerprint.slice(32) } };
const artifact = { project: TEST_TARGET.clusterProjectId, name, id: '123', sourceSha, inputFingerprint: fingerprint, acceptance: 'boot-smoke-v1' };
it('reuses a tested input fingerprint without another build or test VM', async () => {
  const build = vi.fn(), accept = vi.fn(), save = vi.fn();
  expect(await ensureDesktopImage({ fingerprint, sourceSha: 'c'.repeat(40), cached: artifact, readImage: async () => image, build, accept, save })).toEqual(artifact);
  expect(build).not.toHaveBeenCalled(); expect(accept).not.toHaveBeenCalled(); expect(save).not.toHaveBeenCalled();
});
it('saves the artifact only after successful fresh-VM acceptance', async () => {
  const order: string[] = [];
  const readImage = vi.fn().mockResolvedValueOnce(null).mockResolvedValue(image);
  await ensureDesktopImage({ fingerprint, sourceSha, cached: null, readImage, build: () => { order.push('build'); }, accept: () => { order.push('accept'); }, save: () => { order.push('save'); } });
  expect(order).toEqual(['build', 'accept', 'save']);
});
it('never publishes an artifact for a failed acceptance', async () => {
  const save = vi.fn();
  await expect(ensureDesktopImage({ fingerprint, sourceSha, cached: null, readImage: async () => image, build: vi.fn(), accept: () => { throw new Error('resize failed'); }, save })).rejects.toThrow('resize failed');
  expect(save).not.toHaveBeenCalled();
});

it('retests an uncached candidate with the same inputs after a later main commit', async () => {
  const build = vi.fn(), accept = vi.fn(), save = vi.fn();
  expect(await ensureDesktopImage({ fingerprint, sourceSha: 'c'.repeat(40), cached: null, readImage: async () => image, build, accept, save })).toEqual(artifact);
  expect(build).not.toHaveBeenCalled(); expect(accept).toHaveBeenCalledWith(name);
});

const settle = { sleep: async () => {} };
it('waits for a PENDING candidate to become READY instead of building or failing', async () => {
  const readImage = vi.fn().mockResolvedValueOnce({ ...image, status: 'PENDING' }).mockResolvedValueOnce({ ...image, status: 'PENDING' }).mockResolvedValue(image);
  const build = vi.fn(), remove = vi.fn(), accept = vi.fn(), save = vi.fn();
  expect(await ensureDesktopImage({ fingerprint, sourceSha, cached: null, readImage, build, remove, accept, save, ...settle })).toEqual(artifact);
  expect(build).not.toHaveBeenCalled(); expect(remove).not.toHaveBeenCalled(); expect(accept).toHaveBeenCalledWith(name);
});
it('deletes a FAILED candidate, waits for it to disappear, and builds a fresh one', async () => {
  const order: string[] = [];
  const readImage = vi.fn().mockResolvedValueOnce({ ...image, status: 'FAILED' }).mockResolvedValueOnce({ ...image, status: 'FAILED' }).mockResolvedValueOnce({ ...image, status: 'DELETING' }).mockResolvedValueOnce(null).mockResolvedValue(image);
  await ensureDesktopImage({ fingerprint, sourceSha, cached: null, readImage, remove: () => { order.push('remove'); }, build: () => { order.push('build'); }, accept: () => { order.push('accept'); }, save: () => { order.push('save'); }, ...settle });
  expect(order).toEqual(['remove', 'build', 'accept', 'save']);
});
it('still rejects a READY candidate whose labels do not match the inputs', async () => {
  const build = vi.fn(), remove = vi.fn();
  const mismatched = { ...image, labels: { ...image.labels, 'input-b': 'c'.repeat(32) } };
  await expect(ensureDesktopImage({ fingerprint, sourceSha, cached: null, readImage: async () => mismatched, build, remove, accept: vi.fn(), save: vi.fn(), ...settle })).rejects.toThrow('candidate does not match');
  expect(build).not.toHaveBeenCalled(); expect(remove).not.toHaveBeenCalled();
});
it('gives up on a candidate that never leaves PENDING before the deadline', async () => {
  let clock = 0;
  const readImage = vi.fn().mockResolvedValue({ ...image, status: 'PENDING' });
  await expect(ensureDesktopImage({ fingerprint, sourceSha, cached: null, readImage, build: vi.fn(), remove: vi.fn(), accept: vi.fn(), save: vi.fn(), sleep: async (ms: number) => { clock += ms; }, now: () => clock })).rejects.toThrow('PENDING');
  expect(readImage.mock.calls.length).toBeGreaterThan(1);
});

import { cleanupCandidates } from '../../.github/actions/release-digest-manifest/build-desktop-image.mjs';
import { TEST_TARGET } from "./fixtures/deployment.js";
it('cleanup excludes operator VMs and other active CI runs', () => {
  const vm = (run: string) => ({ labels: { 'octogee-image-run': run, purpose: 'octogee-computer-test' }, creationTimestamp: '2026-09-07T00:00:00Z' });
  const mine = vm('123-1');
  expect(cleanupCandidates([mine, vm('manual'), vm('124-1')], '123-1', false)).toEqual([mine]);
});
it('abandoned-run cleanup preserves recent VMs and rejects unexpected purposes', () => {
  const old = { labels: { 'octogee-image-run': '123-1', purpose: 'octogee-computer-image-build' }, creationTimestamp: '2026-09-07T00:00:00Z' };
  const recent = { ...old, creationTimestamp: '2026-09-07T02:30:00Z' };
  expect(cleanupCandidates([old, recent], '124-1', true, Date.parse('2026-09-07T03:00:00Z'))).toEqual([old]);
  expect(() => cleanupCandidates([{ ...old, labels: { ...old.labels, purpose: 'assigned-vm' } }], '123-1', false)).toThrow('refusing');
});

const repository = 'us-central1-docker.pkg.dev/octogee/octogee';
const gatewayDigest = `sha256:${'e'.repeat(64)}`;
const edgeImage = `${repository}/gateway-edge@sha256:${'d'.repeat(64)}`;
it('includes the immutable gateway digest in the desktop fingerprint', () => {
  const files = () => '../infra/desktop/image/rootfs/usr/local/bin/octo-home-disk\0';
  const first = desktopFingerprint(`${repository}/octogee-gateway-builder@${gatewayDigest}`, edgeImage, files);
  expect(first).toBe(desktopFingerprint(`${repository}/octogee-gateway-builder@${gatewayDigest}`, edgeImage, files));
  expect(first).not.toBe(desktopFingerprint(`${repository}/octogee-gateway-builder@${gatewayDigest}`, `${repository}/gateway-edge@sha256:${'f'.repeat(64)}`, files));
  expect(first).not.toBe(desktopFingerprint(`${repository}/octogee-gateway-builder@sha256:${'f'.repeat(64)}`, edgeImage, files));
});
it('resolves the exact main isolated image after gateway builds finish', () => {
  const lookup = vi.fn(() => gatewayDigest);
  const baseline = vi.fn();
  expect(resolveDesktopGatewayImage({ repository, project: 'octogee', sourceSha, baseSha: 'c'.repeat(40), changedGateway: true }, lookup, baseline))
    .toBe(`${repository}/octogee-gateway-builder@${gatewayDigest}`);
  expect(baseline).not.toHaveBeenCalled();
});
it('uses only the named baseline digest when the gateway scope was unchanged and the exact tag is absent', () => {
  const absent = () => { throw Object.assign(new Error('absent'), { status: 3 }); };
  const baseline = vi.fn(() => ({ surfaces: { gateway: { 'octogee-gateway-builder': gatewayDigest } } }));
  expect(resolveDesktopGatewayImage({ repository, project: 'octogee', sourceSha, baseSha: 'c'.repeat(40), changedGateway: false }, absent, baseline))
    .toBe(`${repository}/octogee-gateway-builder@${gatewayDigest}`);
  expect(baseline).toHaveBeenCalledWith('c'.repeat(40));
});
it.each([true, false])('does not hide registry auth/network errors behind a baseline (changed=%s)', changedGateway => {
  const baseline = vi.fn();
  expect(() => resolveDesktopGatewayImage({ repository, project: 'octogee', sourceSha, baseSha: 'c'.repeat(40), changedGateway }, () => { throw Object.assign(new Error('denied'), { status: 1 }); }, baseline)).toThrow('denied');
  expect(baseline).not.toHaveBeenCalled();
});
it('refuses a missing exact image for a changed gateway scope or a malformed baseline digest', () => {
  const absent = () => { throw Object.assign(new Error('absent'), { status: 3 }); };
  const baseline = vi.fn(() => ({ surfaces: { gateway: { 'octogee-gateway-builder': 'latest' } } }));
  expect(() => resolveDesktopGatewayImage({ repository, project: 'octogee', sourceSha, baseSha: 'c'.repeat(40), changedGateway: true }, absent, baseline)).toThrow('exact');
  expect(baseline).not.toHaveBeenCalled();
  expect(() => resolveDesktopGatewayImage({ repository, project: 'octogee', sourceSha, baseSha: 'c'.repeat(40), changedGateway: false }, absent, baseline)).toThrow('digest');
});
