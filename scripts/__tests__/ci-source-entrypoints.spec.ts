import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const { actual, command, deploymentSource, worktreeSource, resolveRelease } = vi.hoisted(() => ({
  actual: {} as typeof import('node:child_process'),
  command: vi.fn(), deploymentSource: vi.fn(), worktreeSource: vi.fn(), resolveRelease: vi.fn(),
}));
vi.mock('node:child_process', async original => {
  Object.assign(actual, await original<typeof import('node:child_process')>());
  return { ...actual, execFileSync: command };
});
vi.mock('../ci/snapshot.mjs', async original => ({ ...await original<object>(), deploymentSource, worktreeSource }));
vi.mock('../ci/release-source.mjs', () => ({ resolveRelease }));
vi.mock('../ci/actions-dispatch.mjs', () => ({ dispatchWorkflow: vi.fn() }));

const sha = 'a'.repeat(40);
const argv = process.argv;
const environment = { ...process.env };
let fixture: string;
let record: string;

const RECORDING_ENTRYPOINT = `import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { relative } from 'node:path';
const manifest = process.env.CI_RELEASE_MANIFEST ? JSON.parse(readFileSync(process.env.CI_RELEASE_MANIFEST, 'utf8')) : null;
writeFileSync(process.env.ENTRYPOINT_RECORD, JSON.stringify({
  entrypoint: relative(realpathSync(process.cwd()), realpathSync(process.argv[1])),
  args: process.argv.slice(2), manifest, branch: process.env.CI_BRANCH, sourceSha: process.env.CI_SOURCE_SHA,
}));
`;

function sourceTree(entrypoint: string) {
  const file = join(fixture, 'source', entrypoint);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, RECORDING_ENTRYPOINT);
  return { source: join(fixture, 'source'), remove: vi.fn() };
}

const recorded = () => JSON.parse(readFileSync(record, 'utf8'));

beforeEach(() => {
  vi.resetModules();
  vi.resetAllMocks();
  fixture = realpathSync(mkdtempSync(join(tmpdir(), 'ci-source-entrypoints-')));
  record = join(fixture, 'record.json');
  process.env.ENTRYPOINT_RECORD = record;
  command.mockImplementation((file: string, args: string[], options?: object) => {
    if (file === '/usr/bin/git') return args.includes('--show-toplevel') ? `${fixture}\n` : '';
    return actual.execFileSync(file, args, options);
  });
});
afterEach(() => {
  process.argv = argv;
  process.env = { ...environment };
  rmSync(fixture, { recursive: true, force: true });
});

it.each([
  ['the platform layout', 'platform/scripts/ci/release.mjs'],
  ['the pre-move layout', 'scripts/ci/release.mjs'],
])('deploys a SHA in %s through the release entrypoint its own tree carries', async (_layout, entrypoint) => {
  const copy = sourceTree(entrypoint);
  deploymentSource.mockReturnValue(copy);
  resolveRelease.mockResolvedValue({ manifest: { sourceSha: sha }, digest: 'sha256:fixture' });
  process.argv = [...argv.slice(0, 2), '--local', `--sha=${sha}`, '--environment=prod', '--actor=operator:test', '--ship-prod'];
  await import('../ci/deploy.mjs');
  expect(deploymentSource).toHaveBeenCalledWith(fixture, sha);
  expect(recorded()).toMatchObject({
    entrypoint, args: [`--sha=${sha}`, '--environment=prod', '--actor=operator:test', '--ship-prod'], manifest: { sourceSha: sha },
  });
  expect(copy.remove).toHaveBeenCalled();
});

it('refuses a deploy whose exported tree carries no release entrypoint', async () => {
  const copy = sourceTree('README.md');
  deploymentSource.mockReturnValue(copy);
  resolveRelease.mockResolvedValue({ manifest: { sourceSha: sha }, digest: 'sha256:fixture' });
  process.argv = [...argv.slice(0, 2), '--local', `--sha=${sha}`, '--environment=test', '--actor=operator:test'];
  await expect(import('../ci/deploy.mjs')).rejects.toThrow(`${copy.source} carries no release.mjs in platform/scripts/ci or scripts/ci`);
  expect(copy.remove).toHaveBeenCalled();
});

it.each([
  ['the platform layout', 'platform/scripts/ci/run-main.mjs'],
  ['the pre-move layout', 'scripts/ci/run-main.mjs'],
])('builds a main SHA in %s through the build entrypoint its own tree carries', async (_layout, entrypoint) => {
  const copy = sourceTree(entrypoint);
  worktreeSource.mockReturnValue(copy);
  process.env.CI_SOURCE_SHA = sha;
  process.env.CI_BRANCH = 'main';
  process.argv = [...argv.slice(0, 2), '--force'];
  await import('../ci/main.mjs');
  expect(worktreeSource).toHaveBeenCalledWith(fixture, sha);
  expect(recorded()).toMatchObject({ entrypoint, args: ['--force'], branch: 'main', sourceSha: sha });
  expect(copy.remove).toHaveBeenCalled();
});
