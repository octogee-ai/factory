import { execFileSync, spawnSync } from 'node:child_process';
import { snapshot } from './snapshot.mjs';

const root = execFileSync('/usr/bin/git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
const copy = snapshot(root, { working: true });
try {
  const image = process.env.OCTOGEE_CI_IMAGE ?? 'us-central1-docker.pkg.dev/octogee/octogee-ci/linux:2026-10-13-3';
  const docker = execFileSync('/usr/bin/which', ['docker'], { encoding: 'utf8' }).trim();
  const result = spawnSync(docker, ['run', '--rm', '--platform=linux/amd64', '--env=CI_EMULATED=true', '--mount', `type=bind,src=${copy.source},dst=/workspace`, '--workdir=/workspace', image, '-euc', 'npm ci --prefix scripts --no-audit --no-fund; scripts/node_modules/.bin/tsx scripts/ops/ci-checks.ts "$@"', '--', ...process.argv.slice(2)], { stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Local checks exited with ${result.status ?? result.signal}`);
} finally { copy.remove(); }
