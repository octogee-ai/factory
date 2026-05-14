import { describe, expect, it, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

process.env.NODE_ENV = 'test';
process.env.MM_PUBLIC_URL = 'https://mm.test.octogee.com';
process.env.MM_INTERNAL_URL = 'http://mattermost.octogee-test.svc.cluster.local:8065';
process.env.CHAT_PROXY_PUBLIC_URL = 'https://chat-test.octogee.com';

const verifyIdToken = vi.fn(async (token: string) => {
  if (token === 'regular-token') return { uid: 'regular-uid' };
  if (token === 'noproxy-token') return { uid: 'noproxy-uid' };
  throw Object.assign(new Error('auth/id-token-expired'), { code: 'auth/id-token-expired' });
});

const firestoreDoc = vi.fn((path: string) => {
  const data: Record<string, unknown> = (() => {
    if (path === 'users/regular-uid') return { mattermost: { userId: 'mm-user-1' } };
    if (path === 'users/regular-uid/secrets/mattermost') return { personalToken: 'regular-mm-token' };
    if (path === 'users/noproxy-uid') return {};
    if (path === 'users/noproxy-uid/secrets/mattermost') return {};
    return {};
  })();
  return { get: async () => ({ exists: true, data: () => data }) };
});

vi.mock('firebase-admin', () => ({
  default: {
    initializeApp: vi.fn(),
    credential: { cert: vi.fn() },
    firestore: () => ({ doc: firestoreDoc }),
    auth: () => ({ verifyIdToken }),
  },
}));

const { createServer, _clearCaches } = await import('../proxy');

let server: http.Server;
let baseUrl: string;

beforeAll(async () => {
  server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve()))
  );
});

beforeEach(() => {
  vi.clearAllMocks();
  _clearCaches();
  verifyIdToken.mockImplementation(async (token: string) => {
    if (token === 'regular-token') return { uid: 'regular-uid' };
    if (token === 'noproxy-token') return { uid: 'noproxy-uid' };
    throw Object.assign(new Error('auth/id-token-expired'), { code: 'auth/id-token-expired' });
  });
  firestoreDoc.mockImplementation((path: string) => {
    const data: Record<string, unknown> = (() => {
      if (path === 'users/regular-uid') return { mattermost: { userId: 'mm-user-1' } };
      if (path === 'users/regular-uid/secrets/mattermost') return { personalToken: 'regular-mm-token' };
      if (path === 'users/noproxy-uid') return {};
      if (path === 'users/noproxy-uid/secrets/mattermost') return {};
      return {};
    })();
    return { get: async () => ({ exists: true, data: () => data }) };
  });
});

async function request(
  path: string,
  opts: {
    method?: string;
    headers?: Record<string, string>;
    body?: string | Buffer;
  } = {}
): Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const { method = 'GET', headers = {}, body } = opts;
    const bodyBuf = body != null ? (Buffer.isBuffer(body) ? body : Buffer.from(body)) : null;

    const req = http.request(
      `${baseUrl}${path}`,
      {
        method,
        headers: bodyBuf
          ? { 'Content-Length': String(bodyBuf.length), ...headers }
          : headers,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString(),
            headers: res.headers,
          })
        );
      }
    );
    req.on('error', reject);
    if (bodyBuf) req.write(bodyBuf);
    req.end();
  });
}

describe('health endpoints', () => {
  it('GET /healthz → 200 with status:ok (no auth)', async () => {
    const res = await request('/healthz');
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ status: 'ok' });
  });

  it('GET /health → 200', async () => {
    const res = await request('/health');
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ status: 'ok' });
  });

  it('GET /_health → 200', async () => {
    const res = await request('/_health');
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ status: 'ok' });
  });
});

describe('metrics endpoint', () => {
  it('GET /metrics → 200 with Prometheus content-type (no auth)', async () => {
    const res = await request('/metrics');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/plain/);
    expect(res.body).toMatch(/chat_proxy_/);
  });
});

