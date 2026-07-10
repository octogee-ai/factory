import { describe, it, expect, vi } from "vitest";
import { EventEmitter } from "node:events";
import type { WebSocket } from "ws";
import {
  MM_WS_RECONNECT_CLOSE_CODE,
  attachMmWsBridge,
  buildAckIfUserPost,
  isAuthChallengeFrame,
  maybeCaptureMmTokenForAuth,
} from "../mm-proxy/ws.js";

const FIXED_NOW = () => 1_700_000_000_000;

interface FakeWs extends EventEmitter {
  readyState: 0 | 1 | 2 | 3;
  sent: Array<string | Buffer>;
  closeCalls: Array<{ code?: number; reason?: string }>;
  send: (data: unknown) => void;
  close: (code?: number, reason?: string) => void;
}

function makeFakeWs(initialState: 0 | 1 = 1): FakeWs {
  const ee = new EventEmitter() as FakeWs;
  ee.readyState = initialState;
  ee.sent = [];
  ee.closeCalls = [];
  ee.send = (data: unknown) => {
    ee.sent.push(data as string | Buffer);
  };
  ee.close = (code?: number, reason?: string) => {
    ee.closeCalls.push({ code, reason });
    if (ee.readyState !== 3) {
      ee.readyState = 3;
      ee.emit("close");
    }
  };
  return ee;
}

const tick = () => new Promise<void>((r) => setImmediate(r));
const tickN = async (n: number) => {
  for (let i = 0; i < n; i++) await tick();
};

const AUTH_FRAME = JSON.stringify({
  seq: 1,
  action: "authentication_challenge",
  data: { token: "tok-xyz" },
});

// The bridge dials the MM upstream only after the first auth challenge passes
// the roster verdict — tests drive that dance explicitly.
async function authAndOpen(browser: FakeWs, upstream: FakeWs, frame: string = AUTH_FRAME) {
  browser.emit("message", frame);
  await tickN(5);
  upstream.readyState = 1;
  upstream.emit("open");
  await tickN(2);
}

describe("buildAckIfUserPost", () => {
  it("returns null when mmUserId is unknown", () => {
    const frame = JSON.stringify({
      event: "posted",
      data: { post: JSON.stringify({ id: "p1", user_id: "u1", channel_id: "c1" }) },
    });
    expect(buildAckIfUserPost(frame, null, FIXED_NOW)).toBeNull();
  });

  it("returns null for non-posted events", () => {
    const frame = JSON.stringify({
      event: "typing",
      data: { user_id: "u1", channel_id: "c1" },
    });
    expect(buildAckIfUserPost(frame, "u1", FIXED_NOW)).toBeNull();
  });

  it("returns null when the post is not authored by the connected user", () => {
    const frame = JSON.stringify({
      event: "posted",
      data: { post: JSON.stringify({ id: "p1", user_id: "u2", channel_id: "c1" }) },
    });
    expect(buildAckIfUserPost(frame, "u1", FIXED_NOW)).toBeNull();
  });

  it("returns an octogee_ack frame when the user authors a post (string-encoded post field)", () => {
    const frame = JSON.stringify({
      event: "posted",
      data: { post: JSON.stringify({ id: "p1", user_id: "u1", channel_id: "c1" }) },
    });
    const ack = buildAckIfUserPost(frame, "u1", FIXED_NOW);
    expect(ack).toEqual({
      event: "octogee_ack",
      data: { postId: "p1", channelId: "c1", receivedAt: 1_700_000_000_000 },
    });
  });

  it("returns an octogee_ack frame when post is object-typed (defensive)", () => {
    const frame = JSON.stringify({
      event: "posted",
      data: { post: { id: "p9", user_id: "u1", channel_id: "c9" } },
    });
    const ack = buildAckIfUserPost(frame, "u1", FIXED_NOW);
    expect(ack).toEqual({
      event: "octogee_ack",
      data: { postId: "p9", channelId: "c9", receivedAt: 1_700_000_000_000 },
    });
  });

  it("safely returns null for unparseable frames", () => {
    expect(buildAckIfUserPost("not-json", "u1", FIXED_NOW)).toBeNull();
    expect(buildAckIfUserPost("", "u1", FIXED_NOW)).toBeNull();
  });
});

