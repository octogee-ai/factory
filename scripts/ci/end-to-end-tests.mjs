import { execFileSync } from 'node:child_process';
import { request } from './gcs.mjs';
import { deploymentEnvironmentSettings } from '../../core/dist/deployment-environment.js';

const run = (file, args, options = {}) => execFileSync(file, args, { encoding: 'utf8', ...options });
const target = deploymentEnvironmentSettings('test');
const firebaseResponse = await fetch(`${target.siteOrigin}/__/firebase/init.json`);
if (!firebaseResponse.ok) throw new Error(`Live Firebase configuration: ${firebaseResponse.status}`);
const firebase = await firebaseResponse.json();
if (firebase.projectId !== target.firebaseProjectId || !firebase.apiKey) throw new Error('Invalid TEST Firebase configuration');
const env = { ...process.env, OCTOGEE_LIVE_TESTS: '1', LIVE_TEST_PROJECT_ID: target.firebaseProjectId, LIVE_TEST_API_BASE: target.apiOrigin, LIVE_TEST_FIREBASE_API_KEY: firebase.apiKey, LIVE_TEST_GITHUB_REPO: 'octogee-ai/durability-canary', LIVE_TEST_DURABILITY_RESTART: process.env.CI_LIVE_RESTART === 'true' ? '1' : '' };
for (const name of ['RESEND_API_KEY', 'RESEND_FROM_EMAIL', 'LIVE_TEST_FIXTURE_PASSWORD']) env[name] = run('gcloud', ['secrets', 'versions', 'access', 'latest', `--secret=${name}`, `--project=${target.firebaseProjectId}`]).trim();
if (process.env.CI_LIVE_GITHUB_TOKEN === 'true') {
  const optional = await request(`https://secretmanager.googleapis.com/v1/projects/${target.firebaseProjectId}/secrets/LIVE_TEST_GITHUB_TOKEN/versions/latest:access`);
  if (!optional.ok) throw new Error(`Live GitHub fixture secret access failed: ${optional.status}`);
  env.LIVE_TEST_GITHUB_TOKEN = Buffer.from((await optional.json()).payload.data, 'base64').toString();
} else console.warn('LIVE_TEST_GITHUB_TOKEN is not enabled; the connector durability check will skip');
run('npm', ['ci', '--no-audit', '--no-fund'], { cwd: 'tests/live', env, stdio: 'inherit' });
env.LIVE_TEST_FIXTURE = run('npx', ['tsx', 'ensure-live-fixture.ts'], { cwd: 'tests/live', env }).trim();
for (const task of ['typecheck', 'test']) run('npm', ['run', task], { cwd: 'tests/live', env, stdio: 'inherit' });
