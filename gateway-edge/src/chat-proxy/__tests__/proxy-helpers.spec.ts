import { describe, expect, it, beforeEach, afterEach } from 'vitest';

process.env.MM_INTERNAL_URL = 'http://mattermost.octogee-test.svc.cluster.local:8065';

const { setCors, gatewayHealthUrl } = await import('../proxy');

describe('chat-proxy CORS', () => {
  it('sets CORS for allowed origins', () => {
    const headers = new Map<string, string>();
    const req = { headers: { origin: 'https://octogee.web.app' } } as never;
    const res = {
      setHeader: (key: string, value: string) => headers.set(key, value),
    } as never;

    setCors(req, res);

    expect(headers.get('Access-Control-Allow-Origin')).toBe('https://octogee.web.app');
    expect(headers.get('Access-Control-Allow-Credentials')).toBe('true');
  });

  it.each([
    'https://evil.example.com',
    'https://app-octogee-build-week.web.app',
  ])('does not set allow-origin for disallowed origin %s', (origin) => {
    const headers = new Map<string, string>();
    const req = { headers: { origin } } as never;
    const res = {
      setHeader: (key: string, value: string) => headers.set(key, value),
    } as never;

    setCors(req, res);

    expect(headers.get('Access-Control-Allow-Origin')).toBeUndefined();
    expect(headers.get('Access-Control-Allow-Methods')).toBeDefined();
  });
});

describe('gatewayHealthUrl — OC 2026.5.12 endpoint surface', () => {
  const saved = process.env.OPENCLAW_GATEWAY_URL;
  beforeEach(() => {
    delete process.env.OPENCLAW_GATEWAY_URL;
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.OPENCLAW_GATEWAY_URL;
    else process.env.OPENCLAW_GATEWAY_URL = saved;
  });

  it('targets /healthz, never the removed /__openclaw__/* surface', () => {
    const url = gatewayHealthUrl('http://127.0.0.1:18789');
    expect(url).toBe('http://127.0.0.1:18789/healthz');
    expect(url).not.toContain('__openclaw__');
  });

  it('defaults to the in-pod sidecar address when OPENCLAW_GATEWAY_URL is unset', () => {
    expect(gatewayHealthUrl()).toBe('http://127.0.0.1:18789/healthz');
  });

  it('honors OPENCLAW_GATEWAY_URL when set', () => {
    process.env.OPENCLAW_GATEWAY_URL = 'http://gw:18789';
    expect(gatewayHealthUrl()).toBe('http://gw:18789/healthz');
  });
});
