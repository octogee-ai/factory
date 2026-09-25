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

import { listDesktopPoolMembers, retireDesktopPool, type DesktopPoolVm } from '../lib/desktop-image-publication';
const spare = { name: 'spare', zone: 'us-central1-c' };
function poolVm(): DesktopPoolVm {
  return { labels: { 'octogee-environment': 'test', 'octogee-pool': 'warm' }, labelFingerprint: 'observed', disks: [{ boot: true, source: 'disk-url' }] };
}
it.each(['octogee-owner-uid', 'octogee-gateway-id'])('preserves a warm member with assignment label %s', async key => {
  const vm = poolVm(); vm.labels[key] = 'assigned';
  const markRetiring = vi.fn();
  expect(await retireDesktopPool('test', artifact.project, artifact.name, [spare], { readVm: async () => vm, readDisk: vi.fn(), markRetiring })).toEqual([]);
  expect(markRetiring).not.toHaveBeenCalled();
});
it.each(['gateway-id', 'octogee-owner-uid'])('preserves a warm member with assignment metadata %s', async key => {
  const vm = poolVm(); vm.metadata = { items: [{ key, value: 'assigned' }] };
  const markRetiring = vi.fn();
  await retireDesktopPool('test', artifact.project, artifact.name, [spare], { readVm: async () => vm, readDisk: vi.fn(), markRetiring });
  expect(markRetiring).not.toHaveBeenCalled();
});
it('retires only stale unassigned members using the freshly read fingerprint', async () => {
  const vm = poolVm(), markRetiring = vi.fn();
  const deps = { readVm: async () => vm, readDisk: vi.fn().mockResolvedValueOnce({ sourceImage: 'old' }).mockResolvedValueOnce({ sourceImage: `https://www.googleapis.com/compute/v1/projects/${artifact.project}/global/images/${artifact.name}` }), markRetiring };
  const old = { name: 'old', zone: 'us-central1-a' }, current = { name: 'current', zone: 'us-central1-f' };
  expect(await retireDesktopPool('test', artifact.project, artifact.name, [old, current], deps)).toEqual(['old']);
  expect(markRetiring).toHaveBeenCalledExactlyOnceWith(old, vm);
});
it('preserves a member claimed concurrently and surfaces other failures', async () => {
  const deps = { readVm: async () => poolVm(), readDisk: async () => ({ sourceImage: 'old' }), markRetiring: vi.fn().mockRejectedValue({ response: { status: 412 } }) };
  expect(await retireDesktopPool('test', artifact.project, artifact.name, [spare], deps)).toEqual([]);
  deps.markRetiring.mockRejectedValue(new Error('API unavailable'));
  await expect(retireDesktopPool('test', artifact.project, artifact.name, [spare], deps)).rejects.toThrow('API unavailable');
});
it('reads and retires each member in its own zone', async () => {
  const readVm = vi.fn(async () => poolVm()), markRetiring = vi.fn();
  await retireDesktopPool('test', artifact.project, artifact.name, [spare], { readVm, readDisk: async () => ({ sourceImage: 'old' }), markRetiring });
  expect(readVm).toHaveBeenCalledExactlyOnceWith(spare);
  expect(markRetiring).toHaveBeenCalledExactlyOnceWith(spare, expect.anything());
});
it('lists warm members of the environment across every zone and page of the aggregated listing', async () => {
  const at = (zone: string, name: string) => ({ name, zone: `https://www.googleapis.com/compute/v1/projects/octogee/zones/${zone}` });
  const fetchPage = vi.fn(async (filter: string, pageToken: string) => pageToken === 'p2'
    ? { items: { 'zones/us-central1-f': { instances: [at('us-central1-f', 'octogee-pool-f')] } } }
    : { items: { 'zones/us-central1-a': { instances: [at('us-central1-a', 'octogee-pool-a')] }, 'zones/us-central1-b': { warning: { code: 'NO_RESULTS_ON_PAGE' } } }, nextPageToken: 'p2' });
  expect(await listDesktopPoolMembers('test', fetchPage)).toEqual([{ name: 'octogee-pool-a', zone: 'us-central1-a' }, { name: 'octogee-pool-f', zone: 'us-central1-f' }]);
  expect(fetchPage).toHaveBeenNthCalledWith(1, 'labels.octogee-environment = test AND labels.octogee-pool = warm', '');
  expect(fetchPage).toHaveBeenNthCalledWith(2, 'labels.octogee-environment = test AND labels.octogee-pool = warm', 'p2');
});

import { selectDesktopFamily } from '../lib/desktop-image-publication';
it('selects an older image for rollback while retaining newer images in a valid archive family', async () => {
  const families = new Map([['older', 'octogee-computer-archive'], ['newer', 'octogee-computer']]);
  const members = () => [...families].filter(([, family]) => family === 'octogee-computer').map(([name]) => name);
  await selectDesktopFamily('older', {
    listMembers: async () => members(),
    setFamily: async (name, family) => {
      if (!/^[a-z](?:[-a-z0-9]{0,61}[a-z0-9])?$/.test(family)) throw new Error('Invalid GCE image family');
      families.set(name, family);
    },
    resolveFamily: async () => ({ name: members().at(-1)! }),
  });
  expect([...families]).toEqual([['older', 'octogee-computer'], ['newer', 'octogee-computer-archive']]);
});
it('fails publication if the family resolves to a different image', async () => {
  await expect(selectDesktopFamily('selected', { listMembers: async () => [], setFamily: vi.fn(), resolveFamily: async () => ({ name: 'concurrent' }) })).rejects.toThrow('does not resolve');
});
