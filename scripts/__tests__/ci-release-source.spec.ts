import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { expect, it, vi } from 'vitest';
import { findRelease, resolveRelease, resolveDesktopRelease } from '../ci/release-source.mjs';

const sha = 'a'.repeat(40);
const digest = (bytes: Buffer) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const manifest = { schemaVersion: 4, sourceSha: sha, repository: 'us-central1-docker.pkg.dev/octogee/octogee', openclawVersion: '2026.7.1', openclawSourceSha: 'b'.repeat(40),
  surfaces: { gateway: Object.fromEntries(['gateway-edge', 'octogee-gateway', 'octogee-gateway-builder'].map(name => [name, `sha256:${'c'.repeat(64)}`])), platform: Object.fromEntries(['artifact-worker', 'glm-controller', 'octogee-api', 'octogee-ops-agent', 'octogee-project-runner'].map(name => [name, `sha256:${'c'.repeat(64)}`])) } };
function registry(value: unknown = manifest, filename = 'release-digest-manifest.json') {
  const data = Buffer.from(JSON.stringify(value));
  const header = Buffer.alloc(512);
  header.write(filename);
  header.write(data.length.toString(8).padStart(11, '0'), 124);
  const layer = gzipSync(Buffer.concat([header, data, Buffer.alloc((512 - data.length % 512) % 512 + 1024)]));
  const image = Buffer.from(JSON.stringify({ layers: [{ digest: digest(layer) }] }));
  const request = vi.fn(async (url: string) => url.includes('/manifests/') ? new Response(image, { headers: { 'docker-content-digest': digest(image) } }) : new Response(layer));
  return { request, image, layer };
}
it('resolves the authentic manifest by full SHA and verifies both registry digests', async () => {
  const { request } = registry();
  expect((await resolveRelease(sha, request)).manifest).toEqual(manifest);
  expect(request.mock.calls[0][0]).toContain(`/manifests/${sha}`);
});
it('rejects modified registry manifest bytes before reading the layer', async () => {
  const request = vi.fn(async () => new Response('{}', { headers: { 'docker-content-digest': `sha256:${'d'.repeat(64)}` } }));
  await expect(resolveRelease(sha, request)).rejects.toThrow('manifest digest mismatch');
  expect(request).toHaveBeenCalledOnce();
});
it('rejects a modified manifest layer even when its enclosing digest is valid', async () => {
  const fixture = registry();
  fixture.request.mockImplementation(async url => url.includes('/manifests/') ? new Response(fixture.image, { headers: { 'docker-content-digest': digest(fixture.image) } }) : new Response('changed'));
  await expect(resolveRelease(sha, fixture.request)).rejects.toThrow('layer digest mismatch');
});
it('rejects a manifest substituted for a different build SHA', async () => {
  await expect(resolveRelease(sha, registry({ ...manifest, sourceSha: 'd'.repeat(40) }).request)).rejects.toThrow();
});
it('reports an absent main build as missing but fails closed on other lookup errors', async () => {
  await expect(findRelease(sha, async () => new Response('', { status: 404 }))).resolves.toBeNull();
  await expect(findRelease(sha, async () => new Response('', { status: 403 }))).rejects.toThrow('lookup failed: 403');
  expect((await findRelease(sha, registry().request))?.manifest).toEqual(manifest);
});

const build = { manifest, digest: `sha256:${'f'.repeat(64)}` };
const desktopImage = { project: 'octogee-test', name: 'octogee-computer-fixture', id: '123', sourceSha: sha, inputFingerprint: 'e'.repeat(64), acceptance: 'resize-reboot-v1' };
const companion = { schemaVersion: 1, sourceSha: sha, manifestDigest: build.digest, gatewayDigest: manifest.surfaces.gateway['octogee-gateway-builder'], desktopImage };
it('resolves a separately accepted desktop companion bound to the immutable main manifest', async () => {
  const fixture = registry(companion, 'desktop-image-manifest.json');
  expect(await resolveDesktopRelease(build, fixture.request)).toEqual({ ...companion, digest: digest(fixture.image) });
  expect(fixture.request.mock.calls[0][0]).toContain(`/desktop-image-manifest/manifests/${sha}`);
});
it('skips desktop publication only after the companion tag is confirmed absent', async () => {
  await expect(resolveDesktopRelease(build, async () => new Response('', { status: 404 }))).resolves.toBeNull();
  await expect(resolveDesktopRelease(build, async () => new Response('', { status: 403 }))).rejects.toThrow('lookup failed: 403');
});
it.each([{ sourceSha: 'd'.repeat(40) }, { manifestDigest: `sha256:${'d'.repeat(64)}` }, { gatewayDigest: `sha256:${'d'.repeat(64)}` }])('refuses a companion for a different build even with valid registry hashes: %j', async change => {
  await expect(resolveDesktopRelease(build, registry({ ...companion, ...change }, 'desktop-image-manifest.json').request)).rejects.toThrow('does not match');
});
it('verifies desktop registry hashes before accepting the companion', async () => {
  const fixture = registry(companion, 'desktop-image-manifest.json');
  fixture.request.mockImplementation(async url => url.includes('/manifests/') ? new Response(fixture.image, { headers: { 'docker-content-digest': digest(fixture.image) } }) : new Response('changed'));
  await expect(resolveDesktopRelease(build, fixture.request)).rejects.toThrow('layer digest mismatch');
});
it('retains accepted desktop artifacts already included in earlier main manifests', async () => {
  const request = vi.fn();
  await expect(resolveDesktopRelease({ ...build, manifest: { ...manifest, desktopImage } }, request)).resolves.toEqual({ desktopImage, digest: build.digest });
  expect(request).not.toHaveBeenCalled();
});
