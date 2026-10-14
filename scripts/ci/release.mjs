import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { releaseOptions, deployRelease } from './release-plan.mjs';
import { withBuildLock } from './build-lock.mjs';
import { request } from './gcs.mjs';

const options = releaseOptions(process.argv.slice(2));
const temporary = mkdtempSync(join(tmpdir(), 'platform-release-'));
const env = { ...process.env, SOURCE_SHA: options.sha, RELEASE_ENVIRONMENT: options.environment, RELEASE_LOG_LEVEL: options.logLevel, RELEASE_POST_CHECKS: String(options.checks ?? options.shipTest ?? false), RELEASE_ACTOR: options.actor, RELEASE_REASON: `Deploy immutable build ${options.sha}`, RUNNER_TEMP: temporary };
const run = (file, args, extra = {}) => execFileSync(file, args, { env, stdio: 'inherit', ...extra });
try {
  run('npm', ['ci', '--prefix', 'scripts', '--no-audit', '--no-fund']);
  run('npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund']);
  await deployRelease(options, {
    manifest: async sha => {
      if (sha !== env.SOURCE_SHA) throw new Error('Release source changed');
      return JSON.parse(readFileSync(process.env.CI_RELEASE_MANIFEST, 'utf8'));
    },
    lock: task => withBuildLock(`deploy-${options.environment}`, request, task),
    platform: async () => run('bash', ['scripts/ci/platform-deploy.sh']),
    site: async () => run('node', ['scripts/ci/site-deploy.mjs']),
    desktop: async () => run('node', ['--import', './node_modules/tsx/dist/loader.mjs', 'ops/release-desktop-image.ts'], { cwd: 'scripts' }),
    fleet: async () => run('node', ['--import', './node_modules/tsx/dist/loader.mjs', 'ops/deploy-test-fleet.ts', `--sha=${options.sha}`, '--timeout-ms=3600000'], { cwd: 'scripts' }),
  });
} finally { rmSync(temporary, { recursive: true, force: true }); }
