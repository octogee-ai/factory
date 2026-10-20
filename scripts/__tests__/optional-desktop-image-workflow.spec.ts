import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';
import { parse } from 'yaml';
import { createMainBuildReleaseDigestManifest } from '../../.github/actions/release-digest-manifest/release-digest-manifest.mjs';

const build = parse(readFileSync(resolve(import.meta.dirname, '../../.github/workflows/desktop-image.yml'), 'utf8'));
const main = parse(readFileSync(resolve(import.meta.dirname, '../../.github/workflows/build-main.yml'), 'utf8'));
const cloud = parse(readFileSync(resolve(import.meta.dirname, '../../ci/cloudbuild-main.yaml'), 'utf8'));

it('keeps desktop construction explicit and out of automatic main builds', () => {
  expect(build.on.workflow_dispatch.inputs.build_desktop_image).toMatchObject({ type: 'boolean', default: false });
  expect(build.jobs.build.if).toBe('inputs.build_desktop_image');
  expect(cloud.steps[0].env).toContain('CI_BUILD_DESKTOP_IMAGE=false');
  expect(cloud.substitutions).not.toHaveProperty('_BUILD_DESKTOP_IMAGE');
  expect(build.on).not.toHaveProperty('push');
  expect(main.on.workflow_dispatch.inputs).not.toHaveProperty('build_desktop_image');
});

it.each(['', JSON.stringify({
  project: 'octogee-test', name: 'octogee-computer-fixture', id: '123', sourceSha: 'a'.repeat(40),
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
