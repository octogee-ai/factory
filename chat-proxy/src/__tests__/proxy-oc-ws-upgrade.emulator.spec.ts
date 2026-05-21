import { describe, expect, it, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import type { AddressInfo } from 'node:net';
import { WebSocket as WsClient } from 'ws';
import {
  getAdminDb,
  requireEmulator,
  resetEmulator,
} from '../../../shared/test-helpers/firestore-emulator';
import { TICKETS_COLLECTION } from './helpers/collections';

// What this spec pins
// ───────────────────
// `handleOpenClawWsUpgrade` is the single most security-critical function in
// chat-proxy: it is the only path that turns a browser ticket into a live,
// bidirectional pipe to a customer's OpenClaw gateway. Its job is a decision
// table — for every way the handshake can be illegitimate or the backend can
// be unavailable, it must refuse with a *specific, observable* HTTP status on
// the raw socket and open no upstream; for the one legitimate path it must
// proxy frames through the inbound gate (browser→gateway) and the per-user
// frame filter (gateway→browser), and tear both sides down together.
//
// These are intentionally behavioral, not structural: the helper modules
// (gateway-resolver, frame-filter, inbound-gate, …) own their own unit specs.
// Here we mock them to controllable seams and assert ONLY the orchestration
// contract, so this file stays green through a refactor that splits the
// 250-line handler apart — which is the whole point.

process.env.NODE_ENV = 'test';
process.env.FIREBASE_PROJECT ??= 'octogee-test';
process.env.MM_INTERNAL_URL = 'http://mattermost.octogee-test.svc.cluster.local:8065';
process.env.CHAT_PROXY_PUBLIC_URL = 'https://chat-test.octogee.com';

requireEmulator();

const TICKET = '11111111-2222-3333-4444-555555555555';

// ─── Controllable seams (hoisted so the vi.mock factories can close over them) ─
const h = vi.hoisted(() => {
  class OpenclawWireError extends Error {
    code: string;
    constructor(code: string) {
      super(code);
      this.code = code;
    }
  }
  class GatewayResolveError extends Error {
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
  class ExpectedAgentIdError extends Error {}

  // Mutable per-test control surface.
  const ctl: {
    originAllowed: boolean;
    resolve: () => { url: string; gatewayId: string; userData: Record<string, unknown> };
    deriveAgentId: () => string;
    fetchToken: (skipCache: boolean) => string;
    openUpstream: (token: string) => unknown;
    inboundAccept: boolean;
    forwardOutbound: boolean;
    invalidatedGateways: string[];
    gatewayIdChangeCb: ((next: string) => void) | null;
    lastUpstream: { close: ReturnType<typeof vi.fn> } | null;
  } = {
    originAllowed: true,
    resolve: () => ({ url: 'ws://gw.internal:18789', gatewayId: 'gw-1', userData: {} }),
    deriveAgentId: () => 'agent-1',
    fetchToken: () => 'tok-1',
    openUpstream: () => makeFakeUpstream(),
    inboundAccept: true,
    forwardOutbound: true,
    invalidatedGateways: [],
    gatewayIdChangeCb: null,
    lastUpstream: null,
  };

  // A fake upstream WS — EventEmitter with the surface proxy.ts touches.
  // readyState defaults to 1 (ws.OPEN) so inbound frames forward.
  function makeFakeUpstream() {
    const ee = new EventEmitter() as EventEmitter & {
      readyState: number;
      send: ReturnType<typeof vi.fn>;
      close: ReturnType<typeof vi.fn>;
    };
    ee.readyState = 1;
    ee.send = vi.fn();
    ee.close = vi.fn(() => ee.emit('close'));
    ctl.lastUpstream = ee; // closed over; only invoked after ctl is assigned
    return ee;
  }

  return {
    ctl,
    makeFakeUpstream,
    OpenclawWireError,
    GatewayResolveError,
    GatewayTokenError,
    ExpectedAgentIdError,
  };
});

vi.mock('../openclaw/ws-origin.js', () => ({
  isAllowedWsOrigin: () => h.ctl.originAllowed,
  warnIfWsOriginsMisconfigured: () => {},
  _resetWsOriginWarningForTests: () => {},
}));

vi.mock('../openclaw/gateway-resolver.js', () => ({
  GatewayResolveError: h.GatewayResolveError,
  resolveGatewayUrl: async () => h.ctl.resolve(),
}));

vi.mock('../openclaw/frame-filter.js', () => ({
  ExpectedAgentIdError: h.ExpectedAgentIdError,
  deriveExpectedAgentId: () => h.ctl.deriveAgentId(),
  shouldForwardFrame: () => ({
    forward: h.ctl.forwardOutbound,
    reason: h.ctl.forwardOutbound ? 'agent-match' : 'agent-mismatch',
  }),
  PER_USER_EVENTS: new Set<string>(),
}));

vi.mock('../openclaw/gateway-token.js', () => ({
  GatewayTokenError: h.GatewayTokenError,
  fetchGatewayToken: async ({ skipCache }: { skipCache?: boolean }) =>
    h.ctl.fetchToken(!!skipCache),
  invalidateGatewayToken: (gatewayId: string) => {
    h.ctl.invalidatedGateways.push(gatewayId);
  },
}));

vi.mock('../openclaw/upstream.js', () => ({
  OpenclawWireError: h.OpenclawWireError,
  openUpstream: async ({ token }: { token: string }) => h.ctl.openUpstream(token),
}));

vi.mock('../openclaw/gateway-id-watcher.js', () => ({
  watchGatewayIdChange: (
    _db: unknown,
    _uid: string,
    _gatewayId: string,
    cb: (next: string) => void,
  ) => {
    h.ctl.gatewayIdChangeCb = cb;
    return () => {
      h.ctl.gatewayIdChangeCb = null;
    };
  },
}));

vi.mock('../openclaw/inbound-gate.js', () => ({
  createGateState: () => ({}),
  evaluateInboundFrame: () => ({
    accept: h.ctl.inboundAccept,
    reason: h.ctl.inboundAccept ? 'allowed' : 'blocked',
  }),
  observeOutboundForState: () => {},
}));

const { createServer, createMetricsServer } = await import('../proxy');

let server: http.Server;
let port: number;
let metricsServer: http.Server;
let metricsPort: number;

beforeAll(async () => {
  server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
  // PR-2d: /metrics moved to a dedicated listener. Spin it up so the
  // existing `readMetrics()` helper can scrape counter values.
  metricsServer = createMetricsServer();
  await new Promise<void>((resolve) =>
    metricsServer.listen(0, '127.0.0.1', resolve),
  );
  metricsPort = (metricsServer.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await new Promise<void>((resolve) => metricsServer.close(() => resolve()));
});

async function seedTicket(opts: { expiresAt?: number; uid?: string | null } = {}): Promise<void> {
  const data: Record<string, unknown> = {
    expiresAt: opts.expiresAt ?? Date.now() + 60_000,
  };
  if (opts.uid !== undefined && opts.uid !== null) data.uid = opts.uid;
  await getAdminDb().collection(TICKETS_COLLECTION).doc(TICKET).set(data);
}

async function ticketExists(): Promise<boolean> {
  const snap = await getAdminDb().collection(TICKETS_COLLECTION).doc(TICKET).get();
  return snap.exists;
}

beforeEach(async () => {
  await resetEmulator();
  await seedTicket({ uid: 'uid-1' });
  h.ctl.originAllowed = true;
  h.ctl.resolve = () => ({
    url: 'ws://gw.internal:18789',
    gatewayId: 'gw-1',
    userData: {},
  });
  h.ctl.deriveAgentId = () => 'agent-1';
  h.ctl.fetchToken = () => 'tok-1';
  h.ctl.openUpstream = () => h.makeFakeUpstream();
  h.ctl.inboundAccept = true;
  h.ctl.forwardOutbound = true;
  h.ctl.invalidatedGateways = [];
  h.ctl.gatewayIdChangeCb = null;
  h.ctl.lastUpstream = null;
});

// Connect a real ws client and resolve with how the handshake ended:
// either the rejection HTTP status, or an open socket for the happy path.
function connect(opts: { ticketPath?: string; origin?: string } = {}): Promise<
  | { kind: 'rejected'; status: number }
  | { kind: 'open'; ws: WsClient }
> {
  const path = opts.ticketPath ?? `/api/openclaw/ws/${TICKET}`;
  return new Promise((resolve, reject) => {
    const ws = new WsClient(`ws://127.0.0.1:${port}${path}`, {
      headers: { origin: opts.origin ?? 'https://app.octogee.com' },
    });
    const timer = setTimeout(() => reject(new Error('handshake timed out')), 4_000);
    ws.on('unexpected-response', (_req, res) => {
      clearTimeout(timer);
      res.resume();
      ws.terminate();
      resolve({ kind: 'rejected', status: res.statusCode ?? 0 });
    });
    ws.on('open', () => {
      clearTimeout(timer);
      resolve({ kind: 'open', ws });
    });
    ws.on('error', () => {
      /* settled by unexpected-response / open */
    });
  });
}

// Prometheus text scrape. The metric label is itself an observable
// contract a future split of establishUpstreamWithRotation could silently
// drop, so the rotation tests assert it. The registry is module-global and
// cumulative across the shared server, so we assert *deltas*, never
// absolute values.
async function readMetrics(): Promise<string> {
  const res = await fetch(`http://127.0.0.1:${metricsPort}/metrics`);
  return res.text();
}
function metricValue(text: string, linePrefix: string): number {
  const line = text.split('\n').find((l) => l.startsWith(linePrefix));
  if (!line) return 0;
  const n = Number(line.slice(linePrefix.length).trim());
  return Number.isFinite(n) ? n : 0;
}

// Close the browser side and wait for the server to tear the upstream
// down, so a shared-server happy-path test never leaks an active
// connection or a live gatewayId watcher into the next test.
async function settle(
  r: { kind: 'open'; ws: WsClient } | { kind: 'rejected'; status: number },
): Promise<void> {
  if (r.kind !== 'open') return;
  r.ws.close();
  await vi.waitFor(() => expect(h.ctl.lastUpstream?.close).toHaveBeenCalled());
}

describe('OC WS upgrade — refusal decision table (security boundary)', () => {
  it('rejects a disallowed WebSocket origin with 403 and opens no upstream', async () => {
    h.ctl.originAllowed = false;
    const openSpy = vi.fn(h.makeFakeUpstream);
    h.ctl.openUpstream = openSpy;

    const r = await connect({ origin: 'https://evil.example' });
    expect(r).toEqual({ kind: 'rejected', status: 403 });
    expect(openSpy).not.toHaveBeenCalled();
  });

  it('rejects a malformed ticket path (not a 36-char uuid) with 401', async () => {
    const r = await connect({ ticketPath: '/api/openclaw/ws/not-a-real-ticket' });
    expect(r).toEqual({ kind: 'rejected', status: 401 });
  });

  it('rejects a ticket that does not exist with 401', async () => {
    await getAdminDb().collection(TICKETS_COLLECTION).doc(TICKET).delete();
    const r = await connect();
    expect(r).toEqual({ kind: 'rejected', status: 401 });
  });

  it('rejects an expired ticket with 401', async () => {
    await seedTicket({ expiresAt: Date.now() - 1, uid: 'uid-1' });
    const r = await connect();
    expect(r).toEqual({ kind: 'rejected', status: 401 });
  });

  it('rejects a ticket with no claimant uid with 401', async () => {
    await seedTicket({ uid: null });
    const r = await connect();
    expect(r).toEqual({ kind: 'rejected', status: 401 });
  });

  it('maps an unprovisioned gateway (GatewayResolveError) to 502', async () => {
    h.ctl.resolve = () => {
      throw new h.GatewayResolveError('not-provisioned');
    };
    const r = await connect();
    expect(r).toEqual({ kind: 'rejected', status: 502 });
  });

  it('maps an agent-id derivation failure to 502', async () => {
    h.ctl.deriveAgentId = () => {
      throw new h.ExpectedAgentIdError('no agent');
    };
    const r = await connect();
    expect(r).toEqual({ kind: 'rejected', status: 502 });
  });

  it('maps a gateway-token fetch failure to 503', async () => {
    h.ctl.fetchToken = () => {
      throw new h.GatewayTokenError('token-source-down');
    };
    const r = await connect();
    expect(r).toEqual({ kind: 'rejected', status: 503 });
  });

  it('maps a non-auth upstream handshake failure to 502 without rotating the token', async () => {
    h.ctl.openUpstream = () => {
      throw new h.OpenclawWireError('handshake-timeout');
    };
    const label = 'chat_proxy_openclaw_ws_handshakes_total{outcome="fail:handshake-timeout"}';
    const before = metricValue(await readMetrics(), label);

    const r = await connect();
    expect(r).toEqual({ kind: 'rejected', status: 502 });
    expect(h.ctl.invalidatedGateways).toEqual([]);
    // The labelled outcome is the operator-visible contract; pin it so a
    // future split can't silently relabel or drop the increment.
    expect(metricValue(await readMetrics(), label)).toBe(before + 1);
  });
});

describe('OC WS upgrade — auth-failed token rotation recovery', () => {
  it('on auth-failed, invalidates the cached token, re-fetches skip-cache, retries, and upgrades', async () => {
    const tokens: string[] = [];
    let attempt = 0;
    h.ctl.fetchToken = (skipCache) => {
      tokens.push(skipCache ? 'fresh' : 'cached');
      return skipCache ? 'fresh-tok' : 'stale-tok';
    };
    h.ctl.openUpstream = (token: string) => {
      attempt += 1;
      if (attempt === 1) throw new h.OpenclawWireError('auth-failed');
      expect(token).toBe('fresh-tok');
      return h.makeFakeUpstream();
    };

    const recoveredLabel = 'chat_proxy_openclaw_ws_rotation_recovered_total';
    const before = metricValue(await readMetrics(), recoveredLabel);

    const r = await connect();
    expect(r.kind).toBe('open');

    expect(h.ctl.invalidatedGateways).toEqual(['gw-1']);
    expect(tokens).toEqual(['cached', 'fresh']);
    // Recovery is only meaningful if it is *observable* as a recovery, not
    // as an ordinary success — the dedicated counter must tick exactly once.
    expect(metricValue(await readMetrics(), recoveredLabel)).toBe(before + 1);
    await settle(r);
  });

  it('on auth-failed where the rotation retry also fails, refuses with 502', async () => {
    h.ctl.openUpstream = () => {
      throw new h.OpenclawWireError('auth-failed');
    };
    const r = await connect();
    expect(r).toEqual({ kind: 'rejected', status: 502 });
    expect(h.ctl.invalidatedGateways).toEqual(['gw-1']);
  });

  it('on auth-failed where the token re-fetch itself fails, refuses with 503', async () => {
    let calls = 0;
    h.ctl.fetchToken = () => {
      calls += 1;
      if (calls === 1) return 'stale-tok';
      throw new h.GatewayTokenError('token-source-down');
    };
    h.ctl.openUpstream = () => {
      throw new h.OpenclawWireError('auth-failed');
    };
    const label =
      'chat_proxy_openclaw_ws_handshakes_total{outcome="fail:refetch:token-source-down"}';
    const before = metricValue(await readMetrics(), label);

    const r = await connect();
    expect(r).toEqual({ kind: 'rejected', status: 503 });
    expect(metricValue(await readMetrics(), label)).toBe(before + 1);
  });
});

describe('OC WS upgrade — happy path frame proxying & teardown', () => {
  it('consumes the ticket exactly once and upgrades the connection', async () => {
    const r = await connect();
    expect(r.kind).toBe('open');
    expect(await ticketExists()).toBe(false);
    await settle(r);
  });

  it('forwards an accepted browser frame to the upstream gateway', async () => {
    const up = h.makeFakeUpstream();
    h.ctl.openUpstream = () => up;
    h.ctl.inboundAccept = true;

    const r = await connect();
    expect(r.kind).toBe('open');
    if (r.kind !== 'open') return;
    r.ws.send('hello-gateway');
    await vi.waitFor(() => expect(up.send).toHaveBeenCalled());
    await settle(r);
  });

  it('drops a browser frame the inbound gate rejects (never reaches upstream)', async () => {
    const up = h.makeFakeUpstream();
    h.ctl.openUpstream = () => up;
    h.ctl.inboundAccept = false;

    const r = await connect();
    expect(r.kind).toBe('open');
    if (r.kind !== 'open') return;
    r.ws.send('blocked-frame');
    await new Promise((res) => setTimeout(res, 50));
    expect(up.send).not.toHaveBeenCalled();
    await settle(r);
  });

  it('delivers an upstream frame the per-user filter forwards to the browser', async () => {
    const up = h.makeFakeUpstream();
    h.ctl.openUpstream = () => up;
    h.ctl.forwardOutbound = true;

    const r = await connect();
    expect(r.kind).toBe('open');
    if (r.kind !== 'open') return;
    const got = new Promise<string>((res) => r.ws.once('message', (d) => res(d.toString())));
    up.emit('message', Buffer.from('agent-event'), false);
    expect(await got).toBe('agent-event');
    await settle(r);
  });

  it('withholds an upstream frame the per-user filter drops (cross-user isolation)', async () => {
    const up = h.makeFakeUpstream();
    h.ctl.openUpstream = () => up;
    h.ctl.forwardOutbound = false;

    const r = await connect();
    expect(r.kind).toBe('open');
    if (r.kind !== 'open') return;
    let leaked = false;
    r.ws.on('message', () => {
      leaked = true;
    });
    up.emit('message', Buffer.from('other-users-event'), false);
    await new Promise((res) => setTimeout(res, 50));
    expect(leaked).toBe(false);
    await settle(r);
  });

  it('closes the browser socket when the gateway id migrates mid-session', async () => {
    const r = await connect();
    expect(r.kind).toBe('open');
    if (r.kind !== 'open') return;
    const closed = new Promise<number>((res) => r.ws.once('close', (code) => res(code)));
    await vi.waitFor(() => expect(h.ctl.gatewayIdChangeCb).not.toBeNull());
    h.ctl.gatewayIdChangeCb!('gw-2');
    expect(await closed).toBe(1001); // 1001 = going away → browser re-resolves
    await settle(r);
  });

  it('tears down the upstream when the browser disconnects', async () => {
    const up = h.makeFakeUpstream();
    h.ctl.openUpstream = () => up;

    const r = await connect();
    expect(r.kind).toBe('open');
    if (r.kind !== 'open') return;
    r.ws.close();
    await vi.waitFor(() => expect(up.close).toHaveBeenCalled());
  });
});
