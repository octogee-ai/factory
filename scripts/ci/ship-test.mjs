import { execFileSync } from 'node:child_process';
import { releaseOptions } from './release-plan.mjs';
import { ensureMainBuild } from './main-build.mjs';
import { findCompleteRelease } from './release-source.mjs';
import { awaitRun, dispatchWorkflow, findRunningRun } from './actions-dispatch.mjs';

const args = process.argv.slice(2);
const local = args.includes('--local');
const force = args.includes('--force');
const sha = args.find(arg => arg.startsWith('--sha='))?.slice(6) ?? execFileSync('/usr/bin/git', ['rev-parse', 'origin/main'], { encoding: 'utf8' }).trim();
const releaseArgs = [...args.filter(arg => arg !== '--local' && arg !== '--force' && !arg.startsWith('--sha=')), `--sha=${sha}`, '--environment=test', '--ship-test', '--post-deploy-checks'];
const options = releaseOptions(releaseArgs);
const run = (values, env = process.env) => execFileSync(process.execPath, values, { stdio: 'inherit', env });
if (local) {
  await ensureMainBuild(sha, {
    manifest: findCompleteRelease,
    active: value => findRunningRun('build-main.yml', value),
    watch: id => awaitRun(id),
    build: () => dispatchWorkflow('build-main.yml', { source_sha: sha, force: String(force) }),
  });
  run(['scripts/ci/deploy.mjs', ...releaseArgs, '--local']);
  run(['scripts/ci/end-to-end-tests.mjs'], { ...process.env, CI_LIVE_RESTART: 'true' });
} else {
  await dispatchWorkflow('ship-test.yml', { source_sha: sha, force: String(force), actor: options.actor, log_level: options.logLevel });
}
