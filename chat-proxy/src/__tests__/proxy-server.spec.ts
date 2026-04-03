/**
 * proxy-server.spec.ts
 *
 * Server-level (HTTP integration) tests for the chat-proxy.
 * Starts a real HTTP server on a random port, sends real HTTP requests,
 * and asserts on status codes and response bodies.
 *
 * Scenarios covered:
 *  - Health endpoints → 200 (no auth required)
 *  - Metrics endpoint → 200 (no auth required)
 *  - Unauthenticated request → 401
 *  - Invalid/expired Firebase token → 401
 *  - Authenticated request to disallowed endpoint → 403
 *  - Oversized proxied request body → 413
 *  - Provisioned user credential path → proxied to MM (200)
 *  - Unprovisioned user (no MM token in Firestore) → 502
 *  - Admin credential path → proxied with admin MM token (200)
 */

import { describe, expect, it, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

// ── Env setup (must happen before any imports from proxy) ─────────────────────
process.env.NODE_ENV = 'test';
process.env.MM_INTERNAL_URL = 'http://mattermost.internal';
process.env.MM_ADMIN_TOKEN = 'admin-mm-token';

// ── Firebase admin mock ───────────────────────────────────────────────────────

const verifyIdToken = vi.fn(async (token: string) => {
  if (token === 'regular-token') return { uid: 'regular-uid' };
  if (token === 'noproxy-token') return { uid: 'noproxy-uid' };
  if (token === 'admin-token') return { uid: 'admin-uid' };
  throw Object.assign(new Error('auth/id-token-expired'), { code: 'auth/id-token-expired' });
});

/**
 * Firestore doc mock: returns different data shapes depending on the doc path.
 *
 * Paths wired up:
 *   users/regular-uid/system/config → { role: 'user' }         (not admin)
 *   users/regular-uid              → { mattermost: { userId: 'mm-user-1' } }
 *   users/regular-uid/secrets/mattermost → { personalToken: 'regular-mm-token' }
 *
 *   users/noproxy-uid/system/config → { role: 'user' }
 *   users/noproxy-uid              → {}  (no mattermost field)
 *   users/noproxy-uid/secrets/mattermost → {}  (no personalToken)
 *
 *   users/admin-uid/system/config  → { role: 'admin' }
 *   system/mattermostAdmin         → { userId: 'mm-admin-user-1' }
 */
const firestoreDoc = vi.fn((path: string) => {
  const data: Record<string, unknown> = (() => {
    if (path === 'users/regular-uid/system/config') return { role: 'user' };
    if (path === 'users/regular-uid') return { mattermost: { userId: 'mm-user-1' } };
    if (path === 'users/regular-uid/secrets/mattermost') return { personalToken: 'regular-mm-token' };
    if (path === 'users/noproxy-uid/system/config') return { role: 'user' };
    if (path === 'users/noproxy-uid') return {};
    if (path === 'users/noproxy-uid/secrets/mattermost') return {};
    if (path === 'users/admin-uid/system/config') return { role: 'admin' };
    if (path === 'system/mattermostAdmin') return { userId: 'mm-admin-user-1' };
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

// ── Global fetch mock ─────────────────────────────────────────────────────────
// We mock global.fetch to intercept proxied requests to Mattermost.
// Tests that need MM responses can override `mockMmResponse`.

let mockMmResponse: { status: number; body: string; contentType?: string } = {
  status: 200,
  body: JSON.stringify([]),
  contentType: 'application/json',
};

const fetchMock = vi.fn(async (_url: unknown, _opts: unknown) => {
  const { status, body, contentType = 'application/json' } = mockMmResponse;
  return {
    status,
    headers: {
      get: (name: string) => {
        if (name === 'content-type') return contentType;
        if (name === 'content-disposition') return null;
        if (name === 'location') return null;
        return null;
      },
    },
    body: {
      getReader: () => {
        let sent = false;
        return {
          read: async () => {
            if (!sent) {
              sent = true;
              return { done: false, value: Buffer.from(body) };
            }
            return { done: true, value: undefined };
          },
        };
      },
    },
  };
});

// @ts-ignore — override global fetch
global.fetch = fetchMock;

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
  // Re-attach mocks cleared by clearAllMocks
  verifyIdToken.mockImplementation(async (token: string) => {
    if (token === 'regular-token') return { uid: 'regular-uid' };
    if (token === 'noproxy-token') return { uid: 'noproxy-uid' };
    if (token === 'admin-token') return { uid: 'admin-uid' };
    throw Object.assign(new Error('auth/id-token-expired'), { code: 'auth/id-token-expired' });
  });
  firestoreDoc.mockImplementation((path: string) => {
    const data: Record<string, unknown> = (() => {
      if (path === 'users/regular-uid/system/config') return { role: 'user' };
      if (path === 'users/regular-uid') return { mattermost: { userId: 'mm-user-1' } };
      if (path === 'users/regular-uid/secrets/mattermost') return { personalToken: 'regular-mm-token' };
      if (path === 'users/noproxy-uid/system/config') return { role: 'user' };
      if (path === 'users/noproxy-uid') return {};
      if (path === 'users/noproxy-uid/secrets/mattermost') return {};
      if (path === 'users/admin-uid/system/config') return { role: 'admin' };
      if (path === 'system/mattermostAdmin') return { userId: 'mm-admin-user-1' };
      return {};
    })();
    return { get: async () => ({ exists: true, data: () => data }) };
  });
  // @ts-ignore
  global.fetch = fetchMock;
  fetchMock.mockImplementation(async (_url: unknown, _opts: unknown) => {
    const { status, body, contentType = 'application/json' } = mockMmResponse;
    return {
      status,
      headers: {
        get: (name: string) => {
          if (name === 'content-type') return contentType;
          if (name === 'content-disposition') return null;
          if (name === 'location') return null;
          return null;
        },
      },
      body: {
        getReader: () => {
          let sent = false;
          return {
            read: async () => {
              if (!sent) {
                sent = true;
                return { done: false, value: Buffer.from(body) };
              }
              return { done: true, value: undefined };
            },
          };
        },
      },
    };
  });
  mockMmResponse = { status: 200, body: JSON.stringify([]), contentType: 'application/json' };
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

// /health is the canonical endpoint; /healthz and /_health remain compatibility aliases.
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
    // Prometheus exposition format: should include at least one metric name
    expect(res.body).toMatch(/chat_proxy_/);
  });
});

describe('authentication', () => {
  it('request with no Authorization header → 401', async () => {
    const res = await request('/api/v4/users/me/teams');
    expect(res.status).toBe(401);
    expect(JSON.parse(res.body)).toMatchObject({ error: 'Unauthenticated' });
  });

  it('request with invalid/expired Firebase token → 401', async () => {
    const res = await request('/api/v4/users/me/teams', {
      headers: { Authorization: 'Bearer expired-or-bad-token' },
    });
    expect(res.status).toBe(401);
    expect(JSON.parse(res.body)).toMatchObject({ error: 'Unauthenticated' });
  });

  it('BEARER (uppercase) with invalid token → 401', async () => {
    const res = await request('/api/v4/users/me/teams', {
      headers: { Authorization: 'BEARER not-a-real-token' },
    });
    expect(res.status).toBe(401);
    expect(JSON.parse(res.body)).toMatchObject({ error: 'Unauthenticated' });
  });
});

describe('route allowlist', () => {
  it('authenticated request to disallowed endpoint → 403', async () => {
    const res = await request('/api/v4/config', {
      headers: { Authorization: 'Bearer regular-token' },
    });
    expect(res.status).toBe(403);
    expect(JSON.parse(res.body)).toMatchObject({ error: 'Endpoint not allowed' });
  });

  it('authenticated DELETE to system endpoint → 403', async () => {
    const res = await request('/api/v4/system/ping', {
      method: 'DELETE',
      headers: { Authorization: 'Bearer regular-token' },
    });
    expect(res.status).toBe(403);
  });

  it('authenticated GET to /api/v4/users (list all users) → 403', async () => {
    const res = await request('/api/v4/users', {
      headers: { Authorization: 'Bearer regular-token' },
    });
    expect(res.status).toBe(403);
  });
});

describe('oversized request body', () => {
  it('payload exceeding MAX_BODY_BYTES via streaming → 413', async () => {
    // Override MAX_BODY_BYTES to 8 bytes for this test so we don't need huge buffers.
    const tinyBody = Buffer.alloc(9, 'x'); // 9 bytes > 8 — triggers streaming limit
    process.env.MAX_BODY_BYTES = '8';
    try {
      const res = await request('/api/v4/posts', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer regular-token',
          'Content-Type': 'application/json',
        },
        body: tinyBody,
      });
      expect(res.status).toBe(413);
      expect(JSON.parse(res.body)).toMatchObject({ error: 'Payload too large' });
    } finally {
      delete process.env.MAX_BODY_BYTES;
    }
  });

  it('Content-Length fast-path: Content-Length header exceeds limit → 413 (checked before reading body)', async () => {
    // The proxy checks the Content-Length header before buffering any data.
    // Use a limit of 50 bytes and a body of 51 bytes so Content-Length == actual size
    // (avoids HTTP keep-alive corruption from mismatched Content-Length).
    process.env.MAX_BODY_BYTES = '50';
    try {
      const oversizedBody = Buffer.alloc(51, 'x'); // 51 > 50 → triggers fast-path via Content-Length
      const res = await request('/api/v4/posts', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer regular-token',
          'Content-Type': 'application/json',
        },
        body: oversizedBody,
      });
      expect(res.status).toBe(413);
      expect(JSON.parse(res.body)).toMatchObject({ error: 'Payload too large' });
    } finally {
      delete process.env.MAX_BODY_BYTES;
    }
  });

  it('normal-sized body is still proxied successfully after limit hardening', async () => {
    // Regression guard: make sure the fast-path and streaming guard don't break normal flow.
    mockMmResponse = { status: 200, body: JSON.stringify({ id: 'new-post' }) };
    const smallBody = JSON.stringify({ channel_id: 'abc', message: 'hello' });
    const res = await request('/api/v4/posts', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer regular-token',
        'Content-Type': 'application/json',
      },
      body: smallBody,
    });
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({ id: 'new-post' });
  });
});

