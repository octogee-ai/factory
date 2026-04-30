/**
 * proxy-server.spec.ts
 *
 * Server-level (HTTP integration) tests for the chat-proxy.
 *
 * Post-Option-C architecture: chat-proxy no longer proxies Mattermost. Browser
 * talks to mattermost[-test].octogee.com directly. ChatProxy retains:
 *   1. POST /api/auth/mattermost — Firebase ID token → { mmUrl, mmToken, mmUserId }
 *   2. /api/openclaw/ws/<ticket> — OpenClaw gateway bridge (covered elsewhere)
 *   3. /healthz, /health, /_health, /metrics — observability
 *
 * Scenarios covered:
 *  - Health endpoints → 200 (no auth required)
 *  - Metrics endpoint → 200 (no auth required)
 *  - POST /api/auth/mattermost — 200 returns { mmUrl, mmToken, mmUserId }
 *  - POST /api/auth/mattermost — 401 unauthenticated / invalid Firebase token
 *  - POST /api/auth/mattermost — 502 when user is not provisioned in MM
 *  - POST /api/auth/mattermost — does not log the PAT
 *  - CORS preflight on the mint endpoint
 *  - MM REST paths return 404 (no longer proxied)
 *  - MM WebSocket upgrade returns 404 (no longer proxied)
 */

import { describe, expect, it, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

// ── Env setup (must happen before any imports from proxy) ─────────────────────
process.env.NODE_ENV = 'test';
process.env.MM_PUBLIC_URL = 'https://mm.test.octogee.com';

// ── Firebase admin mock ───────────────────────────────────────────────────────

const verifyIdToken = vi.fn(async (token: string) => {
  if (token === 'regular-token') return { uid: 'regular-uid' };
  if (token === 'noproxy-token') return { uid: 'noproxy-uid' };
  throw Object.assign(new Error('auth/id-token-expired'), { code: 'auth/id-token-expired' });
});

/**
 * Firestore doc mock: returns different data shapes depending on the doc path.
 *
 * Paths wired up:
 *   users/regular-uid              → { mattermost: { userId: 'mm-user-1' } }
 *   users/regular-uid/secrets/mattermost → { personalToken: 'regular-mm-token' }
 *
 *   users/noproxy-uid              → {}  (no mattermost field)
 *   users/noproxy-uid/secrets/mattermost → {}  (no personalToken)
 */
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

// ── Import proxy and start server ─────────────────────────────────────────────

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

// ── Helper ────────────────────────────────────────────────────────────────────

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

// ── Tests ─────────────────────────────────────────────────────────────────────

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
    // Simulate a transient Firestore failure mid-lookup. Mapping this to
    // 502 "Chat not provisioned" used to be misleading — operators would
    // see the same error code as a not-yet-onboarded user.
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

  it('with valid token and provisioning → 200 with mmUrl, mmToken, mmUserId', async () => {
    const res = await request('/api/auth/mattermost', {
      method: 'POST',
      headers: { Authorization: 'Bearer regular-token' },
    });
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    expect(body).toEqual({
      mmUrl: 'https://mm.test.octogee.com',
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
    // The mint endpoint is POST-only. Anything else falls through to the
    // default 404 handler — there's no MM proxy fallback any more.
    const res = await request('/api/auth/mattermost', {
      method: 'GET',
      headers: { Authorization: 'Bearer regular-token' },
    });
    expect(res.status).toBe(404);
  });
});

describe('Mattermost proxying is removed', () => {
  // After Option C, chat-proxy is no longer in the MM REST or WS path. The
  // browser talks to mattermost[-test].octogee.com directly. Any request to
  // legacy MM paths on chat-proxy should fall through to the default 404.
  it('GET /api/v4/users/me/teams → 404 (no longer proxied)', async () => {
    const res = await request('/api/v4/users/me/teams', {
      headers: { Authorization: 'Bearer regular-token' },
    });
    expect(res.status).toBe(404);
  });

  it('POST /api/v4/posts → 404 (no longer proxied)', async () => {
    const res = await request('/api/v4/posts', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer regular-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ channel_id: 'abc', message: 'hi' }),
    });
    expect(res.status).toBe(404);
  });

  it('keep-alive survives a POST-with-body to a 404 path (server drains body)', async () => {
    // Regression for the body-drain on the default 404 path: a legacy client
    // could POST a JSON body to /api/v4/posts. If chat-proxy responds 404
    // without consuming the body, the next request on the same connection
    // sees stray bytes and the keep-alive is broken.
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
    expect(result.first).toBe(404);
    expect(result.second).toBe(200);
  });

  it('WebSocket upgrade to /api/v4/websocket/<ticket> → 404', async () => {
    // WS upgrade requests with no matching handler should be rejected at the
    // upgrade phase. We test this by sending a manual upgrade request.
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
