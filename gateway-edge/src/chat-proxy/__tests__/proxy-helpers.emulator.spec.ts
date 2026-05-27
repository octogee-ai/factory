import { describe, expect, it, beforeAll, beforeEach, afterEach } from 'vitest';
import { getIdTokenForUid, requireEmulator, resetEmulator } from '../../../../shared/test-helpers/firestore-emulator.js';

process.env.NODE_ENV = 'test';
process.env.FIREBASE_PROJECT ??= 'octogee-test';
process.env.MM_PUBLIC_URL = 'https://mm.test.octogee.com';
process.env.MM_INTERNAL_URL = 'http://mattermost.octogee-test.svc.cluster.local:8065';

const { setCors, verifyAuth, gatewayHealthUrl } = await import('../proxy');

beforeAll(() => {
  requireEmulator();
});

beforeEach(async () => {
  await resetEmulator();
});

describe('chat-proxy helper coverage', () => {
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

  it('does not set allow-origin for disallowed origins', () => {
    const headers = new Map<string, string>();
    const req = { headers: { origin: 'https://evil.example.com' } } as never;
    const res = {
      setHeader: (key: string, value: string) => headers.set(key, value),
    } as never;

    setCors(req, res);

    expect(headers.get('Access-Control-Allow-Origin')).toBeUndefined();
    expect(headers.get('Access-Control-Allow-Methods')).toBeDefined();
  });

  it('accepts Bearer and BEARER tokens, rejects missing auth', async () => {
    const idToken = await getIdTokenForUid('user-1');
    await expect(
      verifyAuth({ headers: { authorization: `Bearer ${idToken}` } } as never),
    ).resolves.toBe('user-1');
    await expect(
      verifyAuth({ headers: { authorization: `BEARER ${idToken}` } } as never),
    ).resolves.toBe('user-1');
    await expect(verifyAuth({ headers: {} } as never)).resolves.toBeNull();
  });

  it('rejects invalid auth tokens', async () => {
    await expect(
      verifyAuth({ headers: { authorization: 'Bearer no-good' } } as never),
    ).resolves.toBeNull();
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
