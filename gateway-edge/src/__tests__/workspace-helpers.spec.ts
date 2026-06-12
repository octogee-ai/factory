import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../lib/github', () => ({
  githubContentsApi: vi.fn(async () => [{ name: 'README.md' }]),
}));
vi.mock('../lib/gitea', () => ({
  giteaApiAs: vi.fn(async () => [{ name: 'README.md' }]),
}));

import { requireGiteaToken, repoContentsApi } from '../routes/workspace/helpers.js';
import { githubContentsApi } from '../lib/github.js';
import { giteaApiAs } from '../lib/gitea.js';
import type { FileTarget } from '../lib/fileTarget.js';

function mockRes() {
  const res: {
    status: ReturnType<typeof vi.fn>;
    json: ReturnType<typeof vi.fn>;
    headersSent: boolean;
  } = {
    status: vi.fn(() => res),
    json: vi.fn(() => res),
    headersSent: false,
  };
  return res;
}

describe('requireGiteaToken', () => {
  it('returns the token when req.giteaToken is set', () => {
    const req = { giteaToken: 'tok-abc' } as any;
    const res = mockRes();
    expect(requireGiteaToken(req, res as any)).toBe('tok-abc');
    expect(res.status).not.toHaveBeenCalled();
    expect(res.json).not.toHaveBeenCalled();
  });

  it('returns null + sends 422 with structured error when req.giteaToken is absent', () => {
    const req = {} as any;
    const res = mockRes();
    expect(requireGiteaToken(req, res as any)).toBeNull();
    expect(res.status).toHaveBeenCalledWith(422);
    expect(res.json).toHaveBeenCalledWith({
      error: 'Workspace files unavailable',
      reason: 'gitea_not_provisioned',
    });
  });

  it('returns null + sends 422 when req.giteaToken is empty string', () => {
    const req = { giteaToken: '' } as any;
    const res = mockRes();
    expect(requireGiteaToken(req, res as any)).toBeNull();
    expect(res.status).toHaveBeenCalledWith(422);
  });

  it('does not double-respond when headers are already sent', () => {
    const req = {} as any;
    const res = { ...mockRes(), headersSent: true };
    expect(requireGiteaToken(req, res as any)).toBeNull();
    expect(res.status).not.toHaveBeenCalled();
    expect(res.json).not.toHaveBeenCalled();
  });
});

describe('repoContentsApi — token source per provider', () => {
  beforeEach(() => {
    vi.mocked(githubContentsApi).mockClear();
    vi.mocked(giteaApiAs).mockClear();
  });

  const githubTarget: FileTarget = {
    slug: 'alice',
    projectSlug: 'octo',
    provider: 'github',
    org: 'octogee-ai',
    repoName: 'octogee',
    gcsPrefix: 'customers/alice/projects/octo',
    githubToken: 'gho_owner_token',
  };

  it("github targets use the target's owner-brokered token, never an env token", async () => {
    const req = {} as any;
    await repoContentsApi(req, githubTarget, 'docs/INDEX.md');
    expect(githubContentsApi).toHaveBeenCalledWith(
      'octogee-ai',
      'octogee',
      'docs/INDEX.md',
      'gho_owner_token',
    );
    expect(giteaApiAs).not.toHaveBeenCalled();
  });

  it("gitea targets use the caller's gitea token from req", async () => {
    const req = { giteaToken: 'gitea-tok' } as any;
    const target: FileTarget = {
      slug: 'alice',
      projectSlug: null,
      provider: 'gitea',
      org: 'alice',
      repoName: 'workspace',
      gcsPrefix: 'customers/alice',
    };
    await repoContentsApi(req, target, 'notes.md');
    expect(giteaApiAs).toHaveBeenCalledWith(
      'gitea-tok',
      'alice',
      'workspace/contents/notes.md',
      'GET',
      undefined,
    );
    expect(githubContentsApi).not.toHaveBeenCalled();
  });
});
