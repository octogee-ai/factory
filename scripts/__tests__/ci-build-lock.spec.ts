import { expect, it, vi } from 'vitest';
import { withBuildLock } from '../ci/build-lock.mjs';

it('releases only its own generation after work finishes', async () => {
  const request = vi.fn().mockResolvedValueOnce({ status: 200, json: async () => ({ generation: '42' }) }).mockResolvedValueOnce({ status: 204 });
  await expect(withBuildLock('a'.repeat(40), request, async () => 'digest')).resolves.toBe('digest');
  expect(request.mock.calls[1]).toEqual([expect.stringContaining('ifGenerationMatch=42'), { method: 'DELETE' }]);
});

it('retains the lock while a remote child might still be writing', async () => {
  const request = vi.fn().mockResolvedValue({ status: 200, json: async () => ({ generation: '42' }) });
  await expect(withBuildLock('a'.repeat(40), request, async () => { throw new Error('lost contact'); }, { canRelease: () => false })).rejects.toThrow('lost contact');
  expect(request).toHaveBeenCalledTimes(1);
});

it('never steals a lock from a long-running or disconnected owner', async () => {
  const request = vi.fn().mockResolvedValue({ status: 412 });
  const run = vi.fn();
  const now = vi.fn().mockReturnValueOnce(0).mockReturnValue(4 * 60 * 60_000);
  await expect(withBuildLock('a'.repeat(40), request, run, { now })).rejects.toThrow('Timed out');
  expect(run).not.toHaveBeenCalled();
  expect(request).toHaveBeenCalledTimes(1);
});
