import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';
import { parse } from 'yaml';
import { createMainBuildReleaseDigestManifest } from '../../.github/actions/release-digest-manifest/release-digest-manifest.mjs';

const build = parse(readFileSync(resolve(import.meta.dirname, '../../.github/workflows/build-main.yml'), 'utf8'));
const ship = parse(readFileSync(resolve(import.meta.dirname, '../../.github/workflows/ship-test.yml'), 'utf8'));

function condition(job: string, requested: boolean | undefined, desktopResult = 'skipped', existingManifest = false) {
  const expression = build.jobs[job].if.replace(/\bneeds\.([a-z-]+)\b/g, 'needs["$1"]');
  return new Function('inputs', 'needs', 'always', 'cancelled', `return ${expression}`)(
    { build_desktop_image: requested },
    {
      scope: { result: 'success', outputs: { run_platform: 'true', run_gateway: 'true', run_site: 'true' } },
      'existing-manifest': { result: 'success', outputs: { exists: String(existingManifest) } },
      'gateway-images': { result: 'success' },
      'platform-images': { result: 'success' },
      site: { result: 'success' },
      'desktop-image': { result: desktopResult },
    },
    () => true,
    () => false,
  );
}

it('defaults desktop builds off for dispatches and reusable calls, including Ship TEST', () => {
  for (const trigger of ['workflow_call', 'workflow_dispatch']) {
    expect(build.on[trigger].inputs.build_desktop_image).toMatchObject({ type: 'boolean', default: false });
  }
  expect(ship.on.workflow_dispatch.inputs.build_desktop_image).toMatchObject({ type: 'boolean', default: false });
  expect(ship.jobs.build.with.build_desktop_image).toBe('${{ inputs.build_desktop_image }}');
});

it.each([undefined, false, true])('builds the desktop image only when explicitly requested (%s)', requested => {
  expect(condition('desktop-image', requested)).toBe(requested === true);
});

it('reuses an existing immutable manifest even when desktop is requested', () => {
  expect(condition('desktop-image', true, 'skipped', true)).toBe(false);
  expect(condition('digest-manifest', true, 'success', true)).toBe(false);
});

it.each([
  [undefined, 'skipped', true],
  [false, 'skipped', true],
  [false, 'failure', false],
  [true, 'success', true],
  [true, 'skipped', false],
  [true, 'failure', false],
  [true, 'cancelled', false],
])('gates manifest publication on a requested desktop result (%s, %s)', (requested, result, publish) => {
  expect(condition('digest-manifest', requested as boolean | undefined, result as string)).toBe(publish);
});

it.each(['', JSON.stringify({
  project: 'octogee-test', name: 'octogee-computer-fixture', id: '123', sourceSha: 'a'.repeat(40),
  inputFingerprint: 'b'.repeat(64), acceptance: 'resize-reboot-v1',
})])('authors a valid immutable manifest with an optional desktop output (%s)', artifact => {
  const step = build.jobs['digest-manifest'].steps.find((value: { id?: string }) => value.id === 'manifest');
  const program = step.run.match(/python3 - <<'PYEOF'\n([\s\S]*?)\nPYEOF/)[1];
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
