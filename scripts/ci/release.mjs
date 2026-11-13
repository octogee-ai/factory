import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { releaseOptions, deployRelease, fleetStoreStages } from './release-plan.mjs';
import { withBuildLock } from './build-lock.mjs';
import { request } from './gcs.mjs';
import { fleetStoreDependencies, withFleetStore } from './fleet-store.mjs';

const options = releaseOptions(process.argv.slice(2));
const temporary = mkdtempSync(join(tmpdir(), 'platform-release-'));
const env = { ...process.env, SOURCE_SHA: options.sha, RELEASE_ENVIRONMENT: options.environment, RELEASE_LOG_LEVEL: options.logLevel, RELEASE_POST_CHECKS: String(options.checks || options.shipTest || options.shipProd || false), RELEASE_ACTOR: options.actor, RELEASE_REASON: `Deploy immutable build ${options.sha}`, RUNNER_TEMP: temporary };
const run = (file, args, extra = {}) => execFileSync(file, args, { env, stdio: 'inherit', ...extra });
const stage = (label, file, args, extra = {}) => new Promise((resolve, reject) => {
  const runnerTemp = join(temporary, label);
  mkdirSync(runnerTemp);
  const child = spawn(file, args, { stdio: ['ignore', 'pipe', 'pipe'], ...extra, env: { ...env, RUNNER_TEMP: runnerTemp, ...extra.env } });
  for (const [input, output] of [[child.stdout, process.stdout], [child.stderr, process.stderr]]) {
    createInterface({ input }).on('line', line => output.write(`[${label}] ${line}\n`));
  }
  child.once('error', reject);
  child.once('close', (code, signal) => code === 0 ? resolve() : reject(new Error(`${label} deployment exited with ${code ?? signal}`)));
});
try {
  run('npm', ['ci', '--prefix', 'platform/scripts', '--no-audit', '--no-fund']);
  run('npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund']);
  const { parse } = await import('yaml');
  const values = parse(readFileSync(`platform/helm/octogee/values.${options.environment}.yaml`, 'utf8'));
  const siteAfterPlatform = values?.global?.platformState?.requireCutoverImport === true;
  await deployRelease(options, {
    siteAfterPlatform,
    manifest: async sha => {
      if (sha !== env.SOURCE_SHA) throw new Error('Release source changed');
      return JSON.parse(readFileSync(process.env.CI_RELEASE_MANIFEST, 'utf8'));
    },
    lock: task => withBuildLock(`deploy-${options.environment}`, request, task, { takeOverFinishedRuns: true }),
    platform: () => stage('platform', 'bash', ['platform/scripts/ci/platform-deploy.sh']),
    site: () => stage('site', 'node', ['platform/scripts/ci/site-deploy.mjs']),
    ...fleetStoreStages({ environment: options.environment, sha: options.sha, stage, withStore: withFleetStore, storeDependencies: fleetStoreDependencies }),
  });
} finally { rmSync(temporary, { recursive: true, force: true }); }
