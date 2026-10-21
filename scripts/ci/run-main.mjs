import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mainBuild } from './main-build.mjs';
import { withBuildLock } from './build-lock.mjs';
import { buildImage, buildSummary, builderBaseRecipe, ensureImage as ensureRegistryImage, gatewayBaseRecipe } from './image-build.mjs';
import { buildGatewayImages } from './gateway-bake.mjs';
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
const env = { ...process.env, AR_REPO: repository, AR_REPOSITORY: repository, GCP_PROJECT: project, SOURCE_SHA: sha, SHORT_SHA: sha.slice(0, 7), OCTOGEE_SOURCE_COMMIT: sha, CI_REPO_ROOT: process.cwd(), RUNNER_TEMP: temporary, BASE_SHA: '', RUN_PLATFORM: 'true', RUN_GATEWAY: 'true', DESKTOP_IMAGE_ARTIFACT: '', CI_OUTPUT_FILE: join(temporary, 'output') };
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
const summary = [];
const ensureImage = async image => summary.push(await ensureRegistryImage(image, { repository, sha, force }, {
  exists: async ref => Boolean(lookup(ref)),
  script: async (file, args) => run('bash', [file, ...args]),
  build,
}));
let pinned;
const openclawObjects = () => pinned ??= (() => {
  const current = JSON.parse(readFileSync('infra/gateway/openclaw-tarball/current.json', 'utf8'));
  if (!/^openclaw-fork-[a-f0-9]{8}\.tgz$/.test(current.openclawObject) || !/^openclaw-mattermost-[a-f0-9]{8}\.tgz$/.test(current.mattermostObject)) throw new Error('Invalid pinned OpenClaw objects');
  return [current.openclawObject, current.mattermostObject].map(name => gcsObjectIdentityFromMetadata(JSON.parse(run('gcloud', ['storage', 'objects', 'describe', `gs://octogee-openclaw-fork/${name}`, '--format=json']))));
})();
let downloaded;
const openclawTarballs = () => downloaded ??= (async () => {
  const destinations = ['infra/gateway/openclaw-tarball/openclaw-fork.tgz', 'infra/gateway/openclaw-tarball/openclaw-mattermost-fork.tgz'];
  for (const [i, object] of openclawObjects().entries()) await execute('gcloud', ['storage', 'cp', `gs://${object.bucket}/${object.name}#${object.generation}`, destinations[i]]);
  return destinations[0];
})();
async function gateway() {
  const base = openclawBaseKey({ objects: openclawObjects(), recipeFiles: gatewayBaseRecipe() }).tag;
  const hash = value => createHash('sha256').update(value).digest('hex');
  const recipeHash = hash(builderBaseRecipe().map(file => `${hash(readFileSync(file))}  ${file}\n`).join('')).slice(0, 12);
  const toolchain = {
    lockSha256: hash(readFileSync('infra/gateway/builder-toolchain/package-lock.json')),
    groupsSha256: hash(readFileSync('infra/gateway/builder-toolchain/groups.json')),
  };
  summary.push(...await buildGatewayImages({ repository, sha, base, builderBase: `${base}-builder-${recipeHash}`, toolchain, force }, {
    exists: async ref => Boolean(lookup(ref)),
    script: async (file, args) => run('bash', [file, ...args]),
    prepareBase: openclawTarballs,
    bake: async plan => {
      const file = join(temporary, 'gateway-bake.json');
      writeFileSync(file, JSON.stringify(plan));
      await execute('docker', ['buildx', 'bake', `--file=${file}`]);
      if (process.env.GITHUB_ACTIONS === 'true') await execute('docker', ['buildx', 'prune', '--all', '--force']);
    },
  }));
}
async function platform() {
  for (const image of ['glm-controller', 'artifact-worker', 'octogee-api', 'octogee-project-runner']) await ensureImage(image);
  const started = Date.now();
  const reused = Boolean(lookup(`${repository}/octogee-ops-agent:${sha}`));
  if (!reused) {
    await ensureImage('octogee-ops-agent-runtime');
    await execute('bash', ['scripts/ci/ops-agent.sh'], env);
    run('bash', ['scripts/lib/publish-full-sha-image-tag.sh', 'octogee-ops-agent', repository, sha, project]);
  }
  summary.push({ image: 'octogee-ops-agent', tag: sha.slice(0, 7), result: reused ? 'reused (full-SHA tag)' : 'built', seconds: Math.round((Date.now() - started) / 1000) });
}
try {
  const digest = await mainBuild({ sourceSha: sha, checkoutSha: run('git', ['rev-parse', 'HEAD']), branch: process.env.CI_BRANCH ?? run('git', ['branch', '--show-current']), clean: run('git', ['status', '--porcelain', '--untracked-files=no']) === '', force }, {
    lookup: () => lookup(`${repository}/release-digest-manifest:${sha}`),
    lock: task => withBuildLock(sha, request, task, { canRelease: () => !interrupted }),
    images: async () => {
      run('git', ['merge-base', '--is-ancestor', sha, 'origin/main']);
      run('gcloud', ['auth', 'configure-docker', `${region}-docker.pkg.dev`, '--quiet']);
      await execute('docker', ['buildx', 'create', '--name', builder, '--driver=docker-container', '--use']);
      builderCreated = true;
      const prior = process.env.CI_BASE_SHA ?? '';
      if (!force && /^[a-f0-9]{40}$/.test(prior) && spawnSync('/usr/bin/git', ['merge-base', '--is-ancestor', prior, sha]).status === 0 && lookup(`${repository}/release-digest-manifest:${prior}`)) {
        env.BASE_SHA = prior;
        const changed = JSON.parse(run('node', ['.github/actions/release-state-authority/release-inputs.mjs', 'changed', prior, sha]));
        env.RUN_PLATFORM = String(changed.platform);
        env.RUN_GATEWAY = String(changed.platform || changed.gateway);
      }
      if (env.RUN_PLATFORM === 'true') await platform();
      if (env.RUN_GATEWAY === 'true') await gateway();
    },
    publish: async () => {
      env.OPENCLAW_TARBALL = await openclawTarballs();
      await execute('bash', ['scripts/ci/publish-manifest.sh'], env);
      return readFileSync(env.CI_OUTPUT_FILE, 'utf8').trim().split('=')[1];
    },
  });
  console.log(`Immutable main build: ${repository}/release-digest-manifest@${digest}`);
} finally {
  if (process.env.GITHUB_STEP_SUMMARY && summary.length) appendFileSync(process.env.GITHUB_STEP_SUMMARY, buildSummary(summary));
  if (builderCreated && !interrupted) await execute('docker', ['buildx', 'rm', builder]);
  rmSync(temporary, { recursive: true, force: true });
}
