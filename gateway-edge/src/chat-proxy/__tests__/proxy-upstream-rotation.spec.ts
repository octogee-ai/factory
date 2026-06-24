import { beforeEach, describe, expect, it, vi } from 'vitest';

process.env.NODE_ENV = 'test';
process.env.MM_INTERNAL_URL = 'http://mattermost.octogee-test.svc.cluster.local:8065';

const h = vi.hoisted(() => {
  class OpenclawWireError extends Error {
    code: string;
    constructor(code: string) {
      super(code);
      this.code = code;
    }
  }

  class GatewayTokenError extends Error {
    code: string;
    constructor(code: string) {
      super(code);
      this.code = code;
    }
  }

  const ctl: {
    fetchAuth: ReturnType<typeof vi.fn>;
    openUpstream: ReturnType<typeof vi.fn>;
    invalidatedGateways: string[];
    clearedDeviceToken: number;
  } = {
    fetchAuth: vi.fn(),
    openUpstream: vi.fn(),
    invalidatedGateways: [],
    clearedDeviceToken: 0,
  };

  return { ctl, OpenclawWireError, GatewayTokenError };
});

vi.mock('../openclaw/gateway-token.js', () => ({
  GatewayTokenError: h.GatewayTokenError,
  fetchGatewayAuth: h.ctl.fetchAuth,
  invalidateGatewayToken: (gatewayId: string) => {
    h.ctl.invalidatedGateways.push(gatewayId);
  },
  clearGatewayDeviceToken: async () => {
    h.ctl.clearedDeviceToken += 1;
  },
  persistGatewayDeviceToken: async () => {},
}));

vi.mock('../openclaw/upstream.js', () => ({
  OpenclawWireError: h.OpenclawWireError,
  openUpstream: h.ctl.openUpstream,
}));

const { establishUpstreamWithRotation } = await import('../proxy.js');

function fakeUpstream(label: string) {
  return { label };
}

describe('establishUpstreamWithRotation', () => {
  beforeEach(() => {
    h.ctl.fetchAuth.mockReset();
    h.ctl.openUpstream.mockReset();
    h.ctl.invalidatedGateways = [];
    h.ctl.clearedDeviceToken = 0;
  });

  it('maps gateway-token source failures to 503 without opening upstream', async () => {
    h.ctl.fetchAuth.mockRejectedValueOnce(new h.GatewayTokenError('token-source-down'));

    const result = await establishUpstreamWithRotation('gw-1', 'ws://gateway');

    expect(result).toEqual({ ok: false, httpStatus: '503 Service Unavailable' });
    expect(h.ctl.openUpstream).not.toHaveBeenCalled();
  });

  it('maps non-auth upstream handshake failures to 502 without token rotation', async () => {
    h.ctl.fetchAuth.mockResolvedValueOnce({ source: 'legacy-token', token: 'cached-token' });
    h.ctl.openUpstream.mockRejectedValueOnce(new h.OpenclawWireError('handshake-timeout'));

    const result = await establishUpstreamWithRotation('gw-1', 'ws://gateway');

    expect(result).toEqual({ ok: false, httpStatus: '502 Bad Gateway' });
    expect(h.ctl.invalidatedGateways).toEqual([]);
    expect(h.ctl.fetchAuth).toHaveBeenCalledTimes(1);
  });

  it('invalidates legacy auth, refetches skip-cache, and returns the retry upstream after auth-failed', async () => {
    const recovered = fakeUpstream('recovered');
    h.ctl.fetchAuth
      .mockResolvedValueOnce({ source: 'legacy-token', token: 'stale-token' })
      .mockResolvedValueOnce({ source: 'legacy-token', token: 'fresh-token' });
    h.ctl.openUpstream
      .mockRejectedValueOnce(new h.OpenclawWireError('auth-failed'))
      .mockResolvedValueOnce(recovered);

    const result = await establishUpstreamWithRotation('gw-1', 'ws://gateway');

    expect(result).toEqual({ ok: true, upstream: recovered });
    expect(h.ctl.invalidatedGateways).toEqual(['gw-1']);
    expect(h.ctl.fetchAuth).toHaveBeenNthCalledWith(2, {
      gatewayId: 'gw-1',
      skipCache: true,
      allowLegacyFallback: true,
    });
  });

  it('clears device-token auth before retrying an auth-failed device-token handshake', async () => {
    const recovered = fakeUpstream('device-token-recovered');
    h.ctl.fetchAuth
      .mockResolvedValueOnce({ source: 'device-token', token: 'gateway-token', deviceToken: 'stale-device' })
      .mockResolvedValueOnce({ source: 'device-token', token: 'gateway-token', deviceToken: 'fresh-device' });
    h.ctl.openUpstream
      .mockRejectedValueOnce(new h.OpenclawWireError('auth-failed'))
      .mockResolvedValueOnce(recovered);

    const result = await establishUpstreamWithRotation('gw-1', 'ws://gateway');

    expect(result).toEqual({ ok: true, upstream: recovered });
    expect(h.ctl.invalidatedGateways).toEqual([]);
    expect(h.ctl.clearedDeviceToken).toBe(1);
  });

  it('maps auth refetch failures during rotation to 503', async () => {
    h.ctl.fetchAuth
      .mockResolvedValueOnce({ source: 'legacy-token', token: 'stale-token' })
      .mockRejectedValueOnce(new h.GatewayTokenError('token-source-down'));
    h.ctl.openUpstream.mockRejectedValueOnce(new h.OpenclawWireError('auth-failed'));

    const result = await establishUpstreamWithRotation('gw-1', 'ws://gateway');

    expect(result).toEqual({ ok: false, httpStatus: '503 Service Unavailable' });
    expect(h.ctl.invalidatedGateways).toEqual(['gw-1']);
  });
});
