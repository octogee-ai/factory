import http from "node:http";
import { AddressInfo } from "node:net";
import express from "express";
import { describe, it, expect, vi } from "vitest";
import {
  createRollRosterGate,
  createRollRosterStore,
  createRollRosterUpgradeGate,
  guardUpgradeRequest,
  isIntraFamilyRevision,
  mmRosterVerdictFor,
  resolveServiceRoute,
  revisionUnavailableUpgradeResponse,
  uidFromAuthHeader,
  wrapRedeemWithRosterGate,
  type RosterEntry,
} from "../roll-roster.js";
import {
  ASSIGNMENT_EPOCH_HEADER,
  INTRA_FAMILY_HOP_HEADER,
} from "@octogee/shared/types/gateway-releases";

function listen(server: http.Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve((server.address() as AddressInfo).port);
    });
  });
}

function entry(overrides: Partial<RosterEntry> = {}): RosterEntry {
  return {
    uid: "u1",
    revisionId: "default-r1",
    state: "serving",
    epoch: 1,
    ...overrides,
  };
}

// Fake bearer with an arbitrary (unverified) payload — the gate uses it ONLY to
// pick between same-family revisions; real auth still happens downstream.
function bearerFor(uid: string): string {
  const payload = Buffer.from(JSON.stringify({ user_id: uid })).toString("base64url");
  return `Bearer x.${payload}.y`;
}

describe("uidFromAuthHeader — routing-only, unverified decode", () => {
  it("extracts user_id / sub from a bearer JWT payload", () => {
    expect(uidFromAuthHeader(bearerFor("uid-a"))).toBe("uid-a");
    const sub = Buffer.from(JSON.stringify({ sub: "uid-b" })).toString("base64url");
    expect(uidFromAuthHeader(`Bearer h.${sub}.s`)).toBe("uid-b");
  });

  it("returns null for absent/garbage headers", () => {
    expect(uidFromAuthHeader(undefined)).toBeNull();
    expect(uidFromAuthHeader("Bearer not-a-jwt")).toBeNull();
    expect(uidFromAuthHeader("Basic abc")).toBeNull();
    expect(uidFromAuthHeader("Bearer a.!!!.c")).toBeNull();
  });
});

describe("isIntraFamilyRevision — the forward target can NEVER leave the gateway family", () => {
  it("accepts only this gateway's own revision ids", () => {
    expect(isIntraFamilyRevision("default", "default-r2")).toBe(true);
    expect(isIntraFamilyRevision("default", "default-r10")).toBe(true);
  });

  it("rejects other gateways, sneaky prefixes, and malformed revisions", () => {
    expect(isIntraFamilyRevision("default", "bender-r2")).toBe(false);
    expect(isIntraFamilyRevision("default", "default-evil-r2")).toBe(false);
    expect(isIntraFamilyRevision("default", "default-r0")).toBe(false);
    expect(isIntraFamilyRevision("default", "default-r2x")).toBe(false);
    expect(isIntraFamilyRevision("default", "default")).toBe(false);
    // A gateway id that is itself a prefix of another must not match across.
    expect(isIntraFamilyRevision("gw", "gw2-r1")).toBe(false);
  });
});

