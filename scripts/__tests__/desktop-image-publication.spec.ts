import { expect, it, vi } from 'vitest';
import { createDesktopPublicationCloud, planDesktopPublication, publishDesktopArtifact, type DesktopPublicationDeps } from '../lib/desktop-image-publication';
import type { GoogleAuth } from 'google-auth-library';
const artifact = { project: 'octogee-test', name: 'octogee-computer-fixture', id: '123', sourceSha: 'a'.repeat(40), inputFingerprint: 'b'.repeat(64), acceptance: 'resize-reboot-v1' };
const source = { name: artifact.name, id: artifact.id, status: 'READY', labels: { source: artifact.sourceSha, 'home-admission': 'retained-v1' } };
function cloud(): DesktopPublicationDeps {
  return {
    getImage: vi.fn().mockResolvedValue(source), copyImage: vi.fn(), setFamily: vi.fn(),
    resolveFamily: vi.fn().mockResolvedValue('octogee-computer-previous'),
  };
}
it('publishes an accepted TEST image without rebuilding or copying it', async () => {
  const deps = cloud();
  expect(await publishDesktopArtifact(artifact, 'test', deps)).toEqual({ project: 'octogee-test', image: artifact.name });
  expect(deps.copyImage).not.toHaveBeenCalled();
  expect(deps.setFamily).toHaveBeenCalledWith('octogee-test', artifact.name);
});
it('leaves the family alone when it already serves the image', async () => {
  const deps = cloud(); vi.mocked(deps.resolveFamily).mockResolvedValue(artifact.name);
  expect(await publishDesktopArtifact(artifact, 'test', deps)).toEqual({ project: 'octogee-test', image: artifact.name });
  expect(deps.setFamily).not.toHaveBeenCalled();
});
it('plans nothing when the family already serves the image', async () => {
  const deps = cloud(); vi.mocked(deps.resolveFamily).mockResolvedValue(artifact.name);
  expect(await planDesktopPublication(artifact, 'test', deps)).toEqual({ project: 'octogee-test', image: artifact.name, familyImage: artifact.name, unchanged: true });
  expect(deps.setFamily).not.toHaveBeenCalled(); expect(deps.copyImage).not.toHaveBeenCalled();
});
it('plans a publication when the family serves another image', async () => {
  expect(await planDesktopPublication(artifact, 'prod', cloud())).toMatchObject({ project: 'octogee', familyImage: 'octogee-computer-previous', unchanged: false });
});
it('plans a publication when the family is empty', async () => {
  const deps = cloud(); vi.mocked(deps.resolveFamily).mockResolvedValue(null);
  expect(await planDesktopPublication(artifact, 'test', deps)).toMatchObject({ familyImage: null, unchanged: false });
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
  expect(deps.setFamily).not.toHaveBeenCalled();
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
