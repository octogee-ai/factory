import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { parse } from 'yaml';
import { githubRunCompleted, withBuildLock, withBuildPin } from '../ci/build-lock.mjs';

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

describe('deploy lock takeover from a finished run', () => {
  const holderRun = { repository: 'octogee-ai/octogee', id: '111', attempt: '1' };
  const fakeRequest = (holder: Record<string, unknown>) => {
    let creates = 0;
    return vi.fn(async (url: string, options: any = {}) => {
      const method = options.method ?? 'GET';
      if (method === 'POST') return ++creates === 1 ? { status: 412 } : { status: 200, json: async () => ({ generation: '8' }) };
      if (method === 'GET' && url.includes('alt=media')) return { status: 200, json: async () => holder };
      if (method === 'GET') return { status: 200, json: async () => ({ generation: '7' }) };
      return { status: 204 };
    });
  };
  const deletes = (request: ReturnType<typeof fakeRequest>) =>
    request.mock.calls.filter(([, options]) => options?.method === 'DELETE').map(([url]) => url);

  it('takes over a lock whose holder run has finished, deleting only that generation', async () => {
    const request = fakeRequest({ owner: 'old', run: holderRun });
    const runCompleted = vi.fn(async () => true);
    const sleep = vi.fn();
    await expect(withBuildLock('deploy-test', request, async () => 'deployed', { takeOverFinishedRuns: true, runCompleted, sleep })).resolves.toBe('deployed');
    expect(runCompleted).toHaveBeenCalledWith(holderRun);
    expect(sleep).not.toHaveBeenCalled();
    expect(deletes(request)).toEqual([expect.stringContaining('ifGenerationMatch=7'), expect.stringContaining('ifGenerationMatch=8')]);
  });

  it('waits on a lock whose holder run is still running', async () => {
    const request = fakeRequest({ owner: 'live', run: holderRun });
    const sleep = vi.fn();
    await withBuildLock('deploy-test', request, async () => 'deployed', { takeOverFinishedRuns: true, runCompleted: async () => false, sleep });
    expect(sleep).toHaveBeenCalledOnce();
    expect(deletes(request)).toEqual([expect.stringContaining('ifGenerationMatch=8')]);
  });

  it('waits on an operator lock that recorded no run', async () => {
    const request = fakeRequest({ owner: 'operator' });
    const runCompleted = vi.fn();
    const sleep = vi.fn();
    await withBuildLock('deploy-test', request, async () => 'deployed', { takeOverFinishedRuns: true, runCompleted, sleep });
    expect(runCompleted).not.toHaveBeenCalled();
    expect(sleep).toHaveBeenCalledOnce();
  });

  it('keeps waiting when GitHub cannot confirm the holder run finished', async () => {
    const request = fakeRequest({ owner: 'old', run: holderRun });
    const sleep = vi.fn();
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    await withBuildLock('deploy-test', request, async () => 'deployed', { takeOverFinishedRuns: true, runCompleted: async () => { throw new Error('403'); }, sleep });
    expect(sleep).toHaveBeenCalledOnce();
    expect(deletes(request)).toEqual([expect.stringContaining('ifGenerationMatch=8')]);
    expect(error).toHaveBeenCalledWith(expect.stringContaining('run 111'));
    error.mockRestore();
  });

  it.each([404, 412])('retries at once when the lock changes during the conditional read (%s)', async (status) => {
    let creates = 0;
    const request = vi.fn(async (url: string, options: any = {}) => {
      const method = options.method ?? 'GET';
      if (method === 'POST') return ++creates === 1 ? { status: 412 } : { status: 200, json: async () => ({ generation: '8' }) };
      if (method === 'GET' && url.includes('alt=media')) return { status };
      if (method === 'GET') return { status: 200, json: async () => ({ generation: '7' }) };
      return { status: 204 };
    });
    const sleep = vi.fn();
    const runCompleted = vi.fn();
    await expect(withBuildLock('deploy-test', request, async () => 'deployed', { takeOverFinishedRuns: true, runCompleted, sleep })).resolves.toBe('deployed');
    expect(sleep).not.toHaveBeenCalled();
    expect(runCompleted).not.toHaveBeenCalled();
  });

  it('records the GitHub run that holds the lock', async () => {
    const request = fakeRequest({});
    await withBuildLock('deploy-test', request, async () => 'deployed', { runOwner: holderRun, sleep: vi.fn(), runCompleted: async () => false });
    expect(JSON.parse(request.mock.calls[0][1].body)).toMatchObject({ run: holderRun });
  });

  it('is opted into by the deploy and desktop locks, not the main build lock', () => {
    for (const caller of ['../ci/release.mjs', '../ci/desktop-build.mjs']) {
      expect(readFileSync(new URL(caller, import.meta.url), 'utf8')).toContain('takeOverFinishedRuns: true');
    }
    expect(readFileSync(new URL('../ci/run-main.mjs', import.meta.url), 'utf8')).not.toContain('takeOverFinishedRuns');
  });
});

describe('githubRunCompleted', () => {
  const run = { repository: 'octogee-ai/octogee', id: '111', attempt: '2' };
  it.each([['completed', true], ['in_progress', false], ['queued', false]])('reads %s as finished=%s', async (status, finished) => {
    const fetchRun = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ status }) }));
    await expect(githubRunCompleted(run, { fetchRun, token: 't' })).resolves.toBe(finished);
    expect(fetchRun).toHaveBeenCalledWith('https://api.github.com/repos/octogee-ai/octogee/actions/runs/111/attempts/2', expect.anything());
  });

  it('refuses to guess without a token or on a failed lookup', async () => {
    await expect(githubRunCompleted(run, { fetchRun: vi.fn(), token: '' })).rejects.toThrow('GH_TOKEN');
    await expect(githubRunCompleted(run, { fetchRun: async () => ({ ok: false, status: 403 }), token: 't' })).rejects.toThrow('403');
  });
});

describe('lock-taking workflows can check the lock holder run', () => {
  it.each([
    ['deploy.yml', 'deploy', 'scripts/ci/deploy.mjs'],
    ['ship-test.yml', 'deploy', 'scripts/ci/deploy.mjs'],
    ['build-main.yml', 'desktop', 'scripts/ci/desktop.mjs'],
    ['desktop-image.yml', 'build', 'scripts/ci/desktop.mjs'],
  ])('%s gives its %s job read access to Actions and the run token', (file, jobName, script) => {
    const workflow = parse(readFileSync(new URL(`../../.github/workflows/${file}`, import.meta.url), 'utf8'));
    const job = workflow.jobs[jobName];
    expect(job.permissions ?? workflow.permissions).toMatchObject({ actions: 'read' });
    const step = job.steps.find((s: { run?: string }) => s.run?.includes(script));
    expect(step.env.GH_TOKEN).toBe('${{ github.token }}');
  });
});