describe("resolveServiceRoute — per-customer mid-roll decision", () => {
  const base = {
    rosterLoaded: true,
    entry: null as RosterEntry | null,
    selfRevisionId: "default-r1",
    gatewayId: "default",
    isForwardedHop: false,
    forwardedEpoch: null as number | null,
  };

  it("503s EVERYTHING service-addressed until the roster is loaded — never serve-local on boot", () => {
    expect(resolveServiceRoute({ ...base, rosterLoaded: false })).toEqual({
      action: "unavailable",
      reason: "roster-loading",
    });
    // Even for a forwarded hop or an unknown customer.
    expect(
      resolveServiceRoute({ ...base, rosterLoaded: false, isForwardedHop: true }),
    ).toMatchObject({ action: "unavailable" });
  });

  it("serves a gap user (no roster entry) locally — the Service selector already picked the live revision", () => {
    expect(resolveServiceRoute(base)).toEqual({ action: "serve" });
  });

  it("serves a customer whose serving revision is THIS revision", () => {
    expect(resolveServiceRoute({ ...base, entry: entry() })).toEqual({ action: "serve" });
  });

  it("BLOCKS the source while the customer is quiescing — before the target ever serves (no double-serve window)", () => {
    expect(
      resolveServiceRoute({ ...base, entry: entry({ state: "quiescing" }) }),
    ).toEqual({ action: "unavailable", reason: "customer-quiescing" });
    expect(
      resolveServiceRoute({ ...base, entry: entry({ state: "migrating" }) }),
    ).toEqual({ action: "unavailable", reason: "customer-quiescing" });
    // The mid-flip window blocks on the target side too: quiescing on ANOTHER
    // revision never forwards.
    expect(
      resolveServiceRoute({
        ...base,
        selfRevisionId: "default-r2",
        entry: entry({ state: "quiescing", revisionId: "default-r1" }),
      }),
    ).toEqual({ action: "unavailable", reason: "customer-quiescing" });
  });

  it("forwards ONE intra-family hop when another revision serves the customer", () => {
    expect(
      resolveServiceRoute({
        ...base,
        entry: entry({ revisionId: "default-r2", epoch: 5 }),
      }),
    ).toEqual({ action: "forward", targetRevisionId: "default-r2", epoch: 5 });
  });

  it("NEVER re-forwards a forwarded request (one hop max), even when its roster disagrees", () => {
    expect(
      resolveServiceRoute({
        ...base,
        entry: entry({ revisionId: "default-r2", epoch: 5 }),
        isForwardedHop: true,
        forwardedEpoch: 5,
      }),
    ).toEqual({ action: "unavailable", reason: "forward-loop" });
  });

  it("labels a forwarded request carrying an OLDER epoch than the roster as stale (503 + retry, no bounce)", () => {
    expect(
      resolveServiceRoute({
        ...base,
        entry: entry({ revisionId: "default-r2", epoch: 7 }),
        isForwardedHop: true,
        forwardedEpoch: 5,
      }),
    ).toEqual({ action: "unavailable", reason: "stale-forward" });
  });

  it("a forwarded request whose customer serves HERE is served (the normal second hop)", () => {
    expect(
      resolveServiceRoute({
        ...base,
        selfRevisionId: "default-r2",
        entry: entry({ revisionId: "default-r2", epoch: 5 }),
        isForwardedHop: true,
        forwardedEpoch: 5,
      }),
    ).toEqual({ action: "serve" });
  });

  it("refuses to forward to an out-of-family roster entry (poisoned data can never route off-gateway)", () => {
    expect(
      resolveServiceRoute({
        ...base,
        entry: entry({ revisionId: "bender-r2" }),
      }),
    ).toEqual({ action: "unavailable", reason: "out-of-family" });
  });
});