describe('POST /api/auth/mattermost — credential mint', () => {
  it('with no Authorization header → 401', async () => {
    const res = await request('/api/auth/mattermost', { method: 'POST' });
    expect(res.status).toBe(401);
    expect(JSON.parse(res.body)).toMatchObject({ error: 'Unauthenticated' });
  });

  it('with invalid Firebase token → 401', async () => {
    const res = await request('/api/auth/mattermost', {
      method: 'POST',
      headers: { Authorization: 'Bearer expired-or-bad-token' },
    });
    expect(res.status).toBe(401);
  });

  it('with valid token but no MM provisioning → 502', async () => {
    const res = await request('/api/auth/mattermost', {
      method: 'POST',
      headers: { Authorization: 'Bearer noproxy-token' },
    });
    expect(res.status).toBe(502);
    expect(JSON.parse(res.body)).toMatchObject({ error: 'Chat not provisioned' });
  });

  it('with Firestore lookup throwing → 503 (outage, not "not provisioned")', async () => {
    firestoreDoc.mockImplementation((_path: string) => ({
      get: async () => {
        throw new Error('ETIMEDOUT');
      },
    }));
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const res = await request('/api/auth/mattermost', {
        method: 'POST',
        headers: { Authorization: 'Bearer regular-token' },
      });
      expect(res.status).toBe(503);
      expect(JSON.parse(res.body)).toMatchObject({
        error: 'Credential lookup unavailable',
      });
    } finally {
      errSpy.mockRestore();
    }
  });

  it('with valid token and provisioning → 200 with mmUrl (chat-proxy public URL), mmToken, mmUserId', async () => {
    const res = await request('/api/auth/mattermost', {
      method: 'POST',
      headers: { Authorization: 'Bearer regular-token' },
    });
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    expect(body).toEqual({
      mmUrl: 'https://chat-test.octogee.com',
      mmToken: 'regular-mm-token',
      mmUserId: 'mm-user-1',
    });
  });

  it('does not log the PAT', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await request('/api/auth/mattermost', {
        method: 'POST',
        headers: { Authorization: 'Bearer regular-token' },
      });
      const allLogs = [
        ...logSpy.mock.calls.flat().map(String),
        ...errSpy.mock.calls.flat().map(String),
      ].join('\n');
      expect(allLogs).not.toContain('regular-mm-token');
    } finally {
      logSpy.mockRestore();
      errSpy.mockRestore();
    }
  });

  it('OPTIONS preflight → 204 with CORS headers', async () => {
    const res = await request('/api/auth/mattermost', {
      method: 'OPTIONS',
      headers: { Origin: 'https://octogee.web.app' },
    });
    expect(res.status).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBe('https://octogee.web.app');
  });

  it('GET /api/auth/mattermost (wrong method) → 404', async () => {
    const res = await request('/api/auth/mattermost', {
      method: 'GET',
      headers: { Authorization: 'Bearer regular-token' },
    });
    expect(res.status).toBe(404);
  });
});

describe('Mattermost proxying via chat-proxy', () => {
  it('GET /api/v4/users/me/teams → forwarded to MM_INTERNAL_URL (502 when MM unreachable in test)', { timeout: 15_000 }, async () => {
    const res = await request('/api/v4/users/me/teams', {
      headers: { Authorization: 'Bearer regular-token' },
    });
    expect(res.status).not.toBe(404);
    expect([502, 500, 504]).toContain(res.status);
  });

  it('POST /api/v4/posts → forwarded to MM_INTERNAL_URL (502 when MM unreachable in test)', { timeout: 15_000 }, async () => {
    const res = await request('/api/v4/posts', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer regular-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ channel_id: 'abc', message: 'hi' }),
    });
    expect(res.status).not.toBe(404);
    expect([502, 500, 504]).toContain(res.status);
  });

  it('keep-alive survives a POST-with-body to /api/v4/posts (proxy consumes body)', { timeout: 15_000 }, async () => {
    const result: { first: number; second: number } = await new Promise(
      (resolve, reject) => {
        const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
        const body = JSON.stringify({ channel_id: 'abc', message: 'hi' });
        const opts = {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': String(Buffer.byteLength(body)),
          },
          agent,
        } as http.RequestOptions;
        const first = http.request(`${baseUrl}/api/v4/posts`, opts, (res1) => {
          res1.resume();
          res1.on('end', () => {
            const second = http.request(`${baseUrl}/healthz`, { agent }, (res2) => {
              res2.resume();
              res2.on('end', () => {
                agent.destroy();
                resolve({ first: res1.statusCode ?? 0, second: res2.statusCode ?? 0 });
              });
            });
            second.on('error', reject);
            second.end();
          });
        });
        first.on('error', reject);
        first.write(body);
        first.end();
      },
    );
    expect([502, 500, 504]).toContain(result.first);
    expect(result.second).toBe(200);
  });

  it('WebSocket upgrade to /api/v4/websocket/<ticket> → 404', async () => {
    const res: { status: number; statusText: string } = await new Promise(
      (resolve, reject) => {
        const req = http.request(
          `${baseUrl}/api/v4/websocket/00000000-0000-0000-0000-000000000000`,
          {
            method: 'GET',
            headers: {
              Connection: 'Upgrade',
              Upgrade: 'websocket',
              'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==',
              'Sec-WebSocket-Version': '13',
            },
          },
        );
        req.on('upgrade', (_res, socket) => {
          socket.destroy();
          reject(new Error('unexpected upgrade success'));
        });
        req.on('response', (response) => {
          response.resume();
          resolve({
            status: response.statusCode ?? 0,
            statusText: response.statusMessage ?? '',
          });
        });
        req.on('error', reject);
        req.end();
      },
    );
    expect(res.status).toBe(404);
  });
});

describe('CORS preflight', () => {
  it('OPTIONS to unknown path → 204 (preflight handled before route)', async () => {
    const res = await request('/anything', {
      method: 'OPTIONS',
      headers: { Origin: 'https://octogee.web.app' },
    });
    expect(res.status).toBe(204);
  });
});
