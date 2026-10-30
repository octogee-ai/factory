import { expect, it, vi } from 'vitest';
import { createDesktopPublicationCloud, planDesktopPublication, publishDesktopArtifact, type DesktopPublicationDeps } from '../lib/desktop-image-publication';
import type { GoogleAuth } from 'google-auth-library';
const artifact = { project: 'octogee-test', name: 'octogee-computer-fixture', id: '123', sourceSha: 'a'.repeat(40), inputFingerprint: 'b'.repeat(64), acceptance: 'resize-reboot-v1' };
const source = { name: artifact.name, id: artifact.id, status: 'READY', labels: { source: artifact.sourceSha, 'home-admission': 'retained-v1' } };
function cloud(): DesktopPublicationDeps {
  return {
    getImage: vi.fn().mockResolvedValue(source), copyImage: vi.fn(), setFamily: vi.fn(),
    resolveFamily: vi.fn().mockResolvedValue('octogee-computer-previous'), staleWarmPool: vi.fn().mockResolvedValue([]), retirePool: vi.fn().mockResolvedValue(['spare']),
  };
}
it('publishes the family with no VM observation or mutation when Cowboy owns the pool', async () => {
  const deps = cloud();
  await expect(planDesktopPublication(artifact, 'test', deps, true)).resolves.toMatchObject({ staleWarmPool: [], unchanged: false });
  await expect(publishDesktopArtifact(artifact, 'test', deps, true)).resolves.toEqual({ project: 'octogee-test', image: artifact.name, retiring: [] });
  expect(deps.staleWarmPool).not.toHaveBeenCalled();
  expect(deps.retirePool).not.toHaveBeenCalled();
  expect(deps.setFamily).toHaveBeenCalledWith('octogee-test', artifact.name);
});
it('publishes an accepted TEST image without rebuilding or copying it', async () => {
  const deps = cloud();
  expect(await publishDesktopArtifact(artifact, 'test', deps)).toEqual({ project: 'octogee-test', image: artifact.name, retiring: ['spare'] });
  expect(deps.copyImage).not.toHaveBeenCalled();
  expect(deps.setFamily).toHaveBeenCalledWith('octogee-test', artifact.name);
});
it('leaves the family alone and only retires stale spares when it already serves the image', async () => {
  const deps = cloud(); vi.mocked(deps.resolveFamily).mockResolvedValue(artifact.name);
  expect(await publishDesktopArtifact(artifact, 'test', deps)).toEqual({ project: 'octogee-test', image: artifact.name, retiring: ['spare'] });
  expect(deps.setFamily).not.toHaveBeenCalled();
});
it('plans nothing when the family already serves the image and no warm spare is stale', async () => {
  const deps = cloud(); vi.mocked(deps.resolveFamily).mockResolvedValue(artifact.name);
  expect(await planDesktopPublication(artifact, 'test', deps)).toEqual({ project: 'octogee-test', image: artifact.name, familyImage: artifact.name, staleWarmPool: [], unchanged: true });
  expect(deps.staleWarmPool).toHaveBeenCalledWith('test', 'octogee-test', artifact.name);
  expect(deps.setFamily).not.toHaveBeenCalled(); expect(deps.retirePool).not.toHaveBeenCalled(); expect(deps.copyImage).not.toHaveBeenCalled();
});
it('plans a publication when the family serves another image', async () => {
  expect(await planDesktopPublication(artifact, 'prod', cloud())).toMatchObject({ project: 'octogee', familyImage: 'octogee-computer-previous', unchanged: false });
});
it('plans a publication when the family is empty', async () => {
  const deps = cloud(); vi.mocked(deps.resolveFamily).mockResolvedValue(null);
  expect(await planDesktopPublication(artifact, 'test', deps)).toMatchObject({ familyImage: null, unchanged: false });
});
it('plans a publication that retires stale warm spares left behind on an unchanged family', async () => {
  const deps = cloud(); vi.mocked(deps.resolveFamily).mockResolvedValue(artifact.name); vi.mocked(deps.staleWarmPool).mockResolvedValue(['old-spare']);
  expect(await planDesktopPublication(artifact, 'test', deps)).toMatchObject({ staleWarmPool: ['old-spare'], unchanged: false });
});
it('plans nothing for PROD only when the family serves a verified copy of the tested image', async () => {
  const deps = cloud(); vi.mocked(deps.resolveFamily).mockResolvedValue(artifact.name);
  vi.mocked(deps.getImage).mockResolvedValueOnce(source).mockResolvedValueOnce({ ...source, id: '456', sourceImageId: source.id });
  expect(await planDesktopPublication(artifact, 'prod', deps)).toMatchObject({ project: 'octogee', unchanged: true });
});
it.each([
  ['another source image', { ...source, id: '456', sourceImageId: '789' }],
  ['another source commit', { ...source, id: '456', sourceImageId: source.id, labels: { source: 'c'.repeat(40) } }],
])('refuses to plan PROD as unchanged when its family image is a copy of %s', async (_, copy) => {
  const deps = cloud(); vi.mocked(deps.resolveFamily).mockResolvedValue(artifact.name);
  vi.mocked(deps.getImage).mockResolvedValueOnce(source).mockResolvedValueOnce(copy);
  await expect(planDesktopPublication(artifact, 'prod', deps)).rejects.toThrow('not a copy');
});
it('does not plan when the tested image identity was replaced', async () => {
  const deps = cloud(); vi.mocked(deps.getImage).mockResolvedValue({ ...source, id: '456' });
  await expect(planDesktopPublication(artifact, 'test', deps)).rejects.toThrow('no longer matches');
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
it.each(['missing', 'different'])('rejects a PROD copy with %s native home admission before changing its family', async admission => {
  const deps = cloud();
  const copy = { ...source, id: '456', sourceImageId: source.id, labels: { source: artifact.sourceSha, ...(admission === 'different' ? { 'home-admission': 'unverified' } : {}) } };
  vi.mocked(deps.getImage).mockResolvedValueOnce(source).mockResolvedValueOnce(copy);
  await expect(publishDesktopArtifact(artifact, 'prod', deps)).rejects.toThrow('native home admission');
  expect(deps.setFamily).not.toHaveBeenCalled();
  expect(deps.retirePool).not.toHaveBeenCalled();
});
it('does not report PROD unchanged when its copy lost native home admission', async () => {
  const deps = cloud(); vi.mocked(deps.resolveFamily).mockResolvedValue(artifact.name);
  vi.mocked(deps.getImage).mockResolvedValueOnce(source).mockResolvedValueOnce({ ...source, id: '456', sourceImageId: source.id, labels: { source: artifact.sourceSha } });
  await expect(planDesktopPublication(artifact, 'prod', deps)).rejects.toThrow('native home admission');
});
it('preserves the tested image labels when copying its bytes to PROD', async () => {
  const labels = { ...source.labels, omarchy: '4-0-6', 'input-a': 'verified-input', purpose: 'octogee-computer' };
  const request = vi.fn(async (input: { url: string; method: string; data?: unknown }) => {
    if (input.url.endsWith(`/octogee-test/global/images/${artifact.name}`)) return { data: { ...source, labels } };
    if (input.url.endsWith('/octogee/global/images')) return { data: { name: 'copy-operation' } };
    if (input.url.endsWith('/octogee/global/operations/copy-operation')) return { data: { status: 'DONE' } };
    throw new Error(`Unexpected request ${input.url}`);
  });
  const auth = { getClient: async () => ({ request }) } as unknown as GoogleAuth;
  await createDesktopPublicationCloud(auth).copyImage(artifact.project, artifact.name, 'octogee', artifact.sourceSha);
  expect(request).toHaveBeenCalledWith(expect.objectContaining({
    method: 'POST', data: { name: artifact.name, sourceImage: `https://compute.googleapis.com/compute/v1/projects/${artifact.project}/global/images/${artifact.name}`, labels },
  }));
});

import { listDesktopPoolMembers, retireDesktopPool, staleDesktopPool, type DesktopPoolVm } from '../lib/desktop-image-publication';
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
it('reports stale unassigned members without mutating them', async () => {
  const assigned = poolVm(); assigned.labels['octogee-owner-uid'] = 'builder';
  const vms: Record<string, DesktopPoolVm> = { old: poolVm(), current: poolVm(), assigned };
  const images: Record<string, string> = { old: 'old', current: `https://www.googleapis.com/compute/v1/projects/${artifact.project}/global/images/${artifact.name}`, assigned: 'old' };
  const members = Object.keys(vms).map(name => ({ name, zone: 'us-central1-a' }));
  const stale = await staleDesktopPool('test', artifact.project, artifact.name, members, {
    readVm: async member => ({ ...vms[member.name], disks: [{ boot: true, source: member.name }] }),
    readDisk: async url => ({ sourceImage: images[url] }),
  });
  expect(stale.map(({ member }) => member.name)).toEqual(['old']);
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