describe("createRollRosterStore", () => {
  it("is unloaded until the first snapshot, then serves entries", () => {
    let push: ((docs: Array<{ id: string; data: () => Record<string, unknown> }>) => void) | null =
      null;
    const store = createRollRosterStore({
      subscribe: (onDocs) => {
        push = onDocs;
        return () => undefined;
      },
      log: vi.fn(),
    });
    expect(store.loaded()).toBe(false);
    push!([
      {
        id: "u1",
        data: () => ({
          uid: "u1",
          slug: "s1",
          gatewayId: "default",
          revisionId: "default-r2",
          release: 2,
          source: "rollout",
          state: "serving",
          epoch: 3,
          updatedAt: 1,
          updatedByOperationId: null,
        }),
      },
      // Malformed docs are skipped, never treated as a mount/route signal.
      { id: "junk", data: () => ({ nope: true }) },
    ]);
    expect(store.loaded()).toBe(true);
    expect(store.get("u1")).toMatchObject({ revisionId: "default-r2", state: "serving", epoch: 3 });
    expect(store.get("junk")).toBeUndefined();
    // Next snapshot REPLACES the roster (removed assignments drop out).
    push!([]);
    expect(store.get("u1")).toBeUndefined();
    expect(store.loaded()).toBe(true);
  });

  it("stays unloaded (fail closed → 503s) when the subscription errors before any snapshot", () => {
    const log = vi.fn();
    const reconnects: Array<() => void> = [];
    const store = createRollRosterStore({
      subscribe: (_onDocs, onError) => {
        onError(new Error("firestore unavailable"));
        return () => undefined;
      },
      log,
      scheduleReconnect: (_attempt, retry) => reconnects.push(retry),
    });
    expect(store.loaded()).toBe(false);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("firestore unavailable"));
    // Fail-closed error path schedules a re-subscribe rather than giving up.
    expect(reconnects).toHaveLength(1);
    store.stop();
  });

  it("RESETS to unloaded (fail closed) after a terminal error following a successful load", () => {
    const log = vi.fn();
    let push: ((docs: Array<{ id: string; data: () => Record<string, unknown> }>) => void) | null =
      null;
    let fail: ((err: Error) => void) | null = null;
    const reconnects: Array<() => void> = [];
    let subscribeCount = 0;
    const store = createRollRosterStore({
      subscribe: (onDocs, onError) => {
        subscribeCount += 1;
        push = onDocs;
        fail = onError;
        return () => undefined;
      },
      log,
      scheduleReconnect: (_attempt, retry) => reconnects.push(retry),
    });

    const entry = {
      id: "u1",
      data: () => ({
        uid: "u1",
        slug: "s1",
        gatewayId: "default",
        revisionId: "default-r2",
        release: 2,
        source: "rollout",
        state: "serving",
        epoch: 3,
        updatedAt: 1,
        updatedByOperationId: null,
      }),
    };
    push!([entry]);
    expect(store.loaded()).toBe(true);
    expect(store.get("u1")).toBeTruthy();

    // Terminal listener error AFTER a good load: readiness drops (gate 503s) and
    // the stale entry is no longer authoritative — never served from a detached
    // roster.
    fail!(new Error("listener torn down"));
    expect(store.loaded()).toBe(false);
    expect(store.get("u1")).toBeUndefined();
    expect(log).toHaveBeenCalledWith(expect.stringContaining("listener torn down"));
    expect(log).toHaveBeenCalledWith(expect.stringContaining("503"));
    expect(reconnects).toHaveLength(1);

    // A re-established listener restores serving.
    reconnects[0]();
    expect(subscribeCount).toBe(2);
    push!([entry]);
    expect(store.loaded()).toBe(true);
    expect(store.get("u1")).toBeTruthy();
    store.stop();
  });

  it("does not re-subscribe after stop() even if a terminal error fires", () => {
    const reconnects: Array<() => void> = [];
    let fail: ((err: Error) => void) | null = null;
    let subscribeCount = 0;
    const store = createRollRosterStore({
      subscribe: (_onDocs, onError) => {
        subscribeCount += 1;
        fail = onError;
        return () => undefined;
      },
      log: vi.fn(),
      scheduleReconnect: (_attempt, retry) => reconnects.push(retry),
    });
    store.stop();
    fail!(new Error("post-stop error"));
    // stop() short-circuits the reconnect schedule.
    expect(reconnects).toHaveLength(0);
    expect(subscribeCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// The Express gate, end to end over real sockets
// ---------------------------------------------------------------------------

interface GateHarness {
  port: number;
  upstreamPort: number;
  upstreamRequests: Array<{ url: string; headers: http.IncomingHttpHeaders }>;
  servedLocally: string[];
  close: () => void;
}

async function mkGateHarness(opts: {
  entries?: RosterEntry[];
  loaded?: boolean;
  selfRevisionId?: string;
}): Promise<GateHarness> {
  const upstreamRequests: Array<{ url: string; headers: http.IncomingHttpHeaders }> = [];
  const upstream = http.createServer((req, res) => {
    upstreamRequests.push({ url: req.url ?? "", headers: req.headers });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ served: "upstream" }));
  });
  const upstreamPort = await listen(upstream);

  const entries = new Map((opts.entries ?? []).map((e) => [e.uid, e]));
  const store = {
    loaded: () => opts.loaded !== false,
    get: (uid: string) => entries.get(uid),
    stop: () => undefined,
  };

  const app = express();
  const servedLocally: string[] = [];
  app.use(
    createRollRosterGate({
      store,
      gatewayId: "default",
      selfRevisionId: opts.selfRevisionId ?? "default-r1",
      targetOriginForRevision: () => `http://127.0.0.1:${upstreamPort}`,
      log: vi.fn(),
    }),
  );
  app.use((req, res) => {
    servedLocally.push(req.path);
    res.json({ served: "local" });
  });
  const server = http.createServer(app);
  const port = await listen(server);
  return {
    port,
    upstreamPort,
    upstreamRequests,
    servedLocally,
    close: () => {
      server.close();
      upstream.close();
    },
  };
}

async function get(
  port: number,
  path: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: "127.0.0.1", port, path, method: "GET", headers },
      (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () =>
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body }),
        );
      },
    );
    req.on("error", reject);
    req.end();
  });
}

