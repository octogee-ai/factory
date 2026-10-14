import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mainBuild, trackSubmission } from './main-build.mjs';
import { withBuildLock } from './build-lock.mjs';
import { publishSourceArchive } from './source-archive.mjs';
import { gcsObjectIdentityFromMetadata, openclawBaseKey } from '../../.github/actions/openclaw-base-key/base-key.mjs';

const project = 'octogee';
const region = 'us-central1';
const repository = `${region}-docker.pkg.dev/${project}/octogee`;
const serviceAccount = `projects/${project}/serviceAccounts/octogee-ci-build@${project}.iam.gserviceaccount.com`;
const run = (file, args, options = {}) => execFileSync(file, args, { encoding: 'utf8', ...options }).trim();
const execute = (file, args, env = process.env) => new Promise((resolve, reject) => {
  const child = spawn(file, args, { stdio: 'inherit', env });
  const stop = () => child.kill('SIGTERM');
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  child.once('error', reject);
  child.once('exit', code => {
    process.removeListener('SIGTERM', stop);
    process.removeListener('SIGINT', stop);
    if (code === 0) resolve(); else reject(new Error(`${file} exited with ${code}`));
  });
});
async function together(tasks) {
  const outcomes = await Promise.allSettled(tasks);
  const failures = outcomes.filter(result => result.status === 'rejected');
  if (failures.length) throw new AggregateError(failures.map(result => result.reason), 'Builds failed');
}
const sha = process.env.CI_SOURCE_SHA ?? run('git', ['rev-parse', 'HEAD']);
const force = process.argv.includes('--force');
const desktop = process.argv.includes('--desktop-image');
if (desktop) throw new Error('Desktop VM construction is restricted to the explicit GitHub Actions build');
const temporary = mkdtempSync(join(tmpdir(), 'octogee-main-'));
const env = { ...process.env, AR_REPO: repository, AR_REPOSITORY: repository, GCP_PROJECT: project, SOURCE_SHA: sha, SHORT_SHA: sha.slice(0, 7), OCTOGEE_SOURCE_COMMIT: sha, CI_REPO_ROOT: process.cwd(), RUNNER_TEMP: temporary, BASE_SHA: '', RUN_PLATFORM: 'true', RUN_GATEWAY: 'true', RUN_SITE: 'true', DESKTOP_IMAGE_ARTIFACT: '', CI_OUTPUT_FILE: join(temporary, 'output') };
const lookup = ref => {
  try { return run('bash', ['.github/actions/release-digest-manifest/resolve-tag-digest.sh', repository, project, ref]); }
  catch (error) {
    if (error.status === 3) return null;
    throw error;
  }
};
const request = (url, options = {}) => fetch(url, { ...options, headers: { Authorization: `Bearer ${run('gcloud', ['auth', 'print-access-token'])}`, 'Content-Type': 'application/json' } });
const activeBuilds = new Set();
const manifest = () => lookup(`${repository}/release-digest-manifest:${sha}`);
async function submit(config, substitutions, ignoreFile) {
  const substitutionArgs = Object.entries(substitutions).map(([key, value]) => `${key}=${value}`).join(',');
  const id = trackSubmission(() => run('gcloud', ['builds', 'submit', '--async', `--config=${config}`, `--substitutions=${substitutionArgs}`, `--project=${project}`, `--region=${region}`, `--service-account=${serviceAccount}`, '--gcs-source-staging-dir=gs://octogee-ci-source/builds', '--format=value(id)', '--quiet', ...(ignoreFile ? [`--ignore-file=${ignoreFile}`] : [])]), activeBuilds);
  try {
    await execute('bash', ['scripts/lib/wait-for-cloud-build.sh', id, `--project=${project}`, `--region=${region}`, `--label=${config}`]);
    activeBuilds.delete(id);
  } catch (error) {
    const status = run('gcloud', ['builds', 'describe', id, `--project=${project}`, `--region=${region}`, '--format=value(status)']);
    if (['SUCCESS', 'FAILURE', 'CANCELLED', 'EXPIRED', 'INTERNAL_ERROR', 'TIMEOUT'].includes(status)) activeBuilds.delete(id);
    throw error;
  }
}
async function ensureImage(image, config, extra = {}, base = '', ignoreFile) {
  if (lookup(`${repository}/${image}:${sha}`)) {
    console.log(`Reusing immutable ${image}:${sha}${force ? '; --force bypasses fingerprints but cannot replace a published SHA artifact' : ''}`);
    return;
  }
  const short = sha.slice(0, 7);
  let fingerprint = '';
  let exists = !force && lookup(`${repository}/${image}:${short}`);
  if (!exists && !force) {
    const check = run('bash', ['scripts/lib/image-fingerprint-reuse.sh', 'check', image, repository, short, sha, base]);
    fingerprint = check.match(/^fingerprint=(.*)$/m)?.[1] ?? '';
    exists = /^exists=true$/m.test(check);
  }
  if (!exists) {
    await submit(config, { _REGION: region, _IMAGE_TAG: short, ...extra }, ignoreFile);
    if (fingerprint) run('bash', ['scripts/lib/image-fingerprint-reuse.sh', 'record', image, repository, short, fingerprint]);
  }
  run('bash', ['scripts/lib/publish-full-sha-image-tag.sh', image, repository, sha, project]);
}
async function gateway() {
  const current = JSON.parse(readFileSync('infra/gateway/openclaw-tarball/current.json', 'utf8'));
  const objects = [current.openclawObject, current.mattermostObject].map(name => gcsObjectIdentityFromMetadata(JSON.parse(run('gcloud', ['storage', 'objects', 'describe', `gs://octogee-openclaw-fork/${name}`, '--format=json']))));
  const base = openclawBaseKey({ objects, recipeFiles: ['infra/gateway/Dockerfile.base', 'infra/gateway/install-cua-driver-patch.mjs', 'infra/gateway/cua-desktop-discovery.patch', 'infra/gateway/verify-codex-native-hook-runtime.mjs', 'infra/gateway/verify-codex-source-match.mjs', 'infra/gateway/verify-parallel-source-match.mjs', 'cloudbuild-base.yaml'] }).tag;
  if (!lookup(`${repository}/octogee-gateway-base:${base}`)) await submit('cloudbuild-base.yaml', {
    _REGION: region, _BASE_TAG: base, _OPENCLAW_FORK_OBJECT: objects[0].name, _OPENCLAW_FORK_GENERATION: objects[0].generation,
    _OPENCLAW_MATTERMOST_OBJECT: objects[1].name, _OPENCLAW_MATTERMOST_GENERATION: objects[1].generation,
  });
  const files = ['infra/gateway/Dockerfile.builder-base', 'cloudbuild-builder-base.yaml', 'infra/gateway/builder-toolchain/package.json', 'infra/gateway/builder-toolchain/package-lock.json', 'infra/gateway/builder-toolchain/groups.json', 'infra/gateway/builder-toolchain/base-inputs.mjs', 'infra/gateway/stamp-claude-first-run.mjs'];
  const hash = value => createHash('sha256').update(value).digest('hex');
  const recipeHash = hash(files.map(file => `${hash(readFileSync(file))}  ${file}\n`).join('')).slice(0, 12);
  const builderBase = `${base}-builder-${recipeHash}`;
  if (!lookup(`${repository}/octogee-gateway-builder-base:${builderBase}`)) await submit('cloudbuild-builder-base.yaml', { _REGION: region, _GATEWAY_BASE_TAG: base, _BUILDER_BASE_TAG: builderBase });
  await together([
    ensureImage('gateway-edge', 'gateway-edge/cloudbuild.yaml'),
    ensureImage('octogee-gateway', 'cloudbuild.yaml', { _OPENCLAW_BASE_TAG: base }, base),
    ensureImage('octogee-gateway-builder', 'cloudbuild-operator-final.yaml', { COMMIT_SHA: sha, _BUILDER_BASE_TAG: builderBase }, builderBase),
  ]);
}
async function platform() {
  await together([
    ensureImage('glm-controller', 'glm-controller/cloudbuild.yaml'),
    ensureImage('artifact-worker', 'artifact-worker/cloudbuild.yaml'),
    ensureImage('octogee-api', 'octogee-api/cloudbuild.yaml', { _BUILD_RUNNER: 'false' }),
    ensureImage('octogee-project-runner', 'octogee-api/cloudbuild.yaml', { _BUILD_API: 'false' }),
    (async () => {
      if (lookup(`${repository}/octogee-ops-agent:${sha}`)) return;
      await ensureImage('octogee-ops-agent-runtime', 'ops-agent/cloudbuild.yaml', {}, '', '.gcloudignore.ops-agent');
      await execute('bash', ['scripts/ci/ops-agent.sh'], env);
      run('bash', ['scripts/lib/publish-full-sha-image-tag.sh', 'octogee-ops-agent', repository, sha, project]);
    })(),
  ]);
}
try {
  const digest = await mainBuild({ sourceSha: sha, checkoutSha: run('git', ['rev-parse', 'HEAD']), branch: process.env.CI_BRANCH ?? run('git', ['branch', '--show-current']), clean: run('git', ['status', '--porcelain', '--untracked-files=no']) === '', force, desktop }, {
    lookup: manifest,
    lock: task => withBuildLock(sha, request, task, { canRelease: () => activeBuilds.size === 0 }),
    images: async () => {
      run('git', ['merge-base', '--is-ancestor', sha, 'origin/main']);
      env.SOURCE_ARCHIVE_ARTIFACT = JSON.stringify(await publishSourceArchive(sha));
      run('gcloud', ['auth', 'configure-docker', `${region}-docker.pkg.dev`, '--quiet']);
      const prior = run('gcloud', ['builds', 'list', `--project=${project}`, `--region=${region}`, '--filter=tags:octogee-main AND status=SUCCESS', '--sort-by=~createTime', '--limit=1', '--format=value(substitutions.COMMIT_SHA)']);
      if (!force && /^[a-f0-9]{40}$/.test(prior) && spawnSync('/usr/bin/git', ['merge-base', '--is-ancestor', prior, sha]).status === 0 && lookup(`${repository}/release-digest-manifest:${prior}`)) {
        env.BASE_SHA = prior;
        const changed = JSON.parse(run('node', ['.github/actions/release-state-authority/release-inputs.mjs', 'changed', prior, sha]));
        env.RUN_PLATFORM = String(changed.platform);
        env.RUN_GATEWAY = String(changed.platform || changed.gateway);
        env.RUN_SITE = String(changed.site);
      }
      const outcomes = await Promise.allSettled([env.RUN_PLATFORM === 'true' ? platform() : Promise.resolve(), env.RUN_GATEWAY === 'true' ? gateway() : Promise.resolve()]);
      const failures = outcomes.filter(result => result.status === 'rejected');
      if (failures.length) throw new AggregateError(failures.map(result => result.reason), 'Image builds failed');
    },
    frontend: () => env.RUN_SITE === 'true' ? execute('node', ['scripts/ci/frontend.mjs', '--validate-only'], env) : Promise.resolve(),
    publish: async () => {
      await execute('bash', ['scripts/ci/publish-manifest.sh'], env);
      return readFileSync(env.CI_OUTPUT_FILE, 'utf8').trim().split('=')[1];
    },
  });
  console.log(`Immutable main build: ${repository}/release-digest-manifest@${digest}`);
} finally { rmSync(temporary, { recursive: true, force: true }); }
