import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { validateDesktopImage } from '../../.github/actions/release-digest-manifest/desktop-image.mjs';

export function validateDesktopRelease(value, build) {
  if (value?.schemaVersion !== 1 || value.sourceSha !== build.manifest.sourceSha
      || value.manifestDigest !== build.digest || value.gatewayDigest !== build.manifest.surfaces.gateway['octogee-gateway-builder']
      || !/^[a-f0-9]{40}$/.test(value.sourceSha) || !/^sha256:[a-f0-9]{64}$/.test(value.manifestDigest)
      || !/^sha256:[a-f0-9]{64}$/.test(value.gatewayDigest)) throw new Error('Desktop companion does not match the selected immutable main build');
  return { schemaVersion: 1, sourceSha: value.sourceSha, manifestDigest: value.manifestDigest, gatewayDigest: value.gatewayDigest, desktopImage: validateDesktopImage(value.desktopImage) };
}

const hash = bytes => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
function manifestFile(bytes, filename) {
  const tar = gunzipSync(bytes);
  for (let offset = 0; offset + 512 <= tar.length;) {
    const header = tar.subarray(offset, offset + 512);
    const name = header.subarray(0, 100).toString().split('\0', 1)[0].replace(/^\.\//, '');
    const size = parseInt(header.subarray(124, 136).toString().split('\0', 1)[0].trim(), 8);
    if (!Number.isSafeInteger(size) || size < 0 || offset + 512 + size > tar.length) throw new Error('Invalid release manifest layer');
    if (name === filename) return JSON.parse(tar.subarray(offset + 512, offset + 512 + size).toString());
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  throw new Error(`Release manifest layer has no ${filename}`);
}
export async function resolveRegistryArtifact(packageName, sha, filename, fetchAuthenticated, missing = false) {
  if (!/^[a-f0-9]{40}$/.test(sha)) throw new Error('A full build SHA is required');
  const base = `https://us-central1-docker.pkg.dev/v2/octogee/octogee/${packageName}`;
  const response = await fetchAuthenticated(`${base}/manifests/${sha}`, { headers: { Accept: 'application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json' } });
  if (missing && response.status === 404) return null;
  if (!response.ok) throw Object.assign(new Error(`Immutable build lookup failed: ${response.status}`), { status: response.status });
  const bytes = Buffer.from(await response.arrayBuffer());
  const digest = response.headers.get('docker-content-digest');
  if (digest !== hash(bytes)) throw new Error('Release manifest digest mismatch');
  const image = JSON.parse(bytes.toString());
  if (image.layers?.length !== 1 || !/^sha256:[a-f0-9]{64}$/.test(image.layers[0].digest)) throw new Error('Invalid release manifest image');
  const layer = await fetchAuthenticated(`${base}/blobs/${image.layers[0].digest}`);
  if (!layer.ok) throw new Error(`Release manifest layer lookup failed: ${layer.status}`);
  const blob = Buffer.from(await layer.arrayBuffer());
  if (hash(blob) !== image.layers[0].digest) throw new Error('Release manifest layer digest mismatch');
  return { value: manifestFile(blob, filename), digest };
}
export async function resolveDesktopRelease(build, fetchAuthenticated) {
  if (build.manifest.desktopImage !== undefined) return { desktopImage: validateDesktopImage(build.manifest.desktopImage), digest: build.digest };
  const artifact = await resolveRegistryArtifact('desktop-image-manifest', build.manifest.sourceSha, 'desktop-image-manifest.json', fetchAuthenticated, true);
  if (!artifact) return null;
  return { ...validateDesktopRelease(artifact.value, build), digest: artifact.digest };
}
