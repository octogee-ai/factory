import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';

const { mockDocs, verifyIdToken } = vi.hoisted(() => ({
  mockDocs: new Map<string, Record<string, unknown> | undefined>(),
  verifyIdToken: vi.fn(),
}));

function snap(path: string) {
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

describe('requireAuth — Gitea token comes from the client-blocked secrets/ doc', () => {
  beforeEach(() => {
    mockDocs.clear();
    verifyIdToken.mockReset().mockResolvedValue({ uid: 'u1' });
    mockDocs.set('users/u1', { username: 'alice' });
  });

  it('attaches req.giteaToken from users/{uid}/secrets/gitea', async () => {
    mockDocs.set('users/u1/system/config', { role: 'admin' });
    mockDocs.set('users/u1/secrets/gitea', { username: 'alice', token: 'tok-from-secrets' });

    const { req, nextCalled } = await runAuth();

    expect(nextCalled).toBe(true);
    expect(req.giteaToken).toBe('tok-from-secrets');
    expect(req.isAdmin).toBe(true);
  });

  it('does NOT read the token from the client-readable system/config', async () => {
    // Stale token in the OLD location; secrets/gitea is absent.
    mockDocs.set('users/u1/system/config', { role: 'user', gitea: { token: 'leaky-old-token' } });

    const { req, nextCalled } = await runAuth();

    expect(nextCalled).toBe(true);
    expect(req.giteaToken).toBeUndefined();
  });
});
