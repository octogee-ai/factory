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
