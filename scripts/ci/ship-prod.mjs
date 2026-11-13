import { execFileSync } from 'node:child_process';
import { releaseOptions } from './release-plan.mjs';
import { dispatchWorkflow } from './actions-dispatch.mjs';

const args = process.argv.slice(2);
const local = args.includes('--local');
const sha = args.find(arg => arg.startsWith('--sha='))?.slice(6) ?? execFileSync('/usr/bin/git', ['rev-parse', 'origin/main'], { encoding: 'utf8' }).trim();
const releaseArgs = [...args.filter(arg => arg !== '--local' && !arg.startsWith('--sha=')), `--sha=${sha}`, '--environment=prod', '--ship-prod', '--post-deploy-checks'];
const options = releaseOptions(releaseArgs);
if (local) {
  execFileSync(process.execPath, ['platform/scripts/ci/deploy.mjs', ...releaseArgs, '--local'], { stdio: 'inherit' });
} else {
  await dispatchWorkflow('deploy.yml', { source_sha: sha, environment: 'prod', actor: options.actor, log_level: options.logLevel, post_deploy_checks: 'true', ship_prod: 'true' });
}