describe("isAuthChallengeFrame", () => {
  it("recognizes authentication_challenge frames (string and Buffer)", () => {
    expect(isAuthChallengeFrame(AUTH_FRAME)).toBe(true);
    expect(isAuthChallengeFrame(Buffer.from(AUTH_FRAME))).toBe(true);
  });

  it("rejects other frames and junk", () => {
    expect(isAuthChallengeFrame(JSON.stringify({ action: "get_statuses" }))).toBe(false);
    expect(isAuthChallengeFrame("not-json")).toBe(false);
    expect(isAuthChallengeFrame("")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Roll roster verdict at authentication (Codex P0): the upstream MM socket is
// dialed only AFTER the first auth challenge resolves the MM user and the
// shared roster verdict allows — a moved/quiescing customer is closed with the
// reconnect-signaling code and NEVER reaches a stale revision's upstream.
// ---------------------------------------------------------------------------

describe("attachMmWsBridge — roll roster verdict at authentication (Codex P0)", () => {
  function mkBridge(opts: {
    verdict?: (
      mmUserId: string | null,
    ) =>
      | Promise<{ allow: true } | { allow: false; reason: string }>
      | { allow: true }
      | { allow: false; reason: string };
    resolveMmUserId?: (token: string) => Promise<string | null>;
  }) {
    const browser = makeFakeWs(1);
    const upstream = makeFakeWs(0);
    const openUpstream = vi.fn(() => upstream as unknown as WebSocket);
    const log = vi.fn();
    attachMmWsBridge(
      {
        mmInternalWsUrl: "ws://mm.internal/api/v4/websocket",
        log,
        resolveMmUserId: opts.resolveMmUserId ?? (async () => "mm-u1"),
        openUpstream,
        ...(opts.verdict ? { rosterVerdict: opts.verdict } : {}),
      },
      browser as unknown as WebSocket,
    );
    return { browser, upstream, openUpstream, log };
  }

  it("upgrade attaches (uid unknowable), but the upstream is NOT dialed before the first auth frame", async () => {
    const h = mkBridge({ verdict: () => ({ allow: true as const }) });
    h.browser.emit("message", JSON.stringify({ seq: 0, action: "get_statuses" }));
    await tickN(3);
    expect(h.openUpstream).not.toHaveBeenCalled();
  });

  it("moved/quiescing customer: first auth frame → verdict → client closed with the reconnect code; upstream NEVER dialed", async () => {
    const h = mkBridge({
      verdict: () => ({ allow: false as const, reason: "serving-elsewhere" }),
    });
    h.browser.emit("message", AUTH_FRAME);
    await tickN(5);
    expect(h.openUpstream).not.toHaveBeenCalled();
    expect(h.browser.readyState).toBe(3);
    expect(h.browser.closeCalls[0]).toMatchObject({
      code: MM_WS_RECONNECT_CLOSE_CODE,
      reason: expect.stringContaining("serving-elsewhere"),
    });
    expect(h.log).toHaveBeenCalledWith(expect.stringContaining("serving-elsewhere"));
  });

  it("roster-loading at auth time → closed with the reconnect code (retry semantics), no dial", async () => {
    const h = mkBridge({
      verdict: () => ({ allow: false as const, reason: "roster-loading" }),
    });
    h.browser.emit("message", AUTH_FRAME);
    await tickN(5);
    expect(h.openUpstream).not.toHaveBeenCalled();
    expect(h.browser.closeCalls[0]).toMatchObject({
      code: MM_WS_RECONNECT_CLOSE_CODE,
      reason: expect.stringContaining("roster-loading"),
    });
  });

  it("serving customer: auth frame → verdict → upstream dialed and frames flow (steady-state regression pin)", async () => {
    const verdict = vi.fn(async (mmUserId: string | null) => {
      expect(mmUserId).toBe("mm-u1"); // verdict sees the RESOLVED user
      return { allow: true as const };
    });
    const h = mkBridge({ verdict });
    await authAndOpen(h.browser, h.upstream);
    expect(h.openUpstream).toHaveBeenCalledTimes(1);
    // The buffered auth frame reached MM first, then live frames flow.
    expect(h.upstream.sent).toEqual([AUTH_FRAME]);
    const statuses = JSON.stringify({ seq: 2, action: "get_statuses" });
    h.browser.emit("message", statuses);
    expect(h.upstream.sent).toEqual([AUTH_FRAME, statuses]);
  });

  it("the verdict COMPLETES before the dial — never fire-and-forget", async () => {
    let resolveVerdict: (v: { allow: true }) => void = (_v) => undefined;
    const h = mkBridge({
      verdict: () => new Promise<{ allow: true }>((r) => (resolveVerdict = r)),
    });
    h.browser.emit("message", AUTH_FRAME);
    await tickN(5);
    expect(h.openUpstream).not.toHaveBeenCalled(); // verdict still pending
    resolveVerdict({ allow: true });
    await tickN(3);
    expect(h.openUpstream).toHaveBeenCalledTimes(1);
  });

  it("a throwing verdict fails CLOSED (client closed with retry semantics, no dial)", async () => {
    const h = mkBridge({
      verdict: () => {
        throw new Error("firestore unavailable");
      },
    });
    h.browser.emit("message", AUTH_FRAME);
    await tickN(5);
    expect(h.openUpstream).not.toHaveBeenCalled();
    expect(h.browser.closeCalls[0]).toMatchObject({ code: MM_WS_RECONNECT_CLOSE_CODE });
  });

  it("pre-auth frames keep the existing buffered shape: queued in order, flushed after admission + open", async () => {
    const h = mkBridge({ verdict: () => ({ allow: true as const }) });
    const statuses = JSON.stringify({ seq: 0, action: "get_statuses" });
    h.browser.emit("message", statuses);
    await tickN(2);
    expect(h.openUpstream).not.toHaveBeenCalled();
    await authAndOpen(h.browser, h.upstream);
    expect(h.upstream.sent).toEqual([statuses, AUTH_FRAME]);
  });

  it("no rosterVerdict configured (legacy pod / cluster surface): auth admits unconditionally", async () => {
    const h = mkBridge({});
    await authAndOpen(h.browser, h.upstream);
    expect(h.openUpstream).toHaveBeenCalledTimes(1);
    expect(h.upstream.sent).toEqual([AUTH_FRAME]);
  });
});

// ---------------------------------------------------------------------------
// Pre-auth DoS bounds (arc security review): the auth-late bridge holds the
// upstream dial until the first authentication_challenge. Without bounds an
// unauthenticated client could stream non-auth frames forever, buffering to
// memory pressure. A deadline closes a never-authenticating socket; frame-count
// and byte caps bound the pre-open queue. All use the standard reconnect close.
// ---------------------------------------------------------------------------

describe("attachMmWsBridge — pre-auth DoS bounds", () => {
  const realDelay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

  function mkBridge(deps: {
    preAuthDeadlineMs?: number;
    maxPreAuthFrames?: number;
    maxPreAuthBytes?: number;
  }) {
    const browser = makeFakeWs(1);
    const upstream = makeFakeWs(0);
    const openUpstream = vi.fn(() => upstream as unknown as WebSocket);
    const log = vi.fn();
    attachMmWsBridge(
      {
        mmInternalWsUrl: "ws://mm.internal/api/v4/websocket",
        log,
        resolveMmUserId: async () => "mm-u1",
        openUpstream,
        ...deps,
      },
      browser as unknown as WebSocket,
    );
    return { browser, upstream, openUpstream, log };
  }

  it("no auth challenge within the deadline → closed with the reconnect code; upstream NEVER dialed", async () => {
    const h = mkBridge({ preAuthDeadlineMs: 20 });
    h.browser.emit("message", JSON.stringify({ seq: 0, action: "get_statuses" }));
    await realDelay(50);
    expect(h.openUpstream).not.toHaveBeenCalled();
    expect(h.browser.readyState).toBe(3);
    expect(h.browser.closeCalls[0]).toMatchObject({ code: MM_WS_RECONNECT_CLOSE_CODE });
  });

  it("pre-auth frame-count cap exceeded → closed; upstream NEVER dialed", async () => {
    const h = mkBridge({ maxPreAuthFrames: 3, preAuthDeadlineMs: 10_000 });
    for (let i = 0; i < 4; i++) {
      h.browser.emit("message", JSON.stringify({ seq: i, action: "get_statuses" }));
    }
    await tickN(2);
    expect(h.openUpstream).not.toHaveBeenCalled();
    expect(h.browser.readyState).toBe(3);
    expect(h.browser.closeCalls[0]).toMatchObject({ code: MM_WS_RECONNECT_CLOSE_CODE });
  });

  it("pre-auth byte cap exceeded → closed; upstream NEVER dialed", async () => {
    const h = mkBridge({ maxPreAuthBytes: 100, maxPreAuthFrames: 1_000, preAuthDeadlineMs: 10_000 });
    h.browser.emit(
      "message",
      JSON.stringify({ seq: 0, action: "get_statuses", pad: "x".repeat(200) }),
    );
    await tickN(2);
    expect(h.openUpstream).not.toHaveBeenCalled();
    expect(h.browser.readyState).toBe(3);
    expect(h.browser.closeCalls[0]).toMatchObject({ code: MM_WS_RECONNECT_CLOSE_CODE });
  });

  it("normal client (auth challenge first): admitted, buffered frame flushes, and neither cap nor deadline closes it (regression pin)", async () => {
    const h = mkBridge({ preAuthDeadlineMs: 30, maxPreAuthFrames: 3, maxPreAuthBytes: 1_000 });
    await authAndOpen(h.browser, h.upstream);
    expect(h.openUpstream).toHaveBeenCalledTimes(1);
    expect(h.upstream.sent).toEqual([AUTH_FRAME]);
    // Past the deadline — but admission started, so the deadline was disarmed.
    await realDelay(60);
    expect(h.browser.readyState).toBe(1);
    expect(h.browser.closeCalls).toHaveLength(0);
    const statuses = JSON.stringify({ seq: 2, action: "get_statuses" });
    h.browser.emit("message", statuses);
    expect(h.upstream.sent).toEqual([AUTH_FRAME, statuses]);
  });
});

describe("attachMmWsBridge — buffering + mmUserId race", () => {
  it("buffers browser→upstream frames until upstream emits 'open' (auth_challenge race)", async () => {
    const browser = makeFakeWs(1);
    const upstream = makeFakeWs(0);
    const log = vi.fn();

    attachMmWsBridge(
      {
        mmInternalWsUrl: "ws://mm.internal/api/v4/websocket",
        log,
        resolveMmUserId: async () => "u1",
        openUpstream: () => upstream as unknown as WebSocket,
      },
      browser as unknown as WebSocket,
    );

    browser.emit("message", AUTH_FRAME);
    await tickN(5); // admission ran; upstream dialed but not yet open

    expect(upstream.sent).toEqual([]);

    upstream.readyState = 1;
    upstream.emit("open");

    expect(upstream.sent).toEqual([AUTH_FRAME]);
  });

  it("forwards directly once authenticated and the upstream is open", async () => {
    const browser = makeFakeWs(1);
    const upstream = makeFakeWs(0);

    attachMmWsBridge(
      {
        mmInternalWsUrl: "ws://mm.internal/api/v4/websocket",
        log: vi.fn(),
        resolveMmUserId: async () => "u1",
        openUpstream: () => upstream as unknown as WebSocket,
      },
      browser as unknown as WebSocket,
    );
    await authAndOpen(browser, upstream);

    const frame = JSON.stringify({ seq: 2, action: "get_statuses" });
    browser.emit("message", frame);

    expect(upstream.sent).toEqual([AUTH_FRAME, frame]);
  });

  it("awaits mmUserId resolution before deciding ack on inbound posted (re-auth race, no silent no-op)", async () => {
    const browser = makeFakeWs(1);
    const upstream = makeFakeWs(0);

    let resolveAuth: (id: string | null) => void = (_id) => undefined;
    const resolveMmUserId = vi.fn((token: string): Promise<string | null> => {
      if (token === "tok-first") return Promise.resolve(null); // failed first auth
      return new Promise<string | null>((resolve) => {
        resolveAuth = resolve;
      });
    });

    attachMmWsBridge(
      {
        mmInternalWsUrl: "ws://mm.internal/api/v4/websocket",
        log: vi.fn(),
        resolveMmUserId,
        openUpstream: () => upstream as unknown as WebSocket,
        ackResolutionTimeoutMs: 1_000,
        now: FIXED_NOW,
      },
      browser as unknown as WebSocket,
    );
    // First auth attempt fails token resolution → bridge still admits (MM
    // enforces auth itself) and dials.
    await authAndOpen(
      browser,
      upstream,
      JSON.stringify({ seq: 1, action: "authentication_challenge", data: { token: "tok-first" } }),
    );

    // Client retries auth; resolution is slow while a posted event races in.
    browser.emit(
      "message",
      JSON.stringify({ seq: 2, action: "authentication_challenge", data: { token: "tok-xyz" } }),
    );

    const postedFrame = JSON.stringify({
      event: "posted",
      data: { post: JSON.stringify({ id: "p1", user_id: "u-target", channel_id: "c1" }) },
    });
    upstream.emit("message", postedFrame);

    await tickN(5);
    expect(browser.sent).toEqual([]);

    resolveAuth("u-target");
    await tickN(5);

    expect(browser.sent.length).toBe(2);
    expect(JSON.parse(browser.sent[0] as string)).toMatchObject({
      event: "octogee_ack",
      data: { postId: "p1", channelId: "c1" },
    });
    expect(browser.sent[1]).toBe(postedFrame);
  });

  it("times out the ack-resolution wait and still forwards the frame (best-effort)", async () => {
    const browser = makeFakeWs(1);
    const upstream = makeFakeWs(0);

    const resolveMmUserId = vi.fn((token: string): Promise<string | null> => {
      if (token === "tok-first") return Promise.resolve(null);
      return new Promise<string | null>(() => undefined); // stuck forever
    });

    attachMmWsBridge(
      {
        mmInternalWsUrl: "ws://mm.internal/api/v4/websocket",
        log: vi.fn(),
        resolveMmUserId,
        openUpstream: () => upstream as unknown as WebSocket,
        ackResolutionTimeoutMs: 50,
        now: FIXED_NOW,
      },
      browser as unknown as WebSocket,
    );
    await authAndOpen(
      browser,
      upstream,
      JSON.stringify({ seq: 1, action: "authentication_challenge", data: { token: "tok-first" } }),
    );

    browser.emit(
      "message",
      JSON.stringify({ seq: 2, action: "authentication_challenge", data: { token: "tok-stuck" } }),
    );

    const postedFrame = JSON.stringify({
      event: "posted",
      data: { post: JSON.stringify({ id: "p2", user_id: "u-target", channel_id: "c2" }) },
    });
    upstream.emit("message", postedFrame);

    await tickN(10);
    await new Promise<void>((r) => setTimeout(r, 80));

    expect(browser.sent).toEqual([postedFrame]);
  });
});

interface OptWs extends EventEmitter {
  readyState: 0 | 1 | 2 | 3;
  frames: Array<{ data: unknown; binary: boolean | undefined }>;
  send: (data: unknown, opts?: { binary?: boolean }) => void;
  close: () => void;
}

function makeOptWs(state: 0 | 1 = 1): OptWs {
  const ee = new EventEmitter() as OptWs;
  ee.readyState = state;
  ee.frames = [];
  ee.send = (data: unknown, opts?: { binary?: boolean }) => {
    ee.frames.push({ data, binary: opts?.binary });
  };
  ee.close = () => {
    if (ee.readyState !== 3) {
      ee.readyState = 3;
      ee.emit("close");
    }
  };
  return ee;
}

async function authAndOpenOpt(browser: OptWs, upstream: OptWs, frame: Buffer | string) {
  browser.emit("message", frame, false);
  await tickN(5);
  upstream.readyState = 1;
  upstream.emit("open");
  await tickN(2);
}

const AUTH_BUFFER = Buffer.from(
  JSON.stringify({ seq: 1, action: "authentication_challenge", data: { token: "t" } }),
);

describe("attachMmWsBridge — frame opcode preservation (MM rejects pre-auth binary)", () => {
  it("forwards the browser TEXT auth frame (Buffer in, isBinary=false) to upstream as text", async () => {
    const browser = makeOptWs(1);
    const upstream = makeOptWs(0);
    attachMmWsBridge(
      {
        mmInternalWsUrl: "ws://mm.internal/api/v4/websocket",
        log: vi.fn(),
        resolveMmUserId: async () => "u1",
        openUpstream: () => upstream as unknown as WebSocket,
      },
      browser as unknown as WebSocket,
    );
    await authAndOpenOpt(browser, upstream, AUTH_BUFFER);

    expect(upstream.frames).toEqual([{ data: AUTH_BUFFER, binary: false }]);
  });

  it("preserves a genuinely binary browser frame as binary once admitted", async () => {
    const browser = makeOptWs(1);
    const upstream = makeOptWs(0);
    attachMmWsBridge(
      {
        mmInternalWsUrl: "ws://mm.internal/api/v4/websocket",
        log: vi.fn(),
        resolveMmUserId: async () => "u1",
        openUpstream: () => upstream as unknown as WebSocket,
      },
      browser as unknown as WebSocket,
    );
    await authAndOpenOpt(browser, upstream, AUTH_BUFFER);

    const bin = Buffer.from([0x01, 0x02, 0x03]);
    browser.emit("message", bin, true);

    expect(upstream.frames).toEqual([
      { data: AUTH_BUFFER, binary: false },
      { data: bin, binary: true },
    ]);
  });

  it("preserves opcode for frames buffered before upstream 'open' (auth_challenge race)", async () => {
    const browser = makeOptWs(1);
    const upstream = makeOptWs(0);
    attachMmWsBridge(
      {
        mmInternalWsUrl: "ws://mm.internal/api/v4/websocket",
        log: vi.fn(),
        resolveMmUserId: async () => "u1",
        openUpstream: () => upstream as unknown as WebSocket,
      },
      browser as unknown as WebSocket,
    );

    browser.emit("message", AUTH_BUFFER, false);
    await tickN(5);
    expect(upstream.frames).toEqual([]);

    upstream.readyState = 1;
    upstream.emit("open");

    expect(upstream.frames).toEqual([{ data: AUTH_BUFFER, binary: false }]);
  });

  it("forwards upstream→browser frames preserving the text opcode", async () => {
    const browser = makeOptWs(1);
    const upstream = makeOptWs(0);
    attachMmWsBridge(
      {
        mmInternalWsUrl: "ws://mm.internal/api/v4/websocket",
        log: vi.fn(),
        resolveMmUserId: async () => "u1",
        openUpstream: () => upstream as unknown as WebSocket,
      },
      browser as unknown as WebSocket,
    );
    await authAndOpenOpt(browser, upstream, AUTH_BUFFER);

    const evt = Buffer.from(JSON.stringify({ event: "hello", data: {} }));
    upstream.emit("message", evt, false);
    await tickN(3);

    expect(browser.frames).toEqual([{ data: evt, binary: false }]);
  });
});

describe("attachMmWsBridge — connection lifecycle logging", () => {
  // Auth token that resolves to NO user: the bridge still admits (MM enforces
  // auth itself) without the "authenticated" log line.
  const anonAuth = JSON.stringify({
    seq: 1,
    action: "authentication_challenge",
    data: { token: "tok-anon" },
  });

  it("logs upstream open", async () => {
    const browser = makeFakeWs(1);
    const upstream = makeFakeWs(0);
    const log = vi.fn();
    attachMmWsBridge(
      {
        mmInternalWsUrl: "ws://mm.internal/api/v4/websocket",
        log,
        resolveMmUserId: async () => "u1",
        openUpstream: () => upstream as unknown as WebSocket,
      },
      browser as unknown as WebSocket,
    );
    await authAndOpen(browser, upstream);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("upstream open"));
  });

  it("logs the resolved mmUserId exactly once (not per frame)", async () => {
    const browser = makeFakeWs(1);
    const upstream = makeFakeWs(0);
    const log = vi.fn();
    attachMmWsBridge(
      {
        mmInternalWsUrl: "ws://mm.internal/api/v4/websocket",
        log,
        resolveMmUserId: async () => "u-abc",
        openUpstream: () => upstream as unknown as WebSocket,
      },
      browser as unknown as WebSocket,
    );
    await authAndOpen(browser, upstream);
    browser.emit("message", JSON.stringify({ seq: 2, action: "get_statuses" }));
    browser.emit("message", JSON.stringify({ seq: 3, action: "get_statuses" }));
    await tickN(5);

    const authLines = log.mock.calls
      .map((c) => String(c[0]))
      .filter((m) => /authenticated mmUserId=u-abc/.test(m));
    expect(authLines).toHaveLength(1);
  });

  it("logs non-Error auth resolution rejections with the rejection reason", async () => {
    const browser = makeFakeWs(1);
    const upstream = makeFakeWs(0);
    const log = vi.fn();
    attachMmWsBridge(
      {
        mmInternalWsUrl: "ws://mm.internal/api/v4/websocket",
        log,
        resolveMmUserId: async () => {
          throw "token lookup failed";
        },
        openUpstream: () => upstream as unknown as WebSocket,
      },
      browser as unknown as WebSocket,
    );
    browser.emit("message", AUTH_FRAME);
    await tickN(5);

    expect(log).toHaveBeenCalledWith(
      "[mm-proxy/ws] resolveMmUserId rejected: token lookup failed",
    );
  });

  it("logs upstream close with code + reason + mmUserId=unknown when the token never resolved", async () => {
    const browser = makeFakeWs(1);
    const upstream = makeFakeWs(0);
    const log = vi.fn();
    attachMmWsBridge(
      {
        mmInternalWsUrl: "ws://mm.internal/api/v4/websocket",
        log,
        resolveMmUserId: async () => null,
        openUpstream: () => upstream as unknown as WebSocket,
      },
      browser as unknown as WebSocket,
    );
    await authAndOpen(browser, upstream, anonAuth);

    upstream.readyState = 3;
    upstream.emit("close", 1000, Buffer.from("UnauthBinary"));

    expect(log).toHaveBeenCalledWith(
      expect.stringContaining("upstream close code=1000 reason=UnauthBinary"),
    );
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining("mmUserId=unknown"),
    );
  });

  it("logs browser close with code + reason (even before any upstream exists)", () => {
    const browser = makeFakeWs(1);
    const upstream = makeFakeWs(0);
    const log = vi.fn();
    attachMmWsBridge(
      {
        mmInternalWsUrl: "ws://mm.internal/api/v4/websocket",
        log,
        resolveMmUserId: async () => "u1",
        openUpstream: () => upstream as unknown as WebSocket,
      },
      browser as unknown as WebSocket,
    );

    browser.readyState = 3;
    browser.emit("close", 1006, Buffer.from("abnormal"));

    expect(log).toHaveBeenCalledWith(
      expect.stringContaining("browser close code=1006 reason=abnormal"),
    );
  });

  it("attributes a close to the authenticated user once known", async () => {
    const browser = makeFakeWs(1);
    const upstream = makeFakeWs(0);
    const log = vi.fn();
    attachMmWsBridge(
      {
        mmInternalWsUrl: "ws://mm.internal/api/v4/websocket",
        log,
        resolveMmUserId: async () => "u-target",
        openUpstream: () => upstream as unknown as WebSocket,
      },
      browser as unknown as WebSocket,
    );
    await authAndOpen(browser, upstream);

    upstream.readyState = 3;
    upstream.emit("close", 1011, Buffer.from("x"));

    expect(log).toHaveBeenCalledWith(
      expect.stringContaining("upstream close code=1011 reason=x mmUserId=u-target"),
    );
  });

  it("does not log per forwarded frame (one line per lifecycle transition, not per message)", async () => {
    const browser = makeFakeWs(1);
    const upstream = makeFakeWs(0);
    const log = vi.fn();
    attachMmWsBridge(
      {
        mmInternalWsUrl: "ws://mm.internal/api/v4/websocket",
        log,
        resolveMmUserId: async () => null, // no "authenticated" line
        openUpstream: () => upstream as unknown as WebSocket,
      },
      browser as unknown as WebSocket,
    );
    await authAndOpen(browser, upstream, anonAuth);

    for (let i = 0; i < 5; i++) {
      browser.emit("message", JSON.stringify({ seq: i, action: "get_statuses" }));
      upstream.emit("message", JSON.stringify({ event: "typing", data: {} }));
    }
    await tickN(5);

    expect(log).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("upstream open"));
  });

  it("logs exactly one close line per teardown (induced other-side close is suppressed, not a phantom)", async () => {
    const browser = makeFakeWs(1);
    const upstream = makeFakeWs(0);
    const log = vi.fn();
    attachMmWsBridge(
      {
        mmInternalWsUrl: "ws://mm.internal/api/v4/websocket",
        log,
        resolveMmUserId: async () => null,
        openUpstream: () => upstream as unknown as WebSocket,
      },
      browser as unknown as WebSocket,
    );
    await authAndOpen(browser, upstream, anonAuth);

    upstream.readyState = 3;
    upstream.emit("close", 1000, Buffer.from("UnauthBinary"));

    const closeLines = log.mock.calls
      .map((c) => String(c[0]))
      .filter((m) => / close code=/.test(m));
    expect(closeLines).toHaveLength(1);
    expect(closeLines[0]).toContain(
      "upstream close code=1000 reason=UnauthBinary",
    );
  });
});

describe("maybeCaptureMmTokenForAuth", () => {
  it("resolves mmUserId for an authentication_challenge frame", async () => {
    const frame = JSON.stringify({
      seq: 1,
      action: "authentication_challenge",
      data: { token: "tok-xyz" },
    });
    const resolveMmUserId = async (token: string) =>
      token === "tok-xyz" ? "u1" : null;
    const userId = await maybeCaptureMmTokenForAuth(frame, resolveMmUserId);
    expect(userId).toBe("u1");
  });

  it("returns null for non-auth frames", async () => {
    const frame = JSON.stringify({
      seq: 2,
      action: "get_statuses",
    });
    const resolveMmUserId = async () => "should-not-be-called";
    const userId = await maybeCaptureMmTokenForAuth(frame, resolveMmUserId);
    expect(userId).toBeNull();
  });

  it("returns null when token is missing or empty", async () => {
    const frameNoToken = JSON.stringify({
      seq: 1,
      action: "authentication_challenge",
      data: {},
    });
    const resolveMmUserId = async () => "should-not-be-called";
    expect(await maybeCaptureMmTokenForAuth(frameNoToken, resolveMmUserId)).toBeNull();

    const frameEmptyToken = JSON.stringify({
      seq: 1,
      action: "authentication_challenge",
      data: { token: "" },
    });
    expect(await maybeCaptureMmTokenForAuth(frameEmptyToken, resolveMmUserId)).toBeNull();
  });
});

describe("MmWsRegistry — custom frame broadcast", () => {
  it("broadcasts a non-MM frame to every live browser bridge and stops after close", async () => {
    const { createMmWsRegistry } = await import("../mm-proxy/ws.js");
    const registry = createMmWsRegistry();
    const b1 = makeFakeWs(1);
    const b2 = makeFakeWs(1);
    const u1 = makeFakeWs(1);
    const u2 = makeFakeWs(1);
    const deps = (upstream: FakeWs) => ({
      mmInternalWsUrl: "ws://mm/api/v4/websocket",
      log: () => {},
      resolveMmUserId: async () => "u",
      openUpstream: () => upstream as unknown as WebSocket,
      registry,
    });
    attachMmWsBridge(deps(u1), b1 as unknown as WebSocket);
    attachMmWsBridge(deps(u2), b2 as unknown as WebSocket);

    const frame = { event: "system.notice", data: { channelId: "c1", message: "hello" } };
    registry.broadcast(frame);
    await tick();
    expect(b1.sent.map(String)).toContain(JSON.stringify(frame));
    expect(b2.sent.map(String)).toContain(JSON.stringify(frame));

    b1.close();
    b1.sent.length = 0;
    b2.sent.length = 0;
    registry.broadcast(frame);
    await tick();
    expect(b1.sent).toHaveLength(0);
    expect(b2.sent.map(String)).toContain(JSON.stringify(frame));
  });

  it("T8-1: scopes delivery to connections allowed by the predicate (membership)", async () => {
    const { createMmWsRegistry } = await import("../mm-proxy/ws.js");
    const registry = createMmWsRegistry();
    const sentByMember: string[] = [];
    const sentByNonMember: string[] = [];
    const sentByPreAuth: string[] = [];
    registry.add((f) => sentByMember.push(f), () => "u-member");
    registry.add((f) => sentByNonMember.push(f), () => "u-other");
    registry.add((f) => sentByPreAuth.push(f), () => null);

    const members = new Set(["u-member"]);
    const frame = { event: "system.notice", data: { channelId: "c1" } };
    registry.broadcast(frame, (uid) => uid !== null && members.has(uid));

    expect(sentByMember.map(String)).toContain(JSON.stringify(frame));
    expect(sentByNonMember).toHaveLength(0);
    expect(sentByPreAuth).toHaveLength(0);
  });

  it("Copilot#5: registry enforces fail-closed for null mmUserId even if the predicate is buggy", async () => {
    const { createMmWsRegistry } = await import("../mm-proxy/ws.js");
    const registry = createMmWsRegistry();
    const preAuth: string[] = [];
    registry.add((f) => preAuth.push(f), () => null);

    registry.broadcast({ event: "system.notice", data: { channelId: "c1" } }, () => true);
    expect(preAuth).toHaveLength(0);

    registry.broadcast({ event: "x" });
    expect(preAuth).toHaveLength(1);
  });
});
