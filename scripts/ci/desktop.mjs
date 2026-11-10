import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { desktopBuild, lockDesktopImage, waitForMainBuild } from './desktop-build.mjs';
import { request } from './gcs.mjs';
import { resolveRelease, resolveDesktopRelease } from './release-source.mjs';
import { publishDesktopRelease } from './publish-desktop.mjs';

const run = (file, args, options = {}) => execFileSync(file, args, { encoding: 'utf8', ...options })?.trim();
const sha = process.env.CI_SOURCE_SHA;
const temporary = mkdtempSync(join(tmpdir(), 'octogee-desktop-'));
const env = { ...process.env, AR_REPO: 'us-central1-docker.pkg.dev/octogee/octogee', GCP_PROJECT: 'octogee', SOURCE_SHA: sha, RUNNER_TEMP: temporary, CI_OUTPUT_FILE: join(temporary, 'output') };
let cleaned = true;
try {
  const result = await desktopBuild({ sourceSha: sha, checkoutSha: run('git', ['rev-parse', 'HEAD']),
    branch: process.env.CI_BRANCH, clean: run('git', ['status', '--porcelain', '--untracked-files=no']) === '',
    actions: process.env.GITHUB_ACTIONS === 'true' && process.env.CI_DESKTOP_ACTIONS === 'true', runId: process.env.CI_RUN_ID }, {
    main: async () => {
      run('git', ['merge-base', '--is-ancestor', sha, 'origin/main']);
      return waitForMainBuild(sha, { read: resolveRelease });
    },
    lock: task => lockDesktopImage(task, { request, canRelease: () => cleaned,
      deleteRunVms: runId => run('node', ['.github/actions/release-digest-manifest/build-desktop-image.mjs', 'cleanup'], { env: { ...env, CI_RUN_ID: runId }, stdio: 'inherit' }) }),
    lookup: resolveDesktopRelease,
    desktop: async build => {
      cleaned = false;
      const desktopEnv = { ...env, OCTOGEE_DESKTOP_GATEWAY_IMAGE: `${env.AR_REPO}/octogee-gateway-builder@${build.manifest.surfaces.gateway['octogee-gateway-builder']}`,
        OCTOGEE_DESKTOP_EDGE_IMAGE: `${env.AR_REPO}/gateway-edge@${build.manifest.surfaces.gateway['gateway-edge']}` };
      try {
        run('node', ['.github/actions/release-digest-manifest/build-desktop-image.mjs'], { env: desktopEnv, stdio: 'inherit' });
        return JSON.parse(readFileSync(join(temporary, 'desktop-image.json'), 'utf8'));
      } finally {
        run('node', ['.github/actions/release-digest-manifest/build-desktop-image.mjs', 'cleanup'], { env: desktopEnv, stdio: 'inherit' });
        cleaned = true;
      }
    },
    publish: (record, build) => publishDesktopRelease(record, build, temporary),
  });
  console.log(`Accepted desktop image ${result.desktopImage.name}; immutable artifact ${result.digest}; main manifest unchanged`);
} finally { rmSync(temporary, { recursive: true, force: true }); }
