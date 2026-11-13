import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it } from 'vitest';

const entrypoint = fileURLToPath(new URL('../ci/check-lane.mjs', import.meta.url));
const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'octogee-ci-lane-test-'));
  directories.push(root);
  const repository = join(root, 'repository');
  mkdirSync(join(repository, 'platform/scripts/ci'), { recursive: true });
  writeFileSync(join(repository, 'platform/scripts/ci/cloud-checks.sh'), `#!/usr/bin/env bash
set -euo pipefail
node --input-type=module <<'JS'
import { execFileSync } from 'node:child_process';
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
const cache = execFileSync('npm', ['config', 'get', 'cache'], { encoding: 'utf8' }).trim();
mkdirSync(cache, { recursive: true });
writeFileSync(join(cache, 'lane'), process.env.CI_CHECK_LANE);
console.log(JSON.stringify({ cache, cacheParent: realpathSync(dirname(cache)), lower: process.env.npm_config_cache, upper: process.env.NPM_CONFIG_CACHE, source: process.cwd(), lane: process.env.CI_CHECK_LANE }));
process.exit(Number(process.env.CI_FIXTURE_EXIT ?? 0));
JS
`);
  const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=CI fixture', '-c', 'user.email=ci@example.invalid', '-c', 'commit.gpgSign=false', '-c', 'core.hooksPath=/dev/null', ...args], { cwd: repository, stdio: 'pipe' });
  git('init', '-q', '-b', 'main');
  git('add', '.');
  git('commit', '-qm', 'Fixture');
  git('update-ref', 'refs/remotes/origin/main', 'HEAD');
  const shared = join(root, 'shared-cache');
  return {
    shared,
    run: (lane: string, exit = 0) => spawnSync(process.execPath, [entrypoint, lane], {
      cwd: repository,
      env: { ...process.env, CI_SOURCE_SHA: 'HEAD', CI_FIXTURE_EXIT: String(exit), npm_config_cache: shared, NPM_CONFIG_CACHE: shared },
      encoding: 'utf8',
    }),
  };
}

it('gives separate CI lanes their own npm cache instead of the inherited shared home cache', () => {
  const test = fixture();
  const results = ['units-1', 'quality'].map(lane => {
    const result = test.run(lane);
    expect(result.status, result.stderr).toBe(0);
    return JSON.parse(result.stdout);
  });
  expect(results[0].cache).not.toBe(results[1].cache);
  for (const result of results) {
    expect(result.cache).not.toBe(test.shared);
    expect(result.cacheParent).toBe(dirname(result.source));
    expect(result.lower).toBe(result.cache);
    expect(result.upper).toBe(result.cache);
    expect(existsSync(result.cache)).toBe(false);
  }
  expect(existsSync(test.shared)).toBe(false);
});

it('removes the private npm cache when a lane fails and preserves its failure', () => {
  const test = fixture();
  const result = test.run('quality', 7);
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain('quality exited with 7');
  const observation = JSON.parse(result.stdout);
  expect(observation.cache).not.toBe(test.shared);
  expect(existsSync(observation.cache)).toBe(false);
  expect(existsSync(test.shared)).toBe(false);
});
