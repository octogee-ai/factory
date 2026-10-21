import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { releaseOptions, deployRelease } from './release-plan.mjs';
import { withBuildLock } from './build-lock.mjs';
import { request } from './gcs.mjs';

const options = releaseOptions(process.argv.slice(2));
const temporary = mkdtempSync(join(tmpdir(), 'platform-release-'));
const env = { ...process.env, SOURCE_SHA: options.sha, RELEASE_ENVIRONMENT: options.environment, RELEASE_LOG_LEVEL: options.logLevel, RELEASE_POST_CHECKS: String(options.checks ?? options.shipTest ?? false), RELEASE_ACTOR: options.actor, RELEASE_REASON: `Deploy immutable build ${options.sha}`, RUNNER_TEMP: temporary };
const run = (file, args, extra = {}) => execFileSync(file, args, { env, stdio: 'inherit', ...extra });
const stage = (label, file, args, extra = {}) => new Promise((resolve, reject) => {
  const runnerTemp = join(temporary, label);
  mkdirSync(runnerTemp);
  const child = spawn(file, args, { env: { ...env, RUNNER_TEMP: runnerTemp }, stdio: ['ignore', 'pipe', 'pipe'], ...extra });
  for (const [input, output] of [[child.stdout, process.stdout], [child.stderr, process.stderr]]) {
    createInterface({ input }).on('line', line => output.write(`[${label}] ${line}\n`));
  }
  child.once('error', reject);
  child.once('close', (code, signal) => code === 0 ? resolve() : reject(new Error(`${label} deployment exited with ${code ?? signal}`)));
});
try {
  run('npm', ['ci', '--prefix', 'scripts', '--no-audit', '--no-fund']);
  run('npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund']);
  await deployRelease(options, {
    manifest: async sha => {
      if (sha !== env.SOURCE_SHA) throw new Error('Release source changed');
      return JSON.parse(readFileSync(process.env.CI_RELEASE_MANIFEST, 'utf8'));
    },
    lock: task => withBuildLock(`deploy-${options.environment}`, request, task),
    platform: () => stage('platform', 'bash', ['scripts/ci/platform-deploy.sh']),
    site: () => stage('site', 'node', ['scripts/ci/site-deploy.mjs']),
    desktop: () => stage('desktop', 'node', ['--import', './node_modules/tsx/dist/loader.mjs', 'ops/release-desktop-image.ts'], { cwd: 'scripts' }),
    fleet: () => stage('fleet', 'node', ['--import', './node_modules/tsx/dist/loader.mjs', 'ops/deploy-test-fleet.ts', `--sha=${options.sha}`, '--timeout-ms=3600000'], { cwd: 'scripts' }),
  });
} finally { rmSync(temporary, { recursive: true, force: true }); }