describe('credential provisioning', () => {
  it('user with no MM credentials → 502 "Chat not provisioned"', async () => {
    const res = await request('/api/v4/users/me/teams', {
      headers: { Authorization: 'Bearer noproxy-token' },
    });
    expect(res.status).toBe(502);
    expect(JSON.parse(res.body)).toMatchObject({ error: 'Chat not provisioned' });
  });

  it('provisioned regular user → request proxied to MM, returns MM status', async () => {
    mockMmResponse = { status: 200, body: JSON.stringify([{ id: 'team1' }]) };
    const res = await request('/api/v4/users/me/teams', {
      headers: { Authorization: 'Bearer regular-token' },
    });
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual([{ id: 'team1' }]);
    // Confirm fetch was called with the user's personal MM token
    expect(fetchMock).toHaveBeenCalledOnce();
    const [calledUrl, calledOpts] = fetchMock.mock.calls[0] as [string, RequestInit & { headers: Record<string, string> }];
    expect(calledUrl).toBe('http://mattermost.internal/api/v4/users/me/teams');
    expect(calledOpts.headers['Authorization']).toBe('Bearer regular-mm-token');
  });

  it('admin user → request proxied with system admin MM token', async () => {
    mockMmResponse = { status: 200, body: JSON.stringify([{ id: 'team-admin' }]) };
    const res = await request('/api/v4/users/me/teams', {
      headers: { Authorization: 'Bearer admin-token' },
    });
    expect(res.status).toBe(200);
    // Confirm fetch was called with the admin MM token (from MM_ADMIN_TOKEN env)
    expect(fetchMock).toHaveBeenCalledOnce();
    const [_url, calledOpts] = fetchMock.mock.calls[0] as [string, RequestInit & { headers: Record<string, string> }];
    expect(calledOpts.headers['Authorization']).toBe('Bearer admin-mm-token');
  });

  it('MM returns non-200 → forwarded to client as-is', async () => {
    mockMmResponse = { status: 404, body: JSON.stringify({ message: 'Not found' }) };
    const res = await request('/api/v4/users/me/teams', {
      headers: { Authorization: 'Bearer regular-token' },
    });
    expect(res.status).toBe(404);
  });
});

describe('CORS preflight', () => {
  it('OPTIONS → 204 (no auth required)', async () => {
    const res = await request('/api/v4/posts', {
      method: 'OPTIONS',
      headers: { Origin: 'https://octogee.web.app' },
    });
    expect(res.status).toBe(204);
  });
});
