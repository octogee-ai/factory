import { validateReleaseDigestManifest } from '../../../.github/actions/release-digest-manifest/release-digest-manifest.mjs';
import { request } from './gcs.mjs';
import { resolveRegistryArtifact, resolveDesktopRelease as readDesktopRelease } from '../lib/desktop-image-release.mjs';

const repository = 'us-central1-docker.pkg.dev/octogee/octogee';

export async function resolveRelease(sha, fetchAuthenticated = request) {
  return validRelease(sha, await resolveRegistryArtifact('release-digest-manifest', sha, 'release-digest-manifest.json', fetchAuthenticated));
}
export async function findRelease(sha, fetchAuthenticated = request) {
  const artifact = await resolveRegistryArtifact('release-digest-manifest', sha, 'release-digest-manifest.json', fetchAuthenticated, true);
  return artifact && validRelease(sha, artifact);
}
function validRelease(sha, { value, digest }) {
  const manifest = validateReleaseDigestManifest(value, sha, repository);
  if (manifest.sourceSha !== sha || manifest.repository !== repository) throw new Error('Selected release does not match the requested central build');
  return { manifest, digest };
}
export function resolveDesktopRelease(build, fetchAuthenticated = request) {
  return readDesktopRelease(build, fetchAuthenticated);
}

export async function findCompleteRelease(sha, fetchAuthenticated = request) {
  const build = await findRelease(sha, fetchAuthenticated);
  if (!build) return null;
  return await resolveDesktopRelease(build, fetchAuthenticated) ? build : null;
}
