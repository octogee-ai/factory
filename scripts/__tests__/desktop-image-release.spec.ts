import type { Firestore } from 'firebase-admin/firestore';
import { GoogleAuth } from 'google-auth-library';
import { afterEach, expect, it, vi } from 'vitest';
import { createCentralReleaseAuthority } from '@octogee/core/artifact-registry';
import { runWithOperationAuditIntent } from '@octogee/core/operation-audit';
import { runDesktopImagePublication } from '../lib/desktop-image-publication';
import * as releaseSource from '../lib/desktop-image-release.mjs';

vi.mock('@octogee/core/artifact-registry', () => ({ createCentralReleaseAuthority: vi.fn() }));
vi.mock('@octogee/core/operation-audit', () => ({ runWithOperationAuditIntent: vi.fn() }));

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

function publication(desktopImage?: unknown) {
  const resolveManifest = vi.fn().mockResolvedValue({ sourceSha: 'a'.repeat(40), manifestDigest: `sha256:${'b'.repeat(64)}`, desktopImage });
  vi.mocked(createCentralReleaseAuthority).mockReturnValue({ resolveManifest } as unknown as ReturnType<typeof createCentralReleaseAuthority>);
  const input = {
    environment: 'test' as const, sourceSha: 'a'.repeat(40), apply: true, actor: 'fixture', why: 'fixture',
    db: {} as Firestore, auth: new GoogleAuth(),
  };
  const client = vi.spyOn(input.auth, 'getClient').mockRejectedValue(new Error('unexpected Compute request'));
  const auth = vi.spyOn(input.auth, 'getAccessToken').mockResolvedValue('fixture-token');
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 404 })));
  return { input, client, auth, log, resolveManifest };
}

it('skips desktop publication for a platform build without an artifact when allowed', async () => {
  const { input, client, auth, log } = publication();
  await runDesktopImagePublication({ ...input, skipMissing: true });
  expect(log).toHaveBeenCalledWith(expect.stringContaining('no desktop image; skipping publication'));
  expect(client).not.toHaveBeenCalled();
  expect(auth).toHaveBeenCalledOnce();
  expect(runWithOperationAuditIntent).not.toHaveBeenCalled();
});

it('keeps an explicit Fleet publication strict when the build has no desktop artifact', async () => {
  const { input, client } = publication();
  await expect(runDesktopImagePublication(input)).rejects.toThrow('has no accepted desktop image');
  expect(client).not.toHaveBeenCalled();
});

it('does not skip a desktop companion whose registry lookup is denied', async () => {
  const { input, client } = publication();
  vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 403 })));
  await expect(runDesktopImagePublication({ ...input, skipMissing: true })).rejects.toThrow('lookup failed: 403');
  expect(client).not.toHaveBeenCalled();
});

it('plans an accepted desktop companion even when main was published without a desktop image', async () => {
  const artifact = { project: 'octogee-test', name: 'octogee-computer-fixture', id: '123', sourceSha: 'a'.repeat(40), inputFingerprint: 'b'.repeat(64), acceptance: 'resize-reboot-v1' as const };
  const { input, client, log } = publication();
  vi.spyOn(releaseSource, 'resolveDesktopRelease').mockResolvedValue({ desktopImage: artifact, digest: `sha256:${'c'.repeat(64)}` });
  const request = vi.fn()
    .mockResolvedValueOnce({ data: { name: artifact.name, id: artifact.id, status: 'READY', labels: { source: artifact.sourceSha } } })
    .mockResolvedValueOnce({ data: { name: artifact.name } });
  client.mockResolvedValue({ request } as unknown as Awaited<ReturnType<GoogleAuth['getClient']>>);
  await runDesktopImagePublication({ ...input, skipMissing: true });
  expect(request).toHaveBeenCalledTimes(2);
  expect(log).toHaveBeenCalledWith(expect.stringContaining(`"desktopManifestDigest": "sha256:${'c'.repeat(64)}"`));
  expect(runWithOperationAuditIntent).not.toHaveBeenCalled();
});

it('still fails malformed desktop artifacts instead of treating them as skipped builds', async () => {
  const { input, client } = publication(null);
  await expect(runDesktopImagePublication({ ...input, skipMissing: true })).rejects.toThrow('desktop image artifact is required');
  expect(client).not.toHaveBeenCalled();
});

it('still fails manifest lookup errors instead of skipping publication', async () => {
  const { input, client, resolveManifest } = publication();
  resolveManifest.mockRejectedValue(new Error('registry denied'));
  await expect(runDesktopImagePublication({ ...input, skipMissing: true })).rejects.toThrow('registry denied');
  expect(client).not.toHaveBeenCalled();
});

it('still inspects and plans publication when the optional desktop artifact is present', async () => {
  const artifact = {
    project: 'octogee-test', name: 'octogee-computer-fixture', id: '123', sourceSha: 'a'.repeat(40),
    inputFingerprint: 'b'.repeat(64), acceptance: 'resize-reboot-v1',
  };
  const { input, client, log } = publication(artifact);
  const request = vi.fn()
    .mockResolvedValueOnce({ data: { name: artifact.name, id: artifact.id, status: 'READY', labels: { source: artifact.sourceSha } } })
    .mockResolvedValueOnce({ data: { name: artifact.name } });
  client.mockResolvedValue({ request } as unknown as Awaited<ReturnType<GoogleAuth['getClient']>>);
  await runDesktopImagePublication({ ...input, skipMissing: true });
  expect(request).toHaveBeenCalledTimes(2);
  expect(log).toHaveBeenCalledWith(expect.stringContaining('family already serves'));
  expect(runWithOperationAuditIntent).not.toHaveBeenCalled();
});
