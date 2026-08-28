import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

process.env.NODE_ENV = 'test';
process.env.FIREBASE_PROJECT ??= 'octogee-test';
process.env.MM_INTERNAL_URL = 'http://mattermost.octogee-test.svc.cluster.local:8065';

const { chatProxyHandleRequest } = await import('../proxy');

let server: http.Server;
let baseUrl: string;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    void chatProxyHandleRequest(req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
});

async function request(
  path: string,
  method: string = 'GET',
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${baseUrl}${path}`, { method });
  return {
    status: response.status,
    body: await response.json() as Record<string, unknown>,
  };
}

describe('chat proxy HTTP ownership', () => {
  it.each(['/healthz', '/health', '/_health'])(
    'serves %s without authentication',
    async (path) => {
      expect(await request(path)).toEqual({ status: 200, body: { status: 'ok' } });
    },
  );

  it('reports the activity intake as unconfigured without the local producer secret', async () => {
    expect(await request('/internal/openclaw/activity/v1/events', 'POST')).toEqual({
      status: 503,
      body: { error: 'activity_intake_unconfigured', retryable: true },
    });
  });

  it('fails closed on the Mattermost callback before its runtime handler is installed', async () => {
    const response = await request('/internal/openclaw/mattermost/interactions/default', 'POST');
    expect(response.status).toBe(503);
    expect(response.body.error).toBe('service_unavailable');
  });

  it.each([
    '/metrics',
    '/api/auth/mattermost',
    '/api/v4/users/me',
    '/internal/openclaw/agent-control/callback',
  ])(
    'does not claim retired or separately composed path %s',
    async (path) => {
      expect((await request(path)).status).toBe(404);
    },
  );
});
