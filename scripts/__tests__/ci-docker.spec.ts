import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const { exec, spawn, remove } = vi.hoisted(() => ({ exec: vi.fn(), spawn: vi.fn(), remove: vi.fn() }));
vi.mock('node:child_process', () => ({ execFileSync: exec, spawnSync: spawn }));
vi.mock('node:fs', () => ({ readFileSync: () => 'toolchain inputs' }));
vi.mock('../ci/snapshot.mjs', () => ({ snapshot: () => ({ source: '/snapshot', remove }) }));
vi.mock('../ci/toolchain-image.mjs', () => ({ imageTag: () => 'octogee-ci-local:amd64-inputs' }));
beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  vi.stubEnv('OCTOGEE_CI_IMAGE', '');
  exec.mockImplementation((file, args) => args[0] === 'rev-parse' ? '/repo' : '/docker');
  spawn.mockReturnValue({ status: 0 });
});
afterEach(() => { vi.unstubAllEnvs(); });

it('builds the local toolchain from source before checking the snapshot', async () => {
  await import('../ci/local.mjs');
  expect(exec).toHaveBeenCalledWith('/docker', [
    'build', '--platform=linux/amd64', '--file=ci/Dockerfile',
    '--tag=octogee-ci-local:amd64-inputs', '.',
  ], expect.objectContaining({ cwd: '/snapshot' }));
  expect(spawn.mock.calls[0][1]).toContain('octogee-ci-local:amd64-inputs');
  expect(remove).toHaveBeenCalledOnce();
});

it('keeps an explicitly selected toolchain image', async () => {
  vi.stubEnv('OCTOGEE_CI_IMAGE', 'operator/toolchain:chosen');
  await import('../ci/local.mjs');
  expect(exec.mock.calls.some(([, args]) => args[0] === 'build')).toBe(false);
  expect(spawn.mock.calls[0][1]).toContain('operator/toolchain:chosen');
});

it('stops before checks and removes the snapshot if toolchain construction fails', async () => {
  exec.mockImplementation((file, args) => {
    if (args[0] === 'build') throw new Error('build failed');
    return args[0] === 'rev-parse' ? '/repo' : '/docker';
  });
  await expect(import('../ci/local.mjs')).rejects.toThrow('build failed');
  expect(spawn).not.toHaveBeenCalled();
  expect(remove).toHaveBeenCalledOnce();
});
