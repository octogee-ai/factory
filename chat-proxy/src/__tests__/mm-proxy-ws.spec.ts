import { describe, it, expect, vi } from "vitest";
import { EventEmitter } from "node:events";
import type { WebSocket } from "ws";
import {
  attachMmWsBridge,
  buildAckIfUserPost,
  maybeCaptureMmTokenForAuth,
} from "../mm-proxy/ws.js";

const FIXED_NOW = () => 1_700_000_000_000;

interface FakeWs extends EventEmitter {
  readyState: 0 | 1 | 2 | 3;
  sent: Array<string | Buffer>;
  send: (data: unknown) => void;
  close: () => void;
}

function makeFakeWs(initialState: 0 | 1 = 1): FakeWs {
  const ee = new EventEmitter() as FakeWs;
  ee.readyState = initialState;
  ee.sent = [];
  ee.send = (data: unknown) => {
    ee.sent.push(data as string | Buffer);
  };
  ee.close = () => {
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

describe("attachMmWsBridge — buffering + mmUserId race", () => {
  it("buffers browser→upstream frames until upstream emits 'open' (auth_challenge race)", async () => {
    const browser = makeFakeWs(1);
    const upstream = makeFakeWs(0); // not yet open
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

    const authFrame = JSON.stringify({
      seq: 1,
      action: "authentication_challenge",
      data: { token: "tok-xyz" },
    });
    browser.emit("message", authFrame);

    expect(upstream.sent).toEqual([]);

    upstream.readyState = 1;
    upstream.emit("open");

    expect(upstream.sent).toEqual([authFrame]);
  });

  it("forwards directly when upstream is already open", () => {
    const browser = makeFakeWs(1);
    const upstream = makeFakeWs(1);
    upstream.readyState = 1;

    attachMmWsBridge(
      {
        mmInternalWsUrl: "ws://mm.internal/api/v4/websocket",
        log: vi.fn(),
        resolveMmUserId: async () => "u1",
        openUpstream: () => upstream as unknown as WebSocket,
      },
      browser as unknown as WebSocket,
    );
    upstream.emit("open");

    const frame = JSON.stringify({ seq: 1, action: "get_statuses" });
    browser.emit("message", frame);

    expect(upstream.sent).toEqual([frame]);
  });

  it("awaits mmUserId resolution before deciding ack on inbound posted (no silent no-op)", async () => {
    const browser = makeFakeWs(1);
    const upstream = makeFakeWs(1);
    upstream.readyState = 1;

    let resolveAuth: (id: string | null) => void = (_id) => undefined;
    const slowResolveMmUserId = vi.fn(
      (_token: string): Promise<string | null> =>
        new Promise<string | null>((resolve) => {
          resolveAuth = resolve;
        }),
    );

    attachMmWsBridge(
      {
        mmInternalWsUrl: "ws://mm.internal/api/v4/websocket",
        log: vi.fn(),
        resolveMmUserId: slowResolveMmUserId,
        openUpstream: () => upstream as unknown as WebSocket,
        ackResolutionTimeoutMs: 1_000,
        now: FIXED_NOW,
      },
      browser as unknown as WebSocket,
    );
    upstream.emit("open");

    browser.emit(
      "message",
      JSON.stringify({
        seq: 1,
        action: "authentication_challenge",
        data: { token: "tok-xyz" },
      }),
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
    vi.useFakeTimers();
    try {
      const browser = makeFakeWs(1);
      const upstream = makeFakeWs(1);
      upstream.readyState = 1;

      attachMmWsBridge(
        {
          mmInternalWsUrl: "ws://mm.internal/api/v4/websocket",
          log: vi.fn(),
          resolveMmUserId: () => new Promise<string | null>(() => undefined),
          openUpstream: () => upstream as unknown as WebSocket,
          ackResolutionTimeoutMs: 50,
          now: FIXED_NOW,
        },
        browser as unknown as WebSocket,
      );
      upstream.emit("open");

      browser.emit(
        "message",
        JSON.stringify({
          seq: 1,
          action: "authentication_challenge",
          data: { token: "tok-stuck" },
        }),
      );

      const postedFrame = JSON.stringify({
        event: "posted",
        data: { post: JSON.stringify({ id: "p2", user_id: "u-target", channel_id: "c2" }) },
      });
      upstream.emit("message", postedFrame);

      vi.useRealTimers();
      await tickN(10);
      await new Promise<void>((r) => setTimeout(r, 80));

      expect(browser.sent).toEqual([postedFrame]);
    } finally {
      vi.useRealTimers();
    }
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

describe("attachMmWsBridge — frame opcode preservation (MM rejects pre-auth binary)", () => {
  it("forwards a browser TEXT frame (Buffer in, isBinary=false) to upstream as text", () => {
    const browser = makeOptWs(1);
    const upstream = makeOptWs(1);
    attachMmWsBridge(
      {
        mmInternalWsUrl: "ws://mm.internal/api/v4/websocket",
        log: vi.fn(),
        resolveMmUserId: async () => "u1",
        openUpstream: () => upstream as unknown as WebSocket,
      },
      browser as unknown as WebSocket,
    );
    upstream.emit("open");

    // `ws` v8 delivers the MM client's text auth_challenge as a Buffer
    // with isBinary=false. If we forward it without {binary:false} the
    // `ws` lib emits a binary frame and MM closes with UnauthBinary.
    const auth = Buffer.from(
      JSON.stringify({ seq: 1, action: "authentication_challenge", data: { token: "t" } }),
    );
    browser.emit("message", auth, false);

    expect(upstream.frames).toEqual([{ data: auth, binary: false }]);
  });

  it("preserves a genuinely binary browser frame as binary", () => {
    const browser = makeOptWs(1);
    const upstream = makeOptWs(1);
    attachMmWsBridge(
      {
        mmInternalWsUrl: "ws://mm.internal/api/v4/websocket",
        log: vi.fn(),
        resolveMmUserId: async () => "u1",
        openUpstream: () => upstream as unknown as WebSocket,
      },
      browser as unknown as WebSocket,
    );
    upstream.emit("open");

    const bin = Buffer.from([0x01, 0x02, 0x03]);
    browser.emit("message", bin, true);

    expect(upstream.frames).toEqual([{ data: bin, binary: true }]);
  });

  it("preserves opcode for frames buffered before upstream 'open' (auth_challenge race)", () => {
    const browser = makeOptWs(1);
    const upstream = makeOptWs(0); // not yet open → buffered
    attachMmWsBridge(
      {
        mmInternalWsUrl: "ws://mm.internal/api/v4/websocket",
        log: vi.fn(),
        resolveMmUserId: async () => "u1",
        openUpstream: () => upstream as unknown as WebSocket,
      },
      browser as unknown as WebSocket,
    );

    const auth = Buffer.from(
      JSON.stringify({ seq: 1, action: "authentication_challenge", data: { token: "t" } }),
    );
    browser.emit("message", auth, false);
    expect(upstream.frames).toEqual([]);

    upstream.readyState = 1;
    upstream.emit("open");

    expect(upstream.frames).toEqual([{ data: auth, binary: false }]);
  });

  it("forwards upstream→browser frames preserving the text opcode", async () => {
    const browser = makeOptWs(1);
    const upstream = makeOptWs(1);
    attachMmWsBridge(
      {
        mmInternalWsUrl: "ws://mm.internal/api/v4/websocket",
        log: vi.fn(),
        resolveMmUserId: async () => "u1",
        openUpstream: () => upstream as unknown as WebSocket,
      },
      browser as unknown as WebSocket,
    );
    upstream.emit("open");

    const evt = Buffer.from(JSON.stringify({ event: "hello", data: {} }));
    upstream.emit("message", evt, false);
    await tickN(3);

    expect(browser.frames).toEqual([{ data: evt, binary: false }]);
  });
});

describe("attachMmWsBridge — connection lifecycle logging", () => {
  const authFrame = JSON.stringify({
    seq: 1,
    action: "authentication_challenge",
    data: { token: "tok-xyz" },
  });

  it("logs upstream open", () => {
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
    upstream.readyState = 1;
    upstream.emit("open");
    expect(log).toHaveBeenCalledWith(expect.stringContaining("upstream open"));
  });

  it("logs the resolved mmUserId exactly once (not per frame)", async () => {
    const browser = makeFakeWs(1);
    const upstream = makeFakeWs(1);
    upstream.readyState = 1;
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
    upstream.emit("open");

    browser.emit("message", authFrame);
    await tickN(5);
    browser.emit("message", JSON.stringify({ seq: 2, action: "get_statuses" }));
    browser.emit("message", JSON.stringify({ seq: 3, action: "get_statuses" }));
    await tickN(5);

    const authLines = log.mock.calls
      .map((c) => String(c[0]))
      .filter((m) => /authenticated mmUserId=u-abc/.test(m));
    expect(authLines).toHaveLength(1);
  });

  it("logs upstream close with code + reason + mmUserId (the flap signal)", () => {
    const browser = makeFakeWs(1);
    const upstream = makeFakeWs(1);
    upstream.readyState = 1;
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
    upstream.emit("open");

    upstream.readyState = 3;
    upstream.emit("close", 1000, Buffer.from("UnauthBinary"));

    expect(log).toHaveBeenCalledWith(
      expect.stringContaining("upstream close code=1000 reason=UnauthBinary"),
    );
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining("mmUserId=unknown"),
    );
  });

  it("logs browser close with code + reason", () => {
    const browser = makeFakeWs(1);
    const upstream = makeFakeWs(1);
    upstream.readyState = 1;
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
    upstream.emit("open");

    browser.readyState = 3;
    browser.emit("close", 1006, Buffer.from("abnormal"));

    expect(log).toHaveBeenCalledWith(
      expect.stringContaining("browser close code=1006 reason=abnormal"),
    );
  });

  it("attributes a close to the authenticated user once known", async () => {
    const browser = makeFakeWs(1);
    const upstream = makeFakeWs(1);
    upstream.readyState = 1;
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
    upstream.emit("open");
    browser.emit("message", authFrame);
    await tickN(5);

    upstream.readyState = 3;
    upstream.emit("close", 1011, Buffer.from("x"));

    expect(log).toHaveBeenCalledWith(
      expect.stringContaining("upstream close code=1011 reason=x mmUserId=u-target"),
    );
  });

  it("does not log per forwarded frame (one line per lifecycle transition, not per message)", async () => {
    const browser = makeFakeWs(1);
    const upstream = makeFakeWs(1);
    upstream.readyState = 1;
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
    upstream.emit("open"); // 1 lifecycle line

    for (let i = 0; i < 5; i++) {
      browser.emit("message", JSON.stringify({ seq: i, action: "get_statuses" }));
      upstream.emit("message", JSON.stringify({ event: "typing", data: {} }));
    }
    await tickN(5);

    // Only the single "upstream open" lifecycle line — no per-frame spam.
    expect(log).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("upstream open"));
  });

  it("logs exactly one close line per teardown (induced other-side close is suppressed, not a phantom)", () => {
    const browser = makeFakeWs(1);
    const upstream = makeFakeWs(1);
    upstream.readyState = 1;
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
    upstream.emit("open");

    // MM drops the upstream; close() then tears down the browser side,
    // which fires an induced browser 'close' with no peer code/reason.
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

describe("MmWsRegistry — Phase 7.C ephemeral broadcast", () => {
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

    const frame = { event: "octogee.ctx", data: { channelId: "c1", pct: 13, used: 34900, limit: 272000 } };
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
});
