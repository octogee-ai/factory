import type { Firestore } from 'firebase-admin/firestore';
import { GoogleAuth } from 'google-auth-library';
import { afterEach, expect, it, vi } from 'vitest';
import { createCentralReleaseAuthority } from '@octogee/core/artifact-registry';
import { runWithOperationAuditIntent } from '@octogee/core/operation-audit';
import { runDesktopImagePublication } from '../lib/desktop-image-publication';

vi.mock('@octogee/core/artifact-registry', () => ({ createCentralReleaseAuthority: vi.fn() }));
vi.mock('@octogee/core/operation-audit', () => ({ runWithOperationAuditIntent: vi.fn() }));

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
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
  return { input, client, auth, log, resolveManifest };
}

it('skips desktop publication for a platform build without an artifact when allowed', async () => {
  const { input, client, auth, log } = publication();
  await runDesktopImagePublication({ ...input, skipMissing: true });
  expect(log).toHaveBeenCalledWith(expect.stringContaining('no desktop image; skipping publication'));
  expect(client).not.toHaveBeenCalled();
  expect(auth).not.toHaveBeenCalled();
  expect(runWithOperationAuditIntent).not.toHaveBeenCalled();
});

it('keeps an explicit Fleet publication strict when the build has no desktop artifact', async () => {
  const { input, client } = publication();
  await expect(runDesktopImagePublication(input)).rejects.toThrow('desktop image artifact is required');
  expect(client).not.toHaveBeenCalled();
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
    .mockResolvedValueOnce({ data: { name: artifact.name } })
    .mockResolvedValueOnce({ data: {} });
  client.mockResolvedValue({ request } as unknown as Awaited<ReturnType<GoogleAuth['getClient']>>);
  await runDesktopImagePublication({ ...input, skipMissing: true });
  expect(request).toHaveBeenCalledTimes(3);
  expect(log).toHaveBeenCalledWith(expect.stringContaining('nothing to publish'));
  expect(runWithOperationAuditIntent).not.toHaveBeenCalled();
});
