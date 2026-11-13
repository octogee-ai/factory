import { execFileSync, spawnSync } from 'node:child_process';
import { sourceCiScript, worktreeSource } from './snapshot.mjs';

const git = args => execFileSync('/usr/bin/git', args, { encoding: 'utf8' }).trim();
const sha = process.env.CI_SOURCE_SHA ?? git(['rev-parse', 'HEAD']);
const branch = process.env.CI_BRANCH ?? git(['branch', '--show-current']);
if (process.argv.includes('--desktop-image')) throw new Error('Desktop VM builds require the explicit Build main with desktop VM GitHub Actions job');
if (branch !== 'main' || !/^[a-f0-9]{40}$/.test(sha)) throw new Error('Main builds require a full main commit SHA');
git(['merge-base', '--is-ancestor', sha, 'origin/main']);
const copy = worktreeSource(git(['rev-parse', '--show-toplevel']), sha);
try {
  const result = spawnSync(process.execPath, [sourceCiScript(copy.source, 'run-main.mjs'), ...process.argv.slice(2)], {
    cwd: copy.source, stdio: 'inherit', env: { ...process.env, CI_SOURCE_SHA: sha, CI_BRANCH: 'main' },
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Main build exited with ${result.status ?? result.signal}`);
} finally { copy.remove(); }
