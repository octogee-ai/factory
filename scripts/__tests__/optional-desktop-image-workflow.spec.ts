import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';
import { parse } from 'yaml';
import { createMainBuildReleaseDigestManifest } from '../../.github/actions/release-digest-manifest/release-digest-manifest.mjs';

const main = parse(readFileSync(resolve(import.meta.dirname, '../../.github/workflows/build-main.yml'), 'utf8'));
const shipTest = parse(readFileSync(resolve(import.meta.dirname, '../../.github/workflows/ship-test.yml'), 'utf8'));

it('builds Desktop as part of the selected main build before shipment', () => {
  const desktop = main.jobs.desktop;
  expect(desktop.needs).toBe('build');
  expect(shipTest.jobs).not.toHaveProperty('desktop');
  expect(shipTest.jobs.deploy.needs).toBe('build');
  const checkout = desktop.steps.find((step: { uses?: string }) => step.uses?.startsWith('actions/checkout@'));
  expect(checkout.with).toMatchObject({ ref: '${{ inputs.source_sha || github.sha }}', 'fetch-depth': 0 });
  const construct = desktop.steps.find((step: { run?: string }) => step.run === 'node scripts/ci/desktop.mjs');
  expect(construct.env).toMatchObject({ CI_SOURCE_SHA: '${{ inputs.source_sha || github.sha }}', CI_BRANCH: 'main', CI_DESKTOP_ACTIONS: 'true' });
  const authentication = desktop.steps.find((step: { uses?: string }) => step.uses === './.github/actions/setup-gateway-build');
  expect(authentication.with['service-account']).toBe('octogee-ci-desktop@octogee.iam.gserviceaccount.com');
});

it.each(['', JSON.stringify({
  project: 'firebase-test', name: 'octogee-computer-fixture', id: '123', sourceSha: 'a'.repeat(40),
  inputFingerprint: 'b'.repeat(64), acceptance: 'resize-reboot-v1',
})])('authors a valid immutable manifest with an optional desktop output (%s)', artifact => {
  const writer = readFileSync(resolve(import.meta.dirname, '../../scripts/ci/publish-manifest.sh'), 'utf8');
  const program = writer.match(/python3 - <<'PYEOF'\n([\s\S]*?)\nPYEOF/)[1];
  const directory = mkdtempSync(join(tmpdir(), 'optional-desktop-manifest-'));
  try {
    const inputPath = join(directory, 'input.json');
    execFileSync('python3', ['-c', `import subprocess\nfrom types import SimpleNamespace\nsubprocess.run = lambda *args, **kwargs: SimpleNamespace(returncode=0, stdout='sha256:' + 'e' * 64)\n${program}`], {
      env: {
        ...process.env, INPUT_FILE: inputPath, BASE_MANIFEST_FILE: join(directory, 'absent.json'),
        AR_REPO: 'us-central1-docker.pkg.dev/octogee/octogee', GCP_PROJECT: 'octogee', SOURCE_SHA: 'a'.repeat(40),
        OPENCLAW_RUNTIME_VERSION: '2026.7.1', OPENCLAW_SOURCE_SHA: 'c'.repeat(40),
        RUN_PLATFORM: 'true', RUN_GATEWAY: 'true', DESKTOP_IMAGE_ARTIFACT: artifact,
      },
      stdio: 'pipe',
    });
    const input = JSON.parse(readFileSync(inputPath, 'utf8'));
    const manifest = createMainBuildReleaseDigestManifest(input);
    if (artifact) expect(manifest.desktopImage).toEqual(JSON.parse(artifact));
    else {
      expect(input).not.toHaveProperty('desktopImage');
      expect(manifest).not.toHaveProperty('desktopImage');
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