describe("createRollRosterGate — end to end", () => {
  it("503 + Retry-After for ALL requests while the roster is loading (boot mid-roll)", async () => {
    const h = await mkGateHarness({ loaded: false });
    try {
      const res = await get(h.port, "/api/g/default/workspace/git/status", {
        authorization: bearerFor("u1"),
      });
      expect(res.status).toBe(503);
      expect(res.headers["retry-after"]).toBeDefined();
      expect(h.servedLocally).toEqual([]);
    } finally {
      h.close();
    }
  });

  it("serves locally when the customer's assignment points at this revision", async () => {
    const h = await mkGateHarness({ entries: [entry()] });
    try {
      const res = await get(h.port, "/api/g/default/workspace/git/status", {
        authorization: bearerFor("u1"),
      });
      expect(res.status).toBe(200);
      expect(h.servedLocally).toHaveLength(1);
      expect(h.upstreamRequests).toHaveLength(0);
    } finally {
      h.close();
    }
  });

  it("forwards ONE hop to the serving revision's edge, tagging loop-guard + epoch headers", async () => {
    const h = await mkGateHarness({
      entries: [entry({ revisionId: "default-r2", epoch: 4 })],
    });
    try {
      const res = await get(h.port, "/api/g/default/workspace/git/status?x=1", {
        authorization: bearerFor("u1"),
      });
      expect(res.status).toBe(200);
      expect(JSON.parse(res.body)).toEqual({ served: "upstream" });
      expect(h.upstreamRequests).toHaveLength(1);
      expect(h.upstreamRequests[0].url).toBe("/api/g/default/workspace/git/status?x=1");
      expect(h.upstreamRequests[0].headers[INTRA_FAMILY_HOP_HEADER]).toBe("default-r1");
      expect(h.upstreamRequests[0].headers[ASSIGNMENT_EPOCH_HEADER]).toBe("4");
      expect(h.servedLocally).toEqual([]);
    } finally {
      h.close();
    }
  });

  it("a request already carrying the hop header is NEVER forwarded again (one hop max)", async () => {
    const h = await mkGateHarness({
      entries: [entry({ revisionId: "default-r2", epoch: 4 })],
    });
    try {
      const res = await get(h.port, "/api/g/default/workspace/git/status", {
        authorization: bearerFor("u1"),
        [INTRA_FAMILY_HOP_HEADER]: "default-r2",
        [ASSIGNMENT_EPOCH_HEADER]: "4",
      });
      expect(res.status).toBe(503);
      expect(res.headers["retry-after"]).toBeDefined();
      expect(h.upstreamRequests).toHaveLength(0);
      expect(h.servedLocally).toEqual([]);
    } finally {
      h.close();
    }
  });

  it("503s a quiescing customer on the source (blocked BEFORE the target serves)", async () => {
    const h = await mkGateHarness({ entries: [entry({ state: "quiescing" })] });
    try {
      const res = await get(h.port, "/api/g/default/workspace/git/status", {
        authorization: bearerFor("u1"),
      });
      expect(res.status).toBe(503);
      expect(h.servedLocally).toEqual([]);
      expect(h.upstreamRequests).toHaveLength(0);
    } finally {
      h.close();
    }
  });

  it("requests without a resolvable uid serve locally (no customer state to protect)", async () => {
    const h = await mkGateHarness({
      entries: [entry({ revisionId: "default-r2" })],
    });
    try {
      const res = await get(h.port, "/api/health");
      expect(res.status).toBe(200);
      expect(h.servedLocally).toEqual(["/api/health"]);
    } finally {
      h.close();
    }
  });

  it("a poisoned out-of-family roster entry can NEVER route off-gateway — 503, no proxy call", async () => {
    const h = await mkGateHarness({
      entries: [entry({ revisionId: "bender-r9" })],
    });
    try {
      const res = await get(h.port, "/api/g/default/workspace/git/status", {
        authorization: bearerFor("u1"),
      });
      expect(res.status).toBe(503);
      expect(h.upstreamRequests).toHaveLength(0);
    } finally {
      h.close();
    }
  });

  it("legacy pod (no revision id) never gates anything", async () => {
    const h = await mkGateHarness({
      selfRevisionId: "",
      entries: [entry({ revisionId: "default-r2" })],
      loaded: false,
    });
    try {
      const res = await get(h.port, "/api/g/default/workspace/git/status", {
        authorization: bearerFor("u1"),
      });
      expect(res.status).toBe(200);
      expect(h.servedLocally).toHaveLength(1);
    } finally {
      h.close();
    }
  });
});

