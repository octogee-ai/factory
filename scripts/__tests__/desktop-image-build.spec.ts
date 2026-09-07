import { expect, it, vi } from 'vitest';
import { ensureDesktopImage } from '../../.github/actions/release-digest-manifest/build-desktop-image.mjs';
const fingerprint = 'b'.repeat(64), sourceSha = 'a'.repeat(40);
const name = `octogee-computer-${fingerprint.slice(0, 24)}`;
const image = { name, id: '123', status: 'READY', labels: { source: sourceSha, 'input-a': fingerprint.slice(0, 32), 'input-b': fingerprint.slice(32) } };
const artifact = { project: 'octogee-test', name, id: '123', sourceSha, inputFingerprint: fingerprint, acceptance: 'resize-reboot-v1' };
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

import { cleanupCandidates } from '../../.github/actions/release-digest-manifest/build-desktop-image.mjs';
it('cleanup excludes operator VMs and other active CI runs', () => {
  const vm = (run: string) => ({ labels: { 'octogee-image-run': run, purpose: 'octogee-computer-test' }, creationTimestamp: '2026-09-07T00:00:00Z' });
  const mine = vm('123-1');
  expect(cleanupCandidates([mine, vm('manual'), vm('124-1')], '123-1', false)).toEqual([mine]);
});
it('abandoned-run cleanup preserves recent VMs and rejects unexpected purposes', () => {
  const old = { labels: { 'octogee-image-run': '123-1', purpose: 'octogee-computer-image-build' }, creationTimestamp: '2026-09-07T00:00:00Z' };
  const recent = { ...old, creationTimestamp: '2026-09-07T02:30:00Z' };
  expect(cleanupCandidates([old, recent], '124-1', true, Date.parse('2026-09-07T03:00:00Z'))).toEqual([old]);
  expect(() => cleanupCandidates([{ ...old, labels: { ...old.labels, purpose: 'assigned-computer' } }], '123-1', false)).toThrow('refusing');
});
