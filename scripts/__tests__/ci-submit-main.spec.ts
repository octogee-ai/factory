import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const { command, dispatch } = vi.hoisted(() => ({ command: vi.fn(), dispatch: vi.fn() }));
vi.mock('node:child_process', () => ({ execFileSync: command }));
vi.mock('../ci/actions-dispatch.mjs', () => ({ dispatchWorkflow: dispatch }));
const argv = process.argv;
const sha = 'a'.repeat(40);
beforeEach(() => {
  vi.resetModules(); vi.clearAllMocks();
  process.argv = [...argv.slice(0, 2), 'main', `--sha=${sha}`];
  command.mockReturnValue(sha);
});
afterEach(() => { process.argv = argv; });
it.each([false, true])('dispatches the selected main SHA and force choice (%s)', async force => {
  if (force) process.argv.push('--force');
  await import('../ci/submit.mjs');
  expect(command).toHaveBeenCalledWith('/usr/bin/git', ['merge-base', '--is-ancestor', sha, 'origin/main'], expect.anything());
  expect(dispatch).toHaveBeenCalledWith('build-main.yml', { source_sha: sha, force: String(force) });
});
it('rejects a SHA outside main before dispatch', async () => {
  command.mockImplementation(() => { throw new Error('not main'); });
  await expect(import('../ci/submit.mjs')).rejects.toThrow('not main');
  expect(dispatch).not.toHaveBeenCalled();
});
it('propagates a failed hosted build', async () => {
  dispatch.mockRejectedValueOnce(new Error('build failed'));
  await expect(import('../ci/submit.mjs')).rejects.toThrow('build failed');
});
it('rejects unsupported arguments before invoking Git or Actions', async () => {
  process.argv.push('--desktop-image');
  await expect(import('../ci/submit.mjs')).rejects.toThrow('usage:');
  expect(command).not.toHaveBeenCalled(); expect(dispatch).not.toHaveBeenCalled();
});