// ---------------------------------------------------------------------------
// WebSocket upgrade gate (Codex review P0): upgrades must run the SAME
// roster/boot checks as the HTTP middleware, at the upgrade path itself.
// ---------------------------------------------------------------------------

function mkUpgradeGate(opts: {
  entries?: RosterEntry[];
  loaded?: boolean;
  selfRevisionId?: string;
}) {
  const entries = new Map((opts.entries ?? []).map((e) => [e.uid, e]));
  return createRollRosterUpgradeGate({
    store: { loaded: () => opts.loaded !== false, get: (uid: string) => entries.get(uid) },
    gatewayId: "default",
    selfRevisionId: opts.selfRevisionId ?? "default-r1",
    log: vi.fn(),
  });
}

describe("revisionUnavailableUpgradeResponse — the retryable roll-in-progress signal", () => {
  it("is a 503 + Retry-After, NOT a generic 500, and carries the typed body", () => {
    const raw = revisionUnavailableUpgradeResponse(2, "gateway-url-unresolved");
    expect(raw.startsWith("HTTP/1.1 503 Service Unavailable\r\n")).toBe(true);
    expect(raw).toContain("Retry-After: 2\r\n");
    expect(raw).not.toContain("500 Internal Server Error");
    const body = raw.slice(raw.indexOf("\r\n\r\n") + 4);
    expect(JSON.parse(body)).toEqual({
      error: "gateway_revision_unavailable",
      reason: "gateway-url-unresolved",
    });
  });
});

