import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { snapshot } from './snapshot.mjs';

const [lane] = process.argv.slice(2);
if (!/^(units-[123]|emulators|quality)$/.test(lane ?? '')) throw new Error('A valid CI lane is required');
const copy = snapshot(process.cwd(), { sha: process.env.CI_SOURCE_SHA });
const cache = join(dirname(copy.source), 'npm-cache');
try {
  const result = spawnSync('/bin/bash', ['platform/scripts/ci/cloud-checks.sh'], {
    cwd: copy.source,
    env: { ...process.env, CI_CHECKOUT_READY: 'true', CI_CHECK_LANE: lane, npm_config_cache: cache, NPM_CONFIG_CACHE: cache },
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${lane} exited with ${result.status ?? result.signal}`);
} finally { copy.remove(); }
