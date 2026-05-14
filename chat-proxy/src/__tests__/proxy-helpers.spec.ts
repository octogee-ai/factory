import { describe, expect, it, vi, beforeEach } from 'vitest';

process.env.NODE_ENV = 'test';
process.env.MM_PUBLIC_URL = 'https://mm.test.octogee.com';
process.env.MM_INTERNAL_URL = 'http://mattermost.octogee-test.svc.cluster.local:8065';
process.env.CHAT_PROXY_PUBLIC_URL = 'https://chat-test.octogee.com';

const verifyIdToken = vi.fn(async (token: string) => {
  if (token === 'good-token') return { uid: 'user-1' };
  throw new Error('bad token');
});

vi.mock('firebase-admin', () => ({
  default: {
    initializeApp: vi.fn(),
    credential: { cert: vi.fn() },
    firestore: () => ({
      doc: () => ({ get: async () => ({ exists: true, data: () => ({}) }) }),
    }),
    auth: () => ({ verifyIdToken }),
  },
}));

const { setCors, verifyAuth } = await import('../proxy');

describe('chat-proxy helper coverage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
});
