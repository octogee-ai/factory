import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mainBuild } from './main-build.mjs';
import { withBuildLock } from './build-lock.mjs';
import { publishSourceArchive } from './source-archive.mjs';
import { buildImage, imagePlan } from './image-build.mjs';
import { gcsObjectIdentityFromMetadata, openclawBaseKey } from '../../.github/actions/openclaw-base-key/base-key.mjs';

const project = 'octogee';
const region = 'us-central1';
const repository = `${region}-docker.pkg.dev/${project}/octogee`;
const run = (file, args, options = {}) => execFileSync(file, args, { encoding: 'utf8', ...options }).trim();
let interrupted = false;
const execute = (file, args, env = process.env) => new Promise((resolve, reject) => {
  const child = spawn(file, args, { stdio: 'inherit', env });
  const stop = () => { interrupted = true; child.kill('SIGTERM'); };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  const cleanup = () => { process.removeListener('SIGTERM', stop); process.removeListener('SIGINT', stop); };
  child.once('error', error => { cleanup(); reject(error); });
  child.once('exit', (code, signal) => {
    cleanup();
    if (code === 0) resolve(); else reject(new Error(`${file} exited with ${code ?? signal}`));
  });
});
const sha = process.env.CI_SOURCE_SHA ?? run('git', ['rev-parse', 'HEAD']);
const force = process.argv.includes('--force');
if (process.argv.includes('--desktop-image')) throw new Error('Desktop VM construction requires the explicit desktop workflow');
const temporary = mkdtempSync(join(tmpdir(), 'octogee-main-'));
const env = { ...process.env, AR_REPO: repository, AR_REPOSITORY: repository, GCP_PROJECT: project, SOURCE_SHA: sha, SHORT_SHA: sha.slice(0, 7), OCTOGEE_SOURCE_COMMIT: sha, CI_REPO_ROOT: process.cwd(), RUNNER_TEMP: temporary, BASE_SHA: '', RUN_PLATFORM: 'true', RUN_GATEWAY: 'true', RUN_SITE: 'true', DESKTOP_IMAGE_ARTIFACT: '', CI_OUTPUT_FILE: join(temporary, 'output') };
const lookup = ref => {
  try { return run('bash', ['.github/actions/release-digest-manifest/resolve-tag-digest.sh', repository, project, ref]); }
  catch (error) {
    if (error.status === 3) { return null; }
    throw error;
  }
};
const request = (url, options = {}) => fetch(url, { ...options, headers: { Authorization: `Bearer ${run('gcloud', ['auth', 'print-access-token'])}`, 'Content-Type': 'application/json' } });
const builder = `octogee-${process.pid}`;
let builderCreated = false;
async function build(plan) {
  await buildImage(plan, { run: execute, exists: async ref => Boolean(lookup(ref)) });
  if (process.env.GITHUB_ACTIONS === 'true') await execute('docker', ['buildx', 'prune', '--all', '--force']);
}
async function ensureImage(image, base = '') {
  if (lookup(`${repository}/${image}:${sha}`)) return;
  const short = sha.slice(0, 7);
  let fingerprint = '';
  let exists = !force && lookup(`${repository}/${image}:${short}`);
  if (!exists && !force) {
    const check = run('bash', ['scripts/lib/image-fingerprint-reuse.sh', 'check', image, repository, short, sha, base]);
    fingerprint = check.match(/^fingerprint=(.*)$/m)?.[1] ?? '';
    exists = /^exists=true$/m.test(check);
  }
  if (!exists) {
    await build(imagePlan(image, { repository, sha, base }));
    if (fingerprint) run('bash', ['scripts/lib/image-fingerprint-reuse.sh', 'record', image, repository, short, fingerprint]);
  }
  if (image === 'octogee-gateway-builder') await execute('bash', ['scripts/lib/assert-artifact-image-size.sh', `${repository}/${image}:${short}`, '3100000000', project]);
  run('bash', ['scripts/lib/publish-full-sha-image-tag.sh', image, repository, sha, project]);
}
async function gateway() {
  const current = JSON.parse(readFileSync('infra/gateway/openclaw-tarball/current.json', 'utf8'));
  if (!/^openclaw-fork-[a-f0-9]{8}\.tgz$/.test(current.openclawObject) || !/^openclaw-mattermost-[a-f0-9]{8}\.tgz$/.test(current.mattermostObject)) throw new Error('Invalid pinned OpenClaw objects');
  const objects = [current.openclawObject, current.mattermostObject].map(name => gcsObjectIdentityFromMetadata(JSON.parse(run('gcloud', ['storage', 'objects', 'describe', `gs://octogee-openclaw-fork/${name}`, '--format=json']))));
  const base = openclawBaseKey({ objects, recipeFiles: ['.dockerignore', 'infra/gateway/Dockerfile.base', 'infra/gateway/install-cua-driver-patch.mjs', 'infra/gateway/cua-desktop-discovery.patch', 'infra/gateway/verify-codex-native-hook-runtime.mjs', 'infra/gateway/verify-codex-source-match.mjs', 'infra/gateway/verify-parallel-source-match.mjs', 'scripts/ci/image-build.mjs', 'scripts/ci/run-main.mjs', 'scripts/ci/verify-gateway-base.sh'] }).tag;
  for (const [name, target] of [['octogee-gateway-core', 'gateway-core-runtime'], ['octogee-gateway-base', 'gateway-runtime']]) {
    if (lookup(`${repository}/${name}:${base}`)) continue;
    for (const [i, destination] of ['openclaw-fork.tgz', 'openclaw-mattermost-fork.tgz'].entries()) {
      const object = objects[i];
      await execute('gcloud', ['storage', 'cp', `gs://${object.bucket}/${object.name}#${object.generation}`, `infra/gateway/openclaw-tarball/${destination}`]);
    }
    await build({ dockerfile: 'infra/gateway/Dockerfile.base', target, tag: `${repository}/${name}:${base}`, cache: `${repository}/cache/${name}:buildcache` });
  }
  await execute('bash', ['scripts/ci/verify-gateway-base.sh', `${repository}/octogee-gateway-base:${base}`]);
  const files = ['infra/gateway/Dockerfile.builder-base', 'infra/gateway/builder-toolchain/package.json', 'infra/gateway/builder-toolchain/package-lock.json', 'infra/gateway/builder-toolchain/groups.json', 'infra/gateway/builder-toolchain/base-inputs.mjs', 'infra/gateway/stamp-claude-first-run.mjs', 'scripts/ci/image-build.mjs', 'scripts/ci/run-main.mjs'];
  const hash = value => createHash('sha256').update(value).digest('hex');
  const recipeHash = hash(files.map(file => `${hash(readFileSync(file))}  ${file}\n`).join('')).slice(0, 12);
  const builderBase = `${base}-builder-${recipeHash}`;
  if (!lookup(`${repository}/octogee-gateway-builder-base:${builderBase}`)) await build({
    dockerfile: 'infra/gateway/Dockerfile.builder-base', tag: `${repository}/octogee-gateway-builder-base:${builderBase}`,
    cache: `${repository}/cache/octogee-gateway-builder-base:buildcache`,
    buildArgs: {
      GATEWAY_BASE_IMAGE: `${repository}/octogee-gateway-base:${base}`,
      BUILDER_TOOLCHAIN_LOCK_SHA256: hash(readFileSync('infra/gateway/builder-toolchain/package-lock.json')),
      BUILDER_TOOL_GROUPS_SHA256: hash(readFileSync('infra/gateway/builder-toolchain/groups.json')),
    },
  });
  await ensureImage('gateway-edge');
  await ensureImage('octogee-gateway', base);
  await ensureImage('octogee-gateway-builder', builderBase);
}
async function platform() {
  for (const image of ['glm-controller', 'artifact-worker', 'octogee-api', 'octogee-project-runner']) await ensureImage(image);
  if (!lookup(`${repository}/octogee-ops-agent:${sha}`)) {
    await ensureImage('octogee-ops-agent-runtime');
    await execute('bash', ['scripts/ci/ops-agent.sh'], env);
    run('bash', ['scripts/lib/publish-full-sha-image-tag.sh', 'octogee-ops-agent', repository, sha, project]);
  }
}
try {
  const digest = await mainBuild({ sourceSha: sha, checkoutSha: run('git', ['rev-parse', 'HEAD']), branch: process.env.CI_BRANCH ?? run('git', ['branch', '--show-current']), clean: run('git', ['status', '--porcelain', '--untracked-files=no']) === '', force }, {
    lookup: () => lookup(`${repository}/release-digest-manifest:${sha}`),
    lock: task => withBuildLock(sha, request, task, { canRelease: () => !interrupted }),
    images: async () => {
      run('git', ['merge-base', '--is-ancestor', sha, 'origin/main']);
      env.SOURCE_ARCHIVE_ARTIFACT = JSON.stringify(await publishSourceArchive(sha));
      run('gcloud', ['auth', 'configure-docker', `${region}-docker.pkg.dev`, '--quiet']);
      await execute('docker', ['buildx', 'create', '--name', builder, '--driver=docker-container', '--use']);
      builderCreated = true;
      const prior = process.env.CI_BASE_SHA ?? '';
      if (!force && /^[a-f0-9]{40}$/.test(prior) && spawnSync('/usr/bin/git', ['merge-base', '--is-ancestor', prior, sha]).status === 0 && lookup(`${repository}/release-digest-manifest:${prior}`)) {
        env.BASE_SHA = prior;
        const changed = JSON.parse(run('node', ['.github/actions/release-state-authority/release-inputs.mjs', 'changed', prior, sha]));
        env.RUN_PLATFORM = String(changed.platform);
        env.RUN_GATEWAY = String(changed.platform || changed.gateway);
        env.RUN_SITE = String(changed.site);
      }
      if (env.RUN_PLATFORM === 'true') await platform();
      if (env.RUN_GATEWAY === 'true') await gateway();
    },
    frontend: () => env.RUN_SITE === 'true' ? execute('node', ['scripts/ci/frontend.mjs', '--validate-only'], env) : Promise.resolve(),
    publish: async () => {
      await execute('bash', ['scripts/ci/publish-manifest.sh'], env);
      return readFileSync(env.CI_OUTPUT_FILE, 'utf8').trim().split('=')[1];
    },
  });
  console.log(`Immutable main build: ${repository}/release-digest-manifest@${digest}`);
} finally {
  if (builderCreated && !interrupted) await execute('docker', ['buildx', 'rm', builder]);
  rmSync(temporary, { recursive: true, force: true });
}
