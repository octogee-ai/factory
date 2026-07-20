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
  db: {
    collection: (c: string) => colRef(c),
    doc: (path: string) => docRef(path),
  },
}));
vi.mock('../middleware/logging', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

import {
  requireAuth,
  requireAuthAllowUnregistered,
  requireAuthenticatedUid,
} from '../middleware/auth.js';

function runAuth(
  middleware: typeof requireAuth = requireAuth,
): Promise<{ req: Request; nextCalled: boolean; status?: number }> {
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
    middleware(req, res, () => resolve({ req, nextCalled: true, status }));
  });
}

describe('requireAuth — admin role only; no per-user gitea secret read (retired for Sudo broker)', () => {
  beforeEach(() => {
    mockDocs.clear();
    reads.length = 0;
    verifyIdToken.mockReset().mockResolvedValue({ uid: 'u1' });
    mockDocs.set('users/u1', { username: 'alice' });
    mockDocs.set('workspaces/alice', { ownerUid: 'u1' });
  });

  it('attaches isAdmin from system/config and does NOT touch secrets/gitea', async () => {
    mockDocs.set('users/u1/system/config', { role: 'admin' });
    // A token in the old location must NOT be read — gitea access is now admin-Sudo.
    mockDocs.set('users/u1/secrets/gitea', { username: 'alice', token: 'tok-from-secrets' });

    const { req, nextCalled } = await runAuth();

    expect(nextCalled).toBe(true);
    expect(req.isAdmin).toBe(true);
    expect(req.workspaceSlug).toBe('alice');
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

describe('requireAuthenticatedUid', () => {
  beforeEach(() => {
    mockDocs.clear();
    reads.length = 0;
    verifyIdToken.mockReset().mockResolvedValue({ uid: 'u1' });
    mockDocs.set('users/u1', { username: 'alice' });
  });

  it('checks revocation and requires an active Firestore user', async () => {
    reads.length = 0;
    const req = { headers: { authorization: 'Bearer fake' } } as unknown as Request;
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn() } as unknown as Response;
    let called = false;

    requireAuthenticatedUid(req, res, () => {
      called = true;
    });
    await vi.waitFor(() => expect(called).toBe(true));

    expect(req.uid).toBe('u1');
    expect(verifyIdToken).toHaveBeenCalledWith('fake', true);
    expect(reads).toEqual(['users/u1']);
    expect(req.user).toMatchObject({ username: 'alice' });
  });

  it.each(['suspended', 'deletion_scheduled', 'erasing'])(
    'rejects an account whose lifecycle is %s',
    async (status) => {
      mockDocs.set('users/u1', { accountLifecycle: { status } });
      const result = await runAuth();
      expect(result.nextCalled).toBe(false);
      expect(result.status).toBe(403);
    },
  );

  it('rejects a token whose user document no longer exists', async () => {
    mockDocs.delete('users/u1');
    const result = await runAuth();
    expect(result.nextCalled).toBe(false);
    expect(result.status).toBe(403);
  });
});

describe('requireAuthAllowUnregistered', () => {
  beforeEach(() => {
    mockDocs.clear();
    reads.length = 0;
    verifyIdToken.mockReset().mockResolvedValue({ uid: 'u1' });
  });

  it('accepts a non-revoked Firebase user before their Firestore user is created', async () => {
    const result = await runAuth(requireAuthAllowUnregistered);

    expect(result.nextCalled).toBe(true);
    expect(result.req.uid).toBe('u1');
    expect(result.req.user).toBeUndefined();
    expect(result.req.workspaceSlug).toBeNull();
    expect(verifyIdToken).toHaveBeenCalledWith('fake', true);
  });

  it.each(['suspended', 'deletion_scheduled', 'erasing'])(
    'still rejects an existing account whose lifecycle is %s',
    async (status) => {
      mockDocs.set('users/u1', { accountLifecycle: { status } });

      const result = await runAuth(requireAuthAllowUnregistered);

      expect(result.nextCalled).toBe(false);
      expect(result.status).toBe(403);
    },
  );
});
