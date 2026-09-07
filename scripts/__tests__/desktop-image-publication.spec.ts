import { expect, it, vi } from 'vitest';
import { publishDesktopArtifact, type DesktopPublicationDeps } from '../lib/desktop-image-publication';
const artifact = { project: 'octogee-test', name: 'octogee-computer-fixture', id: '123', sourceSha: 'a'.repeat(40), inputFingerprint: 'b'.repeat(64), acceptance: 'resize-reboot-v1' };
const source = { name: artifact.name, id: artifact.id, status: 'READY', labels: { source: artifact.sourceSha } };
function cloud(): DesktopPublicationDeps {
  return { getImage: vi.fn().mockResolvedValue(source), copyImage: vi.fn(), setFamily: vi.fn(), retirePool: vi.fn().mockResolvedValue(['spare']) };
}
it('publishes an accepted TEST image without rebuilding or copying it', async () => {
  const deps = cloud();
  expect(await publishDesktopArtifact(artifact, 'test', deps)).toEqual({ project: 'octogee-test', image: artifact.name, retiring: ['spare'] });
  expect(deps.copyImage).not.toHaveBeenCalled();
  expect(deps.setFamily).toHaveBeenCalledWith('octogee-test', artifact.name);
});
it('does not publish when the tested image identity was replaced', async () => {
  const deps = cloud(); vi.mocked(deps.getImage).mockResolvedValue({ ...source, id: '456' });
  await expect(publishDesktopArtifact(artifact, 'test', deps)).rejects.toThrow('no longer matches');
  expect(deps.setFamily).not.toHaveBeenCalled(); expect(deps.retirePool).not.toHaveBeenCalled();
});
it('copies the same accepted image to PROD and verifies its origin before publishing', async () => {
  const deps = cloud();
  vi.mocked(deps.getImage).mockResolvedValueOnce(source).mockResolvedValueOnce(null).mockResolvedValueOnce({ ...source, id: '456', sourceImageId: source.id });
  await publishDesktopArtifact(artifact, 'prod', deps);
  expect(deps.copyImage).toHaveBeenCalledWith('octogee-test', artifact.name, 'octogee', artifact.sourceSha);
  expect(deps.setFamily).toHaveBeenCalledWith('octogee', artifact.name);
});
it('rejects a destination image copied from another source', async () => {
  const deps = cloud(); vi.mocked(deps.getImage).mockResolvedValueOnce(source).mockResolvedValueOnce({ ...source, sourceImageId: '789' });
  await expect(publishDesktopArtifact(artifact, 'prod', deps)).rejects.toThrow('not a copy');
  expect(deps.setFamily).not.toHaveBeenCalled();
});

import { retireDesktopPool, type DesktopPoolVm } from '../lib/desktop-image-publication';
function poolVm(): DesktopPoolVm {
  return { labels: { 'octogee-environment': 'test', 'octogee-pool': 'warm' }, labelFingerprint: 'observed', disks: [{ boot: true, source: 'disk-url' }] };
}
it.each(['octogee-owner-uid', 'octogee-gateway-id'])('preserves a warm member with assignment label %s', async key => {
  const vm = poolVm(); vm.labels[key] = 'assigned';
  const markRetiring = vi.fn();
  expect(await retireDesktopPool('test', artifact.project, artifact.name, ['spare'], { readVm: async () => vm, readDisk: vi.fn(), markRetiring })).toEqual([]);
  expect(markRetiring).not.toHaveBeenCalled();
});
it.each(['gateway-id', 'octogee-owner-uid'])('preserves a warm member with assignment metadata %s', async key => {
  const vm = poolVm(); vm.metadata = { items: [{ key, value: 'assigned' }] };
  const markRetiring = vi.fn();
  await retireDesktopPool('test', artifact.project, artifact.name, ['spare'], { readVm: async () => vm, readDisk: vi.fn(), markRetiring });
  expect(markRetiring).not.toHaveBeenCalled();
});
it('retires only stale unassigned members using the freshly read fingerprint', async () => {
  const vm = poolVm(), markRetiring = vi.fn();
  const deps = { readVm: async () => vm, readDisk: vi.fn().mockResolvedValueOnce({ sourceImage: 'old' }).mockResolvedValueOnce({ sourceImage: `https://www.googleapis.com/compute/v1/projects/${artifact.project}/global/images/${artifact.name}` }), markRetiring };
  expect(await retireDesktopPool('test', artifact.project, artifact.name, ['old', 'current'], deps)).toEqual(['old']);
  expect(markRetiring).toHaveBeenCalledExactlyOnceWith('old', vm);
});
it('preserves a member claimed concurrently and surfaces other failures', async () => {
  const deps = { readVm: async () => poolVm(), readDisk: async () => ({ sourceImage: 'old' }), markRetiring: vi.fn().mockRejectedValue({ response: { status: 412 } }) };
  expect(await retireDesktopPool('test', artifact.project, artifact.name, ['spare'], deps)).toEqual([]);
  deps.markRetiring.mockRejectedValue(new Error('API unavailable'));
  await expect(retireDesktopPool('test', artifact.project, artifact.name, ['spare'], deps)).rejects.toThrow('API unavailable');
});

import { selectDesktopFamily } from '../lib/desktop-image-publication';
it('selects an older image for rollback by removing newer images from the family', async () => {
  const setFamily = vi.fn();
  await selectDesktopFamily('older', { listMembers: async () => ['older', 'newer'], setFamily, resolveFamily: async () => ({ name: 'older' }) });
  expect(setFamily.mock.calls).toEqual([['older', 'octogee-computer'], ['newer', '']]);
});
it('fails publication if the family resolves to a different image', async () => {
  await expect(selectDesktopFamily('selected', { listMembers: async () => [], setFamily: vi.fn(), resolveFamily: async () => ({ name: 'concurrent' }) })).rejects.toThrow('does not resolve');
});
