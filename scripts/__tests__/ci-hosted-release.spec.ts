import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const { command, dispatch, resolveRelease } = vi.hoisted(() => ({
  command: vi.fn(), dispatch: vi.fn(), resolveRelease: vi.fn(),
}));
vi.mock('node:child_process', () => ({ execFileSync: command }));
vi.mock('../ci/actions-dispatch.mjs', () => ({ dispatchWorkflow: dispatch }));
vi.mock('../ci/release-source.mjs', () => ({ resolveRelease, downloadReleaseSource: vi.fn() }));
const argv = process.argv;
const sha = 'a'.repeat(40);
beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  process.argv = [...argv.slice(0, 2), `--sha=${sha}`, '--actor=operator:test'];
});
afterEach(() => { process.argv = argv; });

it('dispatches deployment without running the local release engine', async () => {
  process.argv.push('--environment=prod', '--post-deploy-checks');
  await import('../ci/deploy.mjs');
  expect(dispatch).toHaveBeenCalledWith('deploy.yml', {
    source_sha: sha, environment: 'prod', actor: 'operator:test',
    log_level: 'chart-default', post_deploy_checks: 'true',
  });
  expect(resolveRelease).not.toHaveBeenCalled();
  expect(command).not.toHaveBeenCalled();
});

it('rejects hosted fleet authority outside Ship TEST', async () => {
  process.argv.push('--environment=test', '--ship-test');
  await expect(import('../ci/deploy.mjs')).rejects.toThrow('Use ci:ship-test');
  expect(dispatch).not.toHaveBeenCalled();
});

it('dispatches Ship TEST as one workflow with its selected SHA', async () => {
  process.argv.push('--force', '--log-level=debug');
  await import('../ci/ship-test.mjs');
  expect(dispatch).toHaveBeenCalledWith('ship-test.yml', {
    source_sha: sha, force: 'true', actor: 'operator:test', log_level: 'debug',
  });
  expect(command).not.toHaveBeenCalled();
});

it('rejects conflicting environments before hosted Ship TEST', async () => {
  process.argv.push('--environment=prod');
  await expect(import('../ci/ship-test.mjs')).rejects.toThrow('Duplicate environment');
  expect(dispatch).not.toHaveBeenCalled();
});

it('keeps local Ship TEST build-before-deploy and stops after a failed build', async () => {
  process.argv.push('--local');
  command.mockImplementationOnce(() => { throw new Error('build failed'); });
  await expect(import('../ci/ship-test.mjs')).rejects.toThrow('build failed');
  expect(command).toHaveBeenCalledOnce();
  expect(command.mock.calls[0][1]).toEqual(['scripts/ci/main.mjs']);
  expect(dispatch).not.toHaveBeenCalled();
});
