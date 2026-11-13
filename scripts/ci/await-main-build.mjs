import { ensureMainBuild } from './main-build.mjs';
import { findCompleteRelease } from './release-source.mjs';
import { awaitRun, dispatchWorkflow, findRunningRun } from './actions-dispatch.mjs';

const args = process.argv.slice(2);
const sha = args.find(arg => arg.startsWith('--sha='))?.slice(6);
if (!/^[a-f0-9]{40}$/.test(sha ?? '') || args.some(arg => arg !== '--force' && !arg.startsWith('--sha='))) throw new Error('usage: await-main-build.mjs --sha=<main SHA> [--force]');
await ensureMainBuild(sha, {
  manifest: findCompleteRelease,
  active: value => findRunningRun('build-main.yml', value),
  watch: id => awaitRun(id),
  build: () => dispatchWorkflow('build-main.yml', { source_sha: sha, force: String(args.includes('--force')) }),
});
console.log(`Immutable main build ready: ${sha}`);
