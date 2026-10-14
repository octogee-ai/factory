import { execFileSync } from 'node:child_process';
import { snapshot } from './snapshot.mjs';

const [kind, ...args] = process.argv.slice(2);
if (kind !== 'main' || args.some(arg => arg !== '--force' && !/^--sha=[a-f0-9]{40}$/.test(arg))) throw new Error('usage: npm run ci:submit -- main [--sha=<main SHA>] [--force]; desktop builds use the explicit GitHub Actions job');
const git = values => execFileSync('/usr/bin/git', values, { encoding: 'utf8' }).trim();
const sha = args.find(value => value.startsWith('--sha='))?.slice(6) ?? git(['rev-parse', 'HEAD']);
if (!/^[a-f0-9]{40}$/.test(sha)) throw new Error('A full source SHA is required');
git(['merge-base', '--is-ancestor', sha, 'origin/main']);
const copy = snapshot(git(['rev-parse', '--show-toplevel']), { sha });
const gcloud = execFileSync('/usr/bin/which', ['gcloud'], { encoding: 'utf8' }).trim();
try {
  const id = execFileSync(gcloud, ['builds', 'submit', copy.source, '--async', '--config=ci/cloudbuild-main.yaml', '--project=octogee', '--region=us-central1', '--service-account=projects/octogee/serviceAccounts/octogee-ci-build@octogee.iam.gserviceaccount.com', '--gcs-source-staging-dir=gs://octogee-ci-source/builds', '--ignore-file=.gcloudignore.ci', `--substitutions=BRANCH_NAME=main,COMMIT_SHA=${sha},SHORT_SHA=${sha.slice(0, 7)},_SOURCE_SHA=${sha},_FORCE_REBUILD=${args.includes('--force')},_LOCAL_SOURCE=true`, '--format=value(id)', '--quiet'], { encoding: 'utf8' }).trim();
  if (!id) throw new Error('Cloud Build submission returned no build ID');
  execFileSync('/bin/bash', ['scripts/lib/wait-for-cloud-build.sh', id, '--project=octogee', '--region=us-central1', '--timeout=10800', '--label=Build main'], { stdio: 'inherit' });
} finally { copy.remove(); }