describe("createRollRosterUpgradeGate — verdicts", () => {
  it("refuses every upgrade while the roster is loading (boot mid-roll)", () => {
    const gate = mkUpgradeGate({ loaded: false });
    expect(gate.checkUid("u1")).toMatchObject({ allow: false, reason: "roster-loading" });
    expect(gate.checkUid(null)).toMatchObject({ allow: false, reason: "roster-loading" });
  });

  it("refuses a quiescing customer (source blocked before the target serves)", () => {
    const gate = mkUpgradeGate({ entries: [entry({ state: "quiescing" })] });
    expect(gate.checkUid("u1")).toMatchObject({ allow: false, reason: "customer-quiescing" });
  });

  it("refuses a customer serving on ANOTHER revision — WS is never hop-forwarded; the client reconnects via the serving revision", () => {
    const gate = mkUpgradeGate({ entries: [entry({ revisionId: "default-r2" })] });
    expect(gate.checkUid("u1")).toMatchObject({ allow: false, reason: "serving-elsewhere" });
  });

  it("allows a customer serving HERE, a gap user, and everything on a legacy pod", () => {
    expect(mkUpgradeGate({ entries: [entry()] }).checkUid("u1")).toEqual({ allow: true });
    expect(mkUpgradeGate({}).checkUid("unknown-uid")).toEqual({ allow: true });
    expect(mkUpgradeGate({ selfRevisionId: "", loaded: false }).checkUid("u1")).toEqual({
      allow: true,
    });
  });

  it("checkRequest resolves the uid from the bearer, exactly like the HTTP gate", () => {
    const gate = mkUpgradeGate({ entries: [entry({ state: "quiescing" })] });
    const req = { headers: { authorization: bearerFor("u1") } } as unknown as http.IncomingMessage;
    expect(gate.checkRequest(req)).toMatchObject({ allow: false, reason: "customer-quiescing" });
    const anon = { headers: {} } as unknown as http.IncomingMessage;
    expect(gate.checkRequest(anon)).toEqual({ allow: true });
  });

  // P1 — an authenticated identity that resolves to NO roster uid (missing/stale
  // mattermost.userId mapping) must NOT be served locally during a roll.
  it("checkUnmappedIdentity: a revision pod REFUSES (retryable) — never serves an unmapped authenticated user locally", () => {
    expect(mkUpgradeGate({}).checkUnmappedIdentity()).toMatchObject({
      allow: false,
      reason: "identity-unmapped",
    });
  });

  it("checkUnmappedIdentity: still fails closed while the roster is loading (boot mid-roll)", () => {
    expect(mkUpgradeGate({ loaded: false }).checkUnmappedIdentity()).toMatchObject({
      allow: false,
      reason: "roster-loading",
    });
  });

  it("checkUnmappedIdentity: a legacy pod (no roster gate) still allows", () => {
    expect(mkUpgradeGate({ selfRevisionId: "", loaded: false }).checkUnmappedIdentity()).toEqual({
      allow: true,
    });
  });
});

describe("mmRosterVerdictFor — auth-late MM identity → shared roster verdict (P1 fail-open fix)", () => {
  it("an authenticated MM user with no Firebase mapping (lookup returns null) is REFUSED, not served locally", async () => {
    const gate = mkUpgradeGate({ entries: [entry()] }); // revision pod, roster loaded
    const verdict = await mmRosterVerdictFor(gate, "mm-stale", async () => null);
    expect(verdict).toMatchObject({ allow: false, reason: "identity-unmapped" });
  });

  it("a lookup that THROWS propagates so the caller fails closed (pin)", async () => {
    const gate = mkUpgradeGate({ entries: [entry()] });
    await expect(
      mmRosterVerdictFor(gate, "mm-x", async () => {
        throw new Error("firestore unavailable");
      }),
    ).rejects.toThrow("firestore unavailable");
  });

  it("a resolvable user serving HERE is admitted (regression pin)", async () => {
    const gate = mkUpgradeGate({ entries: [entry({ uid: "u1" })] });
    const verdict = await mmRosterVerdictFor(gate, "mm-u1", async () => "u1");
    expect(verdict).toEqual({ allow: true });
  });

  it("no MM identity at all (null) takes the gap-user path — the lookup is never called", async () => {
    const gate = mkUpgradeGate({ entries: [entry()] });
    const lookup = vi.fn(async () => "unused");
    const verdict = await mmRosterVerdictFor(gate, null, lookup);
    expect(verdict).toEqual({ allow: true });
    expect(lookup).not.toHaveBeenCalled();
  });
});

