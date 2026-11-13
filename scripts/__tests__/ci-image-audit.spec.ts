import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';

function audit(environment: Record<string, string> = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'image-audit-test-'));
  const output = join(directory, 'scanned');
  const repositories = join(directory, 'repositories');
  writeFileSync(join(directory, 'gcloud'), `#!/usr/bin/env bash
set -euo pipefail
if [[ "$1" = auth ]]; then exit 0; fi
repository="$5"
echo "$repository" >> "$AUDIT_REPOSITORIES"
if [[ "$repository" = "\${AUDIT_DENIED:-}" ]]; then echo 'registry denied' >&2; exit 23; fi
if [[ "\${AUDIT_EMPTY:-}" = true ]]; then echo '[]'; exit 0; fi
printf '[{"package":"%s/service","version":"sha256:${'a'.repeat(64)}","updateTime":"2026-10-13","metadata":{"buildTime":"2026-10-13","mediaType":"application/vnd.oci.image.manifest.v1+json"}},{"package":"%s/cache/service","version":"sha256:${'b'.repeat(64)}","metadata":{"buildTime":"2026-10-13","mediaType":"application/vnd.oci.image.manifest.v1+json"}}]' "$repository" "$repository"
`, { mode: 0o755 });
  writeFileSync(join(directory, 'trivy'), `#!/usr/bin/env bash
echo "\${@: -1}" >> "$AUDIT_OUTPUT"
if [[ "\${@: -1}" = "\${AUDIT_VULNERABLE:-}" ]]; then exit 1; fi
`, { mode: 0o755 });
  try {
    let error: unknown;
    try { execFileSync('bash', ['platform/scripts/ci/audit.sh', 'trivy-images'], { cwd: resolve(import.meta.dirname, '../../..'), env: { ...process.env, PATH: `${directory}:${process.env.PATH}`, AUDIT_OUTPUT: output, AUDIT_REPOSITORIES: repositories, ...environment }, stdio: 'pipe' }); }
    catch (failure) { error = failure; }
    const lines = (file: string) => existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n') : [];
    return { error, scans: lines(output), repositories: lines(repositories) };
  } finally { rmSync(directory, { recursive: true, force: true }); }
}
const repositories = ['octogee', 'octogee-ssr-test', 'octogee-ssr-prod'].map(name => `us-central1-docker.pkg.dev/octogee/${name}`);
const images = repositories.map(repository => `${repository}/service@sha256:${'a'.repeat(64)}`);
it('scans deployable images from central and both environment SSR repositories, excluding each cache', () => {
  const result = audit();
  expect(result.error).toBeUndefined();
  expect(result.repositories).toEqual(repositories);
  expect(result.scans).toEqual(images);
});
it('surfaces a denied SSR repository instead of reporting incomplete scan coverage as success', () => {
  const result = audit({ AUDIT_DENIED: repositories[2] });
  expect(result.error).toMatchObject({ status: 23 });
});
it('continues scanning every repository after finding a vulnerable image and fails the audit', () => {
  const result = audit({ AUDIT_VULNERABLE: images[0] });
  expect(result.error).toMatchObject({ status: 1 });
  expect(result.scans).toEqual(images);
});
it('fails when no repository contains a deployable image', () => {
  expect(audit({ AUDIT_EMPTY: 'true' }).error).toMatchObject({ status: 1 });
});
