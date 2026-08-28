import { readFileSync } from 'node:fs';
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
    requestBootstrap: ReturnType<typeof vi.fn>;
    invalidatedGateways: string[];
    clearedDeviceToken: number;
  } = {
    fetchAuth: vi.fn(),
    openUpstream: vi.fn(),
    requestBootstrap: vi.fn(),
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
  requestDevicePairBootstrapToken: h.ctl.requestBootstrap,
}));

const {
  establishUpstreamWithRotation,
  openBackgroundBridgeUpstream,
} = await import('../proxy.js');

function fakeUpstream(label: string) {
  return { label, terminate: vi.fn() };
}

describe('establishUpstreamWithRotation', () => {
  beforeEach(() => {
    h.ctl.fetchAuth.mockReset();
    h.ctl.openUpstream.mockReset();
    h.ctl.requestBootstrap.mockReset().mockResolvedValue('one-time-bootstrap-token');
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
    const enrollment = fakeUpstream('shared-token-enrollment');
    const recovered = fakeUpstream('recovered');
    h.ctl.fetchAuth
      .mockResolvedValueOnce({ source: 'legacy-token', token: 'stale-token' })
      .mockResolvedValueOnce({ source: 'legacy-token', token: 'fresh-token' });
    h.ctl.openUpstream
      .mockRejectedValueOnce(new h.OpenclawWireError('auth-failed'))
      .mockResolvedValueOnce(enrollment)
      .mockImplementationOnce(async (params: { onDeviceToken?: (auth: { deviceToken: string }) => Promise<void> }) => {
        await params.onDeviceToken?.({ deviceToken: 'issued-device-token' });
        return recovered;
      });

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

describe('openBackgroundBridgeUpstream', () => {
  beforeEach(() => {
    h.ctl.fetchAuth.mockReset();
    h.ctl.openUpstream.mockReset();
    h.ctl.requestBootstrap.mockReset().mockResolvedValue('one-time-bootstrap-token');
    h.ctl.invalidatedGateways = [];
    h.ctl.clearedDeviceToken = 0;
  });

  it('rotates a stale device token once and reconnects without interactive traffic', async () => {
    const enrollment = fakeUpstream('shared-token-enrollment');
    const recovered = fakeUpstream('background-recovered');
    const setBootStatus = vi.fn();
    h.ctl.fetchAuth
      .mockResolvedValueOnce({ source: 'device-token-file', deviceToken: 'stale-device-token' })
      .mockResolvedValueOnce({ source: 'legacy-token', token: 'fresh-legacy-token' });
    h.ctl.openUpstream
      .mockRejectedValueOnce(new h.OpenclawWireError('auth-failed'))
      .mockResolvedValueOnce(enrollment)
      .mockImplementationOnce(async (params: { onDeviceToken?: (auth: { deviceToken: string }) => Promise<void> }) => {
        await params.onDeviceToken?.({ deviceToken: 'issued-device-token' });
        return recovered;
      });

    await expect(openBackgroundBridgeUpstream(
      'eggman-devdays',
      'ws://gateway',
      { set: setBootStatus },
    )).resolves.toBe(recovered);

    expect(h.ctl.clearedDeviceToken).toBe(1);
    expect(h.ctl.fetchAuth).toHaveBeenCalledTimes(2);
    expect(h.ctl.openUpstream).toHaveBeenCalledTimes(3);
    expect(setBootStatus).not.toHaveBeenCalled();
  });

  it('maps a second authentication failure after the one rotation attempt', async () => {
    const setBootStatus = vi.fn();
    h.ctl.fetchAuth
      .mockResolvedValueOnce({ source: 'device-token-file', deviceToken: 'stale-device-token' })
      .mockResolvedValueOnce({ source: 'legacy-token', token: 'fresh-legacy-token' });
    h.ctl.openUpstream.mockRejectedValue(new h.OpenclawWireError('auth-failed'));

    await expect(openBackgroundBridgeUpstream(
      'eggman-devdays',
      'ws://gateway',
      { set: setBootStatus },
    )).rejects.toMatchObject({ code: 'auth-failed' });

    expect(h.ctl.fetchAuth).toHaveBeenCalledTimes(2);
    expect(h.ctl.openUpstream).toHaveBeenCalledTimes(2);
    expect(setBootStatus).toHaveBeenCalledOnce();
    expect(setBootStatus).toHaveBeenCalledWith('auth-failed');
  });

  it('maps non-authentication reconnect failures to unreachable without rotation', async () => {
    const setBootStatus = vi.fn();
    h.ctl.fetchAuth.mockResolvedValueOnce({
      source: 'device-token-file',
      deviceToken: 'current-device-token',
    });
    h.ctl.openUpstream.mockRejectedValueOnce(new h.OpenclawWireError('handshake-timeout'));

    await expect(openBackgroundBridgeUpstream(
      'eggman-devdays',
      'ws://gateway',
      { set: setBootStatus },
    )).rejects.toMatchObject({ code: 'handshake-timeout' });

    expect(h.ctl.fetchAuth).toHaveBeenCalledTimes(1);
    expect(h.ctl.openUpstream).toHaveBeenCalledTimes(1);
    expect(setBootStatus).toHaveBeenCalledWith('unreachable');
  });

  it('owns authentication for the sole background projection reconnect path', () => {
    const source = readFileSync(new URL('../proxy.ts', import.meta.url), 'utf8');
    const runLiveStart = source.indexOf('async function startRunLiveProjectionBackground');
    const publisherStart = source.indexOf('export async function startChatProxyBackground');
    const runLive = source.slice(runLiveStart, publisherStart);
    const boot = source.slice(publisherStart);

    expect(runLive).toContain('openBackgroundBridgeUpstream(');
    expect(runLive).not.toContain('fetchGatewayAuth(');
    expect(boot).toContain('startRunLiveProjectionBackground(gatewayIdResult, runtimeBroker)');
    expect(boot).not.toContain('openBackgroundBridgeUpstream(');
    expect(boot).not.toContain('fetchGatewayAuth(');
  });
});
