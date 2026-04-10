import { describe, expect, it, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';

process.env.NODE_ENV = 'test';
process.env.MM_INTERNAL_URL = 'http://mattermost.internal';

const verifyIdToken = vi.fn(async (token: string) => {
  if (token === 'good-token') return { uid: 'user-1' };
  throw new Error('bad token');
});

vi.mock('firebase-admin', () => ({
  default: {
    initializeApp: vi.fn(),
    credential: { cert: vi.fn() },
    firestore: () => ({
      doc: () => ({ get: async () => ({ data: () => ({ role: 'admin' }) }) }),
    }),
    auth: () => ({ verifyIdToken }),
  },
}));

const { isAllowedRoute, setCors, verifyAuth, readBody, DEFAULT_MAX_BODY_BYTES } = await import('../proxy');

describe('chat-proxy helper coverage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('allows documented route patterns', () => {
    expect(isAllowedRoute('GET', '/api/v4/users/me/teams')).toBe(true);
    expect(isAllowedRoute('POST', '/api/v4/posts')).toBe(true);
    expect(isAllowedRoute('GET', '/api/v4/channels/abc123/posts')).toBe(true);
  });

  it('rejects non-whitelisted routes', () => {
    expect(isAllowedRoute('GET', '/api/v4/config')).toBe(false);
    expect(isAllowedRoute('POST', '/api/v4/users')).toBe(false);
    expect(isAllowedRoute('DELETE', '/api/v4/system/ping')).toBe(false);
  });

  it('allows channel member management (list/add/remove)', () => {
    // Needed for the Settings → Membership UI (phase 2 of the settings refactor).
    // MM's native endpoint shape is /api/v4/channels/{id}/members{/{user_id}}.
    expect(isAllowedRoute('GET', '/api/v4/channels/ch12345/members')).toBe(true);
    expect(isAllowedRoute('POST', '/api/v4/channels/ch12345/members')).toBe(true);
    expect(isAllowedRoute('DELETE', '/api/v4/channels/ch12345/members/user9')).toBe(true);
  });

  it('rejects member endpoints with the wrong method or stray segments', () => {
    // Defense-in-depth — make sure the regex anchors catch typos.
    expect(isAllowedRoute('PUT', '/api/v4/channels/ch12345/members')).toBe(false);
    expect(isAllowedRoute('GET', '/api/v4/channels/ch12345/members/user9')).toBe(false);
    expect(isAllowedRoute('POST', '/api/v4/channels/ch12345/members/user9')).toBe(false);
    expect(isAllowedRoute('GET', '/api/v4/channels/ch12345/members/evil/../../users')).toBe(false);
  });

  it('sets CORS for allowed origins', () => {
    const headers = new Map<string, string>();
    const req = { headers: { origin: 'https://octogee.web.app' } } as any;
    const res = { setHeader: (key: string, value: string) => headers.set(key, value) } as any;

    setCors(req, res);

    expect(headers.get('Access-Control-Allow-Origin')).toBe('https://octogee.web.app');
    expect(headers.get('Access-Control-Allow-Credentials')).toBe('true');
  });

  it('does not set allow-origin for disallowed origins', () => {
    const headers = new Map<string, string>();
    const req = { headers: { origin: 'https://evil.example.com' } } as any;
    const res = { setHeader: (key: string, value: string) => headers.set(key, value) } as any;

    setCors(req, res);

    expect(headers.get('Access-Control-Allow-Origin')).toBeUndefined();
    expect(headers.get('Access-Control-Allow-Methods')).toBeDefined();
  });

  it('accepts Bearer and BEARER tokens, rejects missing auth', async () => {
    await expect(verifyAuth({ headers: { authorization: 'Bearer good-token' } } as any)).resolves.toBe('user-1');
    await expect(verifyAuth({ headers: { authorization: 'BEARER good-token' } } as any)).resolves.toBe('user-1');
    await expect(verifyAuth({ headers: {} } as any)).resolves.toBeNull();
  });

  it('rejects invalid auth tokens', async () => {
    await expect(verifyAuth({ headers: { authorization: 'Bearer no-good' } } as any)).resolves.toBeNull();
  });

  it('reads normal bodies under the limit', async () => {
    class FakeReq extends EventEmitter { destroy = vi.fn(); }
    const req = new FakeReq() as any;
    const promise = readBody(req, 32);
    req.emit('data', Buffer.from('hello '));
    req.emit('data', Buffer.from('world'));
    req.emit('end');
    await expect(promise).resolves.toEqual(Buffer.from('hello world'));
  });

  it('rejects oversized bodies', async () => {
    class FakeReq extends EventEmitter { resume = vi.fn(); }
    const req = new FakeReq() as any;
    const promise = readBody(req, 5);
    req.emit('data', Buffer.from('hello'));
    req.emit('data', Buffer.from('!'));
    await expect(promise).rejects.toThrow('Payload too large');
    // req.resume() is called to drain remaining data without destroying the socket
    expect(req.resume).toHaveBeenCalled();
  });

  it('exports a sane default max body size', () => {
    expect(DEFAULT_MAX_BODY_BYTES).toBe(10 * 1024 * 1024);
  });
});
