import { execFileSync } from 'node:child_process';
import { releaseOptions } from './release-plan.mjs';

const args = process.argv.slice(2);
const local = args.includes('--local');
const force = args.includes('--force');
const sha = args.find(arg => arg.startsWith('--sha='))?.slice(6) ?? execFileSync('/usr/bin/git', ['rev-parse', 'origin/main'], { encoding: 'utf8' }).trim();
const releaseArgs = [...args.filter(arg => arg !== '--local' && arg !== '--force' && !arg.startsWith('--sha=')), `--sha=${sha}`, '--environment=test', '--ship-test', '--post-deploy-checks'];
releaseOptions(releaseArgs);
const run = (values, env = process.env) => execFileSync(process.execPath, values, { stdio: 'inherit', env });
if (local) run(['scripts/ci/main.mjs', ...(force ? ['--force'] : [])], { ...process.env, CI_SOURCE_SHA: sha, CI_BRANCH: 'main' });
else run(['scripts/ci/submit.mjs', 'main', `--sha=${sha}`, ...(force ? ['--force'] : [])]);
run(['scripts/ci/deploy.mjs', ...releaseArgs, ...(local ? ['--local'] : [])]);
