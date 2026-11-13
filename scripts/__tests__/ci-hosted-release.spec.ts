import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const { command, dispatch, resolveRelease, findCompleteRelease, findRunningRun, awaitRun } = vi.hoisted(() => ({
  command: vi.fn(), dispatch: vi.fn(), resolveRelease: vi.fn(), findCompleteRelease: vi.fn(), findRunningRun: vi.fn(), awaitRun: vi.fn(),
}));
vi.mock('node:child_process', () => ({ execFileSync: command }));
vi.mock('../ci/actions-dispatch.mjs', () => ({ dispatchWorkflow: dispatch, findRunningRun, awaitRun }));
vi.mock('../ci/release-source.mjs', () => ({ resolveRelease, findCompleteRelease }));
const argv = process.argv;
const sha = 'a'.repeat(40);
beforeEach(() => {
  vi.resetModules();
  vi.resetAllMocks();
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

it('dispatches Ship PROD for the selected existing build', async () => {
  await import('../ci/ship-prod.mjs');
  expect(dispatch).toHaveBeenCalledWith('deploy.yml', {
    source_sha: sha, environment: 'prod', actor: 'operator:test', log_level: 'chart-default', post_deploy_checks: 'true', ship_prod: 'true',
  });
  expect(command).not.toHaveBeenCalled();
});

it('rejects conflicting environments before hosted Ship TEST', async () => {
  process.argv.push('--environment=prod');
  await expect(import('../ci/ship-test.mjs')).rejects.toThrow('Duplicate environment');
  expect(dispatch).not.toHaveBeenCalled();
});

const deployCall = (call: unknown[]) => (call[1] as string[])[0] === 'platform/scripts/ci/deploy.mjs';
const buildCall = (call: unknown[]) => (call[1] as string[])[0] === 'platform/scripts/ci/main.mjs';

it('deploys a complete image family locally without starting a competing build', async () => {
  process.argv.push('--local');
  findCompleteRelease.mockResolvedValue({ manifest: { sourceSha: sha } });
  await import('../ci/ship-test.mjs');
  expect(command.mock.calls.some(buildCall)).toBe(false);
  expect(command.mock.calls.filter(deployCall)).toHaveLength(1);
  expect(findRunningRun).toHaveBeenCalledWith('build-main.yml', sha);
});

it('waits for an in-flight Build main run before a local deploy', async () => {
  process.argv.push('--local');
  findCompleteRelease.mockResolvedValue({ manifest: { sourceSha: sha } });
  findRunningRun.mockResolvedValue(42);
  awaitRun.mockResolvedValue({ id: 42, url: 'run-42', conclusion: 'success' });
  await import('../ci/ship-test.mjs');
  expect(findRunningRun).toHaveBeenCalledWith('build-main.yml', sha);
  expect(awaitRun).toHaveBeenCalledWith(42);
  expect(command.mock.calls.some(buildCall)).toBe(false);
  expect(command.mock.calls.filter(deployCall)).toHaveLength(1);
});

it('requests the hosted image family when missing, and stops after a failed build', async () => {
  process.argv.push('--local');
  findCompleteRelease.mockResolvedValue(null);
  findRunningRun.mockResolvedValue(null);
  dispatch.mockRejectedValueOnce(new Error('build failed'));
  await expect(import('../ci/ship-test.mjs')).rejects.toThrow('build failed');
  expect(command).not.toHaveBeenCalled();
  expect(dispatch).toHaveBeenCalledWith('build-main.yml', { source_sha: sha, force: 'false' });
});

const endToEndCall = (call: unknown[]) => (call[1] as string[])[0] === 'platform/scripts/ci/end-to-end-tests.mjs';

it('runs end-to-end tests against TEST after a local deploy completes', async () => {
  process.argv.push('--local');
  findCompleteRelease.mockResolvedValue({ manifest: { sourceSha: sha } });
  await import('../ci/ship-test.mjs');
  const calls = command.mock.calls;
  expect(calls.findIndex(endToEndCall)).toBeGreaterThan(calls.findIndex(deployCall));
  expect((calls.find(endToEndCall)![2] as { env: NodeJS.ProcessEnv }).env.CI_LIVE_RESTART).toBe('true');
});

it('skips end-to-end tests when the local deploy fails', async () => {
  process.argv.push('--local');
  findCompleteRelease.mockResolvedValue({ manifest: { sourceSha: sha } });
  command.mockImplementationOnce(() => { throw new Error('deploy failed'); });
  await expect(import('../ci/ship-test.mjs')).rejects.toThrow('deploy failed');
  expect(command.mock.calls.map(call => (call[1] as string[])[0])).toEqual(['platform/scripts/ci/deploy.mjs']);
});
