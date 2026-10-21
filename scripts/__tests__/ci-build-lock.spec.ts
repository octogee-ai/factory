import { expect, it, vi } from 'vitest';
import { withBuildLock, withBuildPin } from '../ci/build-lock.mjs';

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

it('publishes local operator intent before waiting for the automatic producer lock', async () => {
  const calls: string[] = [];
  let lockAttempts = 0;
  const request = vi.fn(async (url: string, options: any) => {
    calls.push(`${options.method} ${url}`);
    if (options.method === 'DELETE') return { status: 204 };
    if (url.includes('main-pins%2F')) return { status: 200, json: async () => ({ generation: '10' }) };
    if (++lockAttempts === 1) return { status: 412 };
    return { status: 200, json: async () => ({ generation: '20' }) };
  });
  const wait = vi.fn(async () => {
    expect(calls[0]).toContain('main-pins%2F');
    expect(calls.some(call => call.startsWith('DELETE'))).toBe(false);
  });
  await expect(withBuildPin('a'.repeat(40), request, () => withBuildLock('a'.repeat(40), request, async () => 'digest', { sleep: wait }))).resolves.toBe('digest');
  expect(wait).toHaveBeenCalledOnce();
  expect(calls.at(-1)).toContain('main-pins%2F');
  expect(calls.at(-1)).toContain('ifGenerationMatch=10');
});

it('retains local operator intent when a submitted child may still be writing', async () => {
  const request = vi.fn().mockResolvedValue({ status: 200, json: async () => ({ generation: '10' }) });
  await expect(withBuildPin('a'.repeat(40), request, async () => { throw new Error('lost child'); }, { canRelease: () => false })).rejects.toThrow('lost child');
  expect(request).toHaveBeenCalledOnce();
});

it.each([withBuildLock, withBuildPin])('keeps the work failure after a lost generation-delete response', async owner => {
  const request = vi.fn()
    .mockResolvedValueOnce({ status: 200, json: async () => ({ generation: '42' }) })
    .mockRejectedValueOnce(new TypeError('fetch failed: write EPIPE'))
    .mockResolvedValueOnce({ status: 404 });
  await expect(owner('a'.repeat(40), request, async () => { throw new Error('acceptance capacity exhausted'); }))
    .rejects.toThrow('acceptance capacity exhausted');
  expect(request.mock.calls.slice(1)).toEqual([
    [expect.stringContaining('ifGenerationMatch=42'), { method: 'DELETE' }],
    [expect.stringContaining('ifGenerationMatch=42'), { method: 'DELETE' }],
  ]);
});

it('never deletes a replacement lock when its generation no longer matches', async () => {
  const request = vi.fn()
    .mockResolvedValueOnce({ status: 200, json: async () => ({ generation: '42' }) })
    .mockResolvedValueOnce({ status: 412 });
  await expect(withBuildLock('a'.repeat(40), request, async () => 'digest')).rejects.toThrow('412');
  expect(request).toHaveBeenCalledTimes(2);
});
