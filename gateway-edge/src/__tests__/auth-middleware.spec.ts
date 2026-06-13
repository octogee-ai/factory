import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';

const { mockDocs, reads, verifyIdToken } = vi.hoisted(() => ({
  mockDocs: new Map<string, Record<string, unknown> | undefined>(),
  reads: [] as string[],
  verifyIdToken: vi.fn(),
}));

function snap(path: string) {
  reads.push(path);
  const data = mockDocs.get(path);
  return { exists: data !== undefined, data: () => data };
}
function docRef(path: string): any {
  return {
    get: async () => snap(path),
    collection: (sub: string) => colRef(`${path}/${sub}`),
  };
}
function colRef(path: string): any {
  return { doc: (id: string) => docRef(`${path}/${id}`) };
}

vi.mock('../lib/db', () => ({
  auth: { verifyIdToken },
  db: { collection: (c: string) => colRef(c) },
}));
vi.mock('../middleware/logging', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

import { requireAuth } from '../middleware/auth.js';

function runAuth(): Promise<{ req: Request; nextCalled: boolean; status?: number }> {
  return new Promise((resolve) => {
    const req = { headers: { authorization: 'Bearer fake' } } as unknown as Request;
    let status: number | undefined;
    const res = {
      status: (c: number) => {
        status = c;
        return res;
      },
      json: () => resolve({ req, nextCalled: false, status }),
    } as unknown as Response;
    requireAuth(req, res, () => resolve({ req, nextCalled: true, status }));
  });
}

describe('requireAuth — admin role only; no per-user gitea secret read (retired for Sudo broker)', () => {
  beforeEach(() => {
    mockDocs.clear();
    reads.length = 0;
    verifyIdToken.mockReset().mockResolvedValue({ uid: 'u1' });
    mockDocs.set('users/u1', { username: 'alice' });
  });

  it('attaches isAdmin from system/config and does NOT touch secrets/gitea', async () => {
    mockDocs.set('users/u1/system/config', { role: 'admin' });
    // A token in the old location must NOT be read — gitea access is now admin-Sudo.
    mockDocs.set('users/u1/secrets/gitea', { username: 'alice', token: 'tok-from-secrets' });

    const { req, nextCalled } = await runAuth();

    expect(nextCalled).toBe(true);
    expect(req.isAdmin).toBe(true);
    expect((req as Record<string, unknown>).giteaToken).toBeUndefined();
    expect(reads).not.toContain('users/u1/secrets/gitea');
  });

  it('non-admin user resolves isAdmin=false', async () => {
    mockDocs.set('users/u1/system/config', { role: 'user' });
    const { req, nextCalled } = await runAuth();
    expect(nextCalled).toBe(true);
    expect(req.isAdmin).toBe(false);
  });
});
