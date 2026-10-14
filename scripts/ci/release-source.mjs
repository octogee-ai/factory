import { createHash } from 'node:crypto';
import { validateReleaseDigestManifest } from '../../.github/actions/release-digest-manifest/release-digest-manifest.mjs';
import { validateSourceArchive } from '../../.github/actions/release-digest-manifest/source-archive.mjs';
import { objectUrl, request } from './gcs.mjs';
import { resolveRegistryArtifact, resolveDesktopRelease as readDesktopRelease } from '../lib/desktop-image-release.mjs';

const repository = 'us-central1-docker.pkg.dev/octogee/octogee';
const hash = bytes => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;

export async function resolveRelease(sha, fetchAuthenticated = request) {
  const { value, digest } = await resolveRegistryArtifact('release-digest-manifest', sha, 'release-digest-manifest.json', fetchAuthenticated);
  const manifest = validateReleaseDigestManifest(value, sha, repository);
  if (manifest.sourceSha !== sha || manifest.repository !== repository) throw new Error('Selected release does not match the requested central build');
  return { manifest, digest };
}
export function resolveDesktopRelease(build, fetchAuthenticated = request) {
  return readDesktopRelease(build, fetchAuthenticated);
}
export async function downloadReleaseSource(manifest, fetchAuthenticated = request) {
  if (!manifest.sourceArchive) throw new Error('This build predates archived deployment source; use an archived main build or Helm rollback');
  const archive = validateSourceArchive(manifest.sourceArchive, manifest.sourceSha);
  const response = await fetchAuthenticated(`${objectUrl(archive.bucket, archive.object)}?alt=media&generation=${archive.generation}`);
  if (!response.ok) throw new Error(`Release source lookup failed: ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (hash(bytes) !== `sha256:${archive.sha256}`) throw new Error('Release source hash mismatch');
  return bytes;
}
