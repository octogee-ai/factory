import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { imageTag } from './toolchain-image.mjs';
import { snapshot } from './snapshot.mjs';

const root = execFileSync('/usr/bin/git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
const copy = snapshot(root, { working: true });
try {
  const docker = execFileSync('/usr/bin/which', ['docker'], { encoding: 'utf8' }).trim();
  const image = process.env.OCTOGEE_CI_IMAGE || imageTag(
    readFileSync(join(copy.source, 'ci/Dockerfile')),
    readFileSync(join(copy.source, 'ci/install-tools.sh')), 'amd64',
  );
  if (!process.env.OCTOGEE_CI_IMAGE) execFileSync(docker, [
    'build', '--platform=linux/amd64', '--file=ci/Dockerfile', `--tag=${image}`, 'ci',
  ], { cwd: copy.source, stdio: 'inherit' });
  const result = spawnSync(docker, ['run', '--rm', '--platform=linux/amd64', '--env=CI_EMULATED=true', '--mount', `type=bind,src=${copy.source},dst=/workspace`, '--workdir=/workspace', image, '-euc', 'npm ci --prefix scripts --no-audit --no-fund; scripts/node_modules/.bin/tsx scripts/ops/ci-checks.ts "$@"', '--', ...process.argv.slice(2)], { stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Local checks exited with ${result.status ?? result.signal}`);
} finally { copy.remove(); }