describe("guardUpgradeRequest — real sockets", () => {
  async function upgradeStatus(
    port: number,
    headers: Record<string, string> = {},
  ): Promise<{ status: number | null; raw: string }> {
    return new Promise((resolve, reject) => {
      const req = http.request({
        hostname: "127.0.0.1",
        port,
        path: "/api/g/default/api/v4/websocket",
        headers: {
          Connection: "Upgrade",
          Upgrade: "websocket",
          "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==",
          "Sec-WebSocket-Version": "13",
          ...headers,
        },
      });
      req.on("response", (res) => {
        let raw = "";
        res.on("data", (c) => (raw += c));
        res.on("end", () => resolve({ status: res.statusCode ?? null, raw }));
      });
      req.on("upgrade", (res) => resolve({ status: res.statusCode ?? null, raw: "upgraded" }));
      req.on("error", reject);
      req.end();
    });
  }

  async function mkUpgradeServer(gate: ReturnType<typeof mkUpgradeGate> | null) {
    const dispatched: string[] = [];
    const server = http.createServer((_req, res) => {
      res.writeHead(200);
      res.end("http");
    });
    server.on("upgrade", (req, socket, _head) => {
      // The exact wiring shape proxy.ts uses: gate FIRST, before any dispatch.
      if (guardUpgradeRequest(gate, req, socket)) return;
      dispatched.push(req.url ?? "");
      socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
      socket.destroy();
    });
    const port = await listen(server);
    return { port, dispatched, close: () => server.close() };
  }

  it("destroys the socket with 503 + Retry-After while the roster loads — never dispatches", async () => {
    const h = await mkUpgradeServer(mkUpgradeGate({ loaded: false }));
    try {
      const res = await upgradeStatus(h.port, { authorization: bearerFor("u1") });
      expect(res.status).toBe(503);
      expect(h.dispatched).toEqual([]);
    } finally {
      h.close();
    }
  });

  it("refuses an upgrade for a quiescing customer", async () => {
    const h = await mkUpgradeServer(mkUpgradeGate({ entries: [entry({ state: "quiescing" })] }));
    try {
      const res = await upgradeStatus(h.port, { authorization: bearerFor("u1") });
      expect(res.status).toBe(503);
      expect(h.dispatched).toEqual([]);
    } finally {
      h.close();
    }
  });

  it("refuses an upgrade for a customer serving on the other revision", async () => {
    const h = await mkUpgradeServer(
      mkUpgradeGate({ entries: [entry({ revisionId: "default-r2" })] }),
    );
    try {
      const res = await upgradeStatus(h.port, { authorization: bearerFor("u1") });
      expect(res.status).toBe(503);
      expect(h.dispatched).toEqual([]);
    } finally {
      h.close();
    }
  });

  it("steady state passes the upgrade through to normal dispatch (regression pin)", async () => {
    const h = await mkUpgradeServer(mkUpgradeGate({ entries: [entry()] }));
    try {
      const res = await upgradeStatus(h.port, { authorization: bearerFor("u1") });
      expect(res.status).toBe(404); // reached the dispatcher, not the gate
      expect(h.dispatched).toHaveLength(1);
    } finally {
      h.close();
    }
  });

  it("no gate installed (legacy pod / cluster surface) → dispatch untouched", async () => {
    const h = await mkUpgradeServer(null);
    try {
      const res = await upgradeStatus(h.port);
      expect(res.status).toBe(404);
      expect(h.dispatched).toHaveLength(1);
    } finally {
      h.close();
    }
  });
});

describe("wrapRedeemWithRosterGate — the builder-shell attach site", () => {
  const session = { uid: "u1", gatewayId: "default", sessionId: "s1" };

  it("passes through a redeem for a customer serving here", async () => {
    const gate = mkUpgradeGate({ entries: [entry()] });
    const redeem = wrapRedeemWithRosterGate(async () => session, gate);
    await expect(redeem("ticket")).resolves.toEqual(session);
  });

  it("REFUSES the redeem (throws) for a quiescing customer — the bridge closes the WS with retry semantics", async () => {
    const gate = mkUpgradeGate({ entries: [entry({ state: "quiescing" })] });
    const redeem = wrapRedeemWithRosterGate(async () => session, gate);
    await expect(redeem("ticket")).rejects.toThrow(/customer-quiescing/);
  });

  it("REFUSES the redeem for a customer serving on the other revision", async () => {
    const gate = mkUpgradeGate({ entries: [entry({ revisionId: "default-r2" })] });
    const redeem = wrapRedeemWithRosterGate(async () => session, gate);
    await expect(redeem("ticket")).rejects.toThrow(/serving-elsewhere/);
  });

  it("no gate → identity wrapper", async () => {
    const redeem = wrapRedeemWithRosterGate(async () => session, null);
    await expect(redeem("ticket")).resolves.toEqual(session);
  });
});
