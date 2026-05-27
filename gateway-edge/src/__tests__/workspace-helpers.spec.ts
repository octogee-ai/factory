import { describe, it, expect, vi } from 'vitest';

import { requireGiteaToken } from '../routes/workspace/helpers.js';

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
