import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, lstatSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { siteSsrRepository } from './frontend-registry.mjs';

const run = (file, args, options = {}) => execFileSync(file, args, { encoding: 'utf8', ...options });
const target = Object.fromEntries(run('node', ['core/dist/resolve-deployment-target.js', `--environment=${process.env.RELEASE_ENVIRONMENT}`, '--reject-candidate-target']).trim().split('\n').map(line => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]));
run('node', ['scripts/ci/frontend.mjs'], { stdio: 'inherit' });
if (existsSync('functions/src/_shared') && lstatSync('functions/src/_shared').isSymbolicLink()) {
  rmSync('functions/src/_shared');
  cpSync('shared', 'functions/src/_shared', { recursive: true, dereference: true, filter: path => !path.split('/').includes('node_modules') && !path.split('/').includes('dist') });
}
const remaining = directory => readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
  const path = join(directory, entry.name);
  if (entry.name === 'node_modules') return [];
  if (entry.isSymbolicLink()) return [path];
  return entry.isDirectory() ? remaining(path) : [];
});
if (remaining('functions').length) throw new Error('Functions upload contains source symlinks');
const env = { ...process.env, OCTOGEE_DEPLOYMENT_REGION: target.region, GCLOUD_PROJECT: target.firebase_project_id, GOOGLE_CLOUD_PROJECT: target.firebase_project_id };
run('npm', ['run', 'deploy:firestore', '--', '--project', target.firebase_project_id, '--non-interactive'], { stdio: 'inherit', env });
if (process.env.RELEASE_POST_CHECKS === 'true') {
  const inventory = join(process.env.RUNNER_TEMP, 'functions-before.json');
  writeFileSync(inventory, run('node_modules/.bin/firebase', ['functions:list', '--project', target.firebase_project_id, '--json'], { env }));
  const args = ['scripts/ops/verify-firebase-function-release.mjs', '--mode=predeploy', `--inventory=${inventory}`, '--functions-module=functions/lib/index.js', `--target-region=${target.region}`];
  for (const id of ['onOrchestratorConfigWritten', 'onTrialGatewayConfigWritten', 'onTrialGatewayPoolAvailable', 'redriveTrialGatewayClaims']) args.push(`--allow-delete=${id}`);
  run('node', args, { stdio: 'inherit', env });
}
run('npm', ['run', 'deploy:functions', '--', '--project', target.firebase_project_id, '--non-interactive', '--force'], { stdio: 'inherit', env });
const image = `${siteSsrRepository(process.env.RELEASE_ENVIRONMENT)}/site-ssr:${process.env.RELEASE_ENVIRONMENT}-${process.env.SOURCE_SHA.slice(0, 8)}`;
run('gcloud', ['run', 'deploy', 'site-ssr', `--image=${image}`, `--region=${target.region}`, `--project=${target.hosting_project_id}`, '--platform=managed', '--allow-unauthenticated', '--port=4321', '--memory=256Mi', '--cpu=1', '--min-instances=0', '--max-instances=3', '--concurrency=80', '--timeout=10s', `--set-env-vars=PUBLIC_FIREBASE_PROJECT_ID=${target.firebase_project_id}`, '--quiet'], { stdio: 'inherit' });
if (process.env.RELEASE_POST_CHECKS === 'true') {
  const service = JSON.parse(run('gcloud', ['run', 'services', 'describe', 'site-ssr', `--region=${target.region}`, `--project=${target.hosting_project_id}`, '--format=json']));
  if (!service.status?.conditions?.some(condition => condition.type === 'Ready' && condition.status === 'True')) throw new Error('SSR service did not become ready');
}
run('bash', ['scripts/firebase-deploy-hosting.sh', 'site', target.hosting_project_id, target.region], { stdio: 'inherit', env });
run('bash', ['scripts/firebase-deploy-hosting.sh', 'app', target.hosting_project_id], { stdio: 'inherit', env });
if (process.env.RELEASE_POST_CHECKS === 'true') {
  const inventory = join(process.env.RUNNER_TEMP, 'functions-after.json');
  writeFileSync(inventory, run('node_modules/.bin/firebase', ['functions:list', '--project', target.firebase_project_id, '--json'], { env }));
  const services = run('node', ['scripts/ops/verify-firebase-function-release.mjs', '--mode=postdeploy', `--inventory=${inventory}`, '--functions-module=functions/lib/index.js', `--target-region=${target.region}`], { env }).trim();
  for (const line of services.split('\n').filter(Boolean)) {
    const [service, account] = line.split('\t');
    const binding = run('gcloud', ['run', 'services', 'get-iam-policy', service, `--project=${target.firebase_project_id}`, `--region=${target.region}`, '--flatten=bindings[].members', `--filter=bindings.role=roles/run.invoker AND bindings.members=serviceAccount:${account}`, '--format=value(bindings.members)']).trim();
    if (binding !== `serviceAccount:${account}`) throw new Error(`Scheduled function ${service} lacks its exact invoker binding`);
  }
  run('node', ['scripts/ops/verify-firestore-indexes.mjs', `--project=${target.firebase_project_id}`], { stdio: 'inherit', env });
}
