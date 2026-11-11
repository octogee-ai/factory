import { describe, expect, it, vi } from 'vitest';
import { revokeAndMintUserPat } from '../lib/mattermost.js';

function mkDeps() {
  const writeUserSecret = vi.fn(async () => undefined);
  const mmApiCall = vi.fn();
  const now = vi.fn(() => ({ __op: 'serverTimestamp' }));
  const log = vi.fn();
  return { writeUserSecret, mmApiCall, now, log };
}

function scriptMm(opts: {
  tokens?: unknown[];
  postResult?: unknown;
  listError?: Error;
  postError?: Error;
  revokeError?: Error;
}) {
  return vi.fn(async (method: string, endpoint: string, _body?: unknown) => {
    if (method === 'GET' && endpoint.endsWith('/tokens')) {
      if (opts.listError) throw opts.listError;
      return opts.tokens ?? [];
    }
    if (method === 'POST' && endpoint.endsWith('/tokens')) {
      if (opts.postError) throw opts.postError;
      return opts.postResult;
    }
    if (method === 'POST' && endpoint === '/users/tokens/revoke') {
      if (opts.revokeError) throw opts.revokeError;
      return {};
    }
    throw new Error(`unexpected mmApiCall: ${method} ${endpoint}`);
  });
}

describe('revokeAndMintUserPat', () => {
  it('revokes existing user PATs and mints a fresh one', async () => {
    const deps = mkDeps();
    deps.mmApiCall = scriptMm({
      tokens: [
        { id: 'tok-1', description: 'Octogee workspace chat' },
        { id: 'tok-2', description: 'Octogee workspace chat' },
        { id: 'tok-3', description: 'something else' },
      ],
      postResult: { token: 'pat-fresh-1234' },
    });

    const result = await revokeAndMintUserPat(deps, 'uid-bob', 'mm-bob');

    expect(result.outcome).toBe('rotated');
    expect(result.revokedTokenIds).toEqual(['tok-1', 'tok-2']);
    expect(result.newTokenLastFour).toBe('1234');

    const revokeCalls = deps.mmApiCall.mock.calls.filter(
      ([m, e]: [string, string]) => m === 'POST' && e === '/users/tokens/revoke',
    );
    expect(revokeCalls).toHaveLength(2);
    expect(revokeCalls[0][2]).toEqual({ token_id: 'tok-1' });
    expect(revokeCalls[1][2]).toEqual({ token_id: 'tok-2' });
  });

  it('persists the new token to users/{uid}/secrets/mattermost', async () => {
    const deps = mkDeps();
    deps.mmApiCall = scriptMm({ postResult: { token: 'pat-fresh-1234' } });

    await revokeAndMintUserPat(deps, 'uid-bob', 'mm-bob');

    expect(deps.writeUserSecret).toHaveBeenCalledTimes(1);
    expect(deps.writeUserSecret).toHaveBeenCalledWith('uid-bob', {
      personalToken: 'pat-fresh-1234',
      rotatedAt: { __op: 'serverTimestamp' },
    });
  });

  it('returns mm-user-missing when userMmUserId is empty', async () => {
    const deps = mkDeps();
    const result = await revokeAndMintUserPat(deps, 'uid-bob', '');
    expect(result.outcome).toBe('mm-user-missing');
    expect(deps.mmApiCall).not.toHaveBeenCalled();
    expect(deps.writeUserSecret).not.toHaveBeenCalled();
  });

  it('returns mint-failed and does not persist if mint throws', async () => {
    const deps = mkDeps();
    deps.mmApiCall = scriptMm({
      tokens: [],
      postError: new Error('MM rejected mint'),
    });
    const result = await revokeAndMintUserPat(deps, 'uid-bob', 'mm-bob');
    expect(result.outcome).toBe('mint-failed');
    expect(deps.writeUserSecret).not.toHaveBeenCalled();
  });

  it('returns mint-failed when MM responds without a token field', async () => {
    const deps = mkDeps();
    deps.mmApiCall = scriptMm({ tokens: [], postResult: { ok: true } });
    const result = await revokeAndMintUserPat(deps, 'uid-bob', 'mm-bob');
    expect(result.outcome).toBe('mint-failed');
    expect(deps.writeUserSecret).not.toHaveBeenCalled();
  });

  it('continues when listing existing tokens fails (best-effort revoke)', async () => {
    const deps = mkDeps();
    deps.mmApiCall = scriptMm({
      listError: new Error('list failed'),
      postResult: { token: 'pat-fresh-1234' },
    });
    const result = await revokeAndMintUserPat(deps, 'uid-bob', 'mm-bob');
    expect(result.outcome).toBe('rotated');
    expect(result.revokedTokenIds).toEqual([]);
  });

  it('continues when an individual revoke fails, still mints', async () => {
    const deps = mkDeps();
    deps.mmApiCall = scriptMm({
      tokens: [
        { id: 'tok-1', description: 'Octogee workspace chat' },
        { id: 'tok-2', description: 'Octogee workspace chat' },
      ],
      revokeError: new Error('revoke 500'),
      postResult: { token: 'pat-fresh-1234' },
    });
    const result = await revokeAndMintUserPat(deps, 'uid-bob', 'mm-bob');
    expect(result.outcome).toBe('rotated');
  });
});
