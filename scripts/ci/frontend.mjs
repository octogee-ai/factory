import { execFileSync } from 'node:child_process';
import { delimiter } from 'node:path';
import { siteSsrRepository } from './frontend-registry.mjs';

const environment = process.env.RELEASE_ENVIRONMENT ?? 'test';
const repository = siteSsrRepository(environment);

const run = (file, args, options = {}) => {
  const result = execFileSync(file, args, { encoding: 'utf8', ...options });
  return result?.trim();
};
const target = Object.fromEntries(run('node', ['core/dist/resolve-deployment-target.js', `--environment=${process.env.RELEASE_ENVIRONMENT ?? 'test'}`, '--reject-candidate-target']).split('\n').map(line => {
  const equals = line.indexOf('=');
  return [line.slice(0, equals), line.slice(equals + 1)];
}));
const response = await fetch(`https://${target.hosting_project_id}.web.app/__/firebase/init.json`);
if (!response.ok) throw new Error(`Public Firebase configuration: HTTP ${response.status}`);
const firebase = await response.json();
for (const key of ['apiKey', 'appId', 'messagingSenderId', 'projectId']) if (!firebase[key]) throw new Error(`Missing Firebase ${key}`);
if (firebase.projectId !== target.firebase_project_id) throw new Error('Firebase configuration belongs to a different project');
const publicConfig = {
  FIREBASE_API_KEY: firebase.apiKey,
  FIREBASE_APP_ID: firebase.appId,
  FIREBASE_MESSAGING_SENDER_ID: firebase.messagingSenderId,
  FIREBASE_MEASUREMENT_ID: firebase.measurementId ?? '',
  FIREBASE_PROJECT_ID: target.firebase_project_id,
  FIREBASE_AUTH_DOMAIN: `${target.firebase_project_id}.firebaseapp.com`,
  FIREBASE_STORAGE_BUCKET: `${target.firebase_project_id}.firebasestorage.app`,
  API_BASE: target.api_origin,
  POSTHOG_KEY: run('gcloud', ['secrets', 'versions', 'access', 'latest', '--secret=POSTHOG_PROJECT_TOKEN', `--project=${target.firebase_project_id}`]),
  POSTHOG_HOST: 'https://t.octogee.com',
};
const env = { ...process.env, BUILD_SHA: process.env.SOURCE_SHA, VITE_APP_ORIGIN: target.app_origin, VITE_SITE_ORIGIN: target.site_origin, VITE_GITEA_BASE_URL: target.git_origin, VITE_FF_APPSHELL: 'true' };
for (const [key, value] of Object.entries(publicConfig)) {
  env[`PUBLIC_${key}`] = value;
  env[`VITE_${key}`] = value;
}
const node24Env = { ...env, PATH: `${process.env.CI_NODE_24_BIN ?? '/opt/node24/bin'}${delimiter}${env.PATH}` };
const node24Version = run('node', ['-p', 'process.versions.node'], { env: node24Env });
const [node24Major, node24Minor] = node24Version.split('.').map(Number);
if (node24Major !== 24 || node24Minor < 12) throw new Error(`Firebase 13 frontends require Node >=24.12 <25; set CI_NODE_24_BIN (found Node ${node24Version})`);
for (const directory of ['functions', 'site', 'app']) {
  const packageEnv = directory === 'functions' ? env : node24Env;
  run('npm', ['ci', '--no-audit', '--no-fund'], { cwd: directory, env: packageEnv, stdio: 'inherit' });
  run('npm', ['run', 'build'], { cwd: directory, env: packageEnv, stdio: 'inherit' });
}
function publishSsr() {
  const image = `${repository}/site-ssr:${environment}-${process.env.SOURCE_SHA.slice(0, 8)}`;
  let exists = false;
  try {
    run('bash', ['.github/actions/release-digest-manifest/resolve-tag-digest.sh', repository, 'octogee', image]);
    exists = true;
  } catch (error) {
    if (error.status !== 3) throw error;
  }
  if (exists) {
    console.log(`Reusing ${image}`);
  } else {
    run('gcloud', ['auth', 'configure-docker', repository.split('/')[0], '--quiet'], { stdio: 'inherit' });
    const builder = `frontend-${process.pid}`;
    run('docker', ['buildx', 'create', '--name', builder, '--driver=docker-container', '--use'], { stdio: 'inherit' });
    try {
      const args = ['buildx', 'build', '--platform=linux/amd64', '--file=site/Dockerfile', `--tag=${image}`, '--provenance=false', '--sbom=false', '--push'];
      const cache = `${repository}/cache/site-ssr:buildcache`;
      try {
        run('bash', ['.github/actions/release-digest-manifest/resolve-tag-digest.sh', repository, 'octogee', cache]);
        args.push(`--cache-from=type=registry,ref=${cache}`);
      } catch (error) {
        if (error.status !== 3) throw error;
      }
      args.push(`--cache-to=type=registry,ref=${cache},mode=max`);
      for (const [key, value] of Object.entries(publicConfig)) args.push('--build-arg', `PUBLIC_${key}=${value}`);
      args.push('--build-arg', `BUILD_SHA=${process.env.SOURCE_SHA}`, '.');
      run('docker', args, { stdio: 'inherit' });
    } finally { run('docker', ['buildx', 'rm', builder], { stdio: 'inherit' }); }
  }
}

publishSsr();
