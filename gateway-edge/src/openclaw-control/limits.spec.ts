import { describe, expect, it } from "vitest";

import {
  OPENCLAW_CONTROL_MAX_IN_FLIGHT,
  OpenClawControlResourceLimiter,
} from "./limits.js";

describe("OpenClaw Dashboard shared resource limits", () => {
  it("reserves desktop streams independently of the two RPC sockets and releases capacity", () => {
    const limiter = new OpenClawControlResourceLimiter();
    const identity = { uid: "uid-owner", gatewayId: "walter", sessionId: "session-1" };
    const rpc = [limiter.acquireSocket(identity), limiter.acquireSocket(identity)];
    expect(rpc.every(Boolean)).toBe(true);
    expect(limiter.acquireSocket(identity)).toBeNull();
    const streams = Array.from({ length: 8 }, () => limiter.acquireDesktopStream(identity));
    expect(streams.every(Boolean)).toBe(true);
    expect(limiter.acquireDesktopStream(identity)).toBeNull();
    rpc.forEach((lease) => lease?.release());
    expect(limiter.acquireDesktopStream(identity)).toBeNull();
    streams[0]?.release();
    expect(limiter.acquireDesktopStream(identity)).not.toBeNull();
    expect(limiter.acquireDesktopStream(identity)).toBeNull();
    expect(limiter.acquireSocket(identity)).not.toBeNull();
  });

  it.each(["uid", "gatewayId", "sessionId"] as const)("isolates desktop capacity by %s", (field) => {
    const limiter = new OpenClawControlResourceLimiter({ maxDesktopStreams: 1 });
    const identity = { uid: "uid-owner", gatewayId: "walter", sessionId: "session-1" };
    expect(limiter.acquireDesktopStream(identity)).not.toBeNull();
    expect(limiter.acquireDesktopStream({ ...identity })).toBeNull();
    expect(limiter.acquireDesktopStream({ ...identity, [field]: "other" })).not.toBeNull();
  });

  it("admits the current Dashboard startup burst", () => {
    expect(OPENCLAW_CONTROL_MAX_IN_FLIGHT).toBe(64);
    const limiter = new OpenClawControlResourceLimiter();
    const identity = { uid: "uid-owner", gatewayId: "walter", sessionId: "session-1" };
    const leases = Array.from({ length: OPENCLAW_CONTROL_MAX_IN_FLIGHT }, () =>
      limiter.acquireRequest(identity));

    expect(leases.every(Boolean)).toBe(true);
    expect(limiter.acquireRequest(identity)).toBeNull();
    leases.forEach((lease) => lease?.release());
  });

  it("shares socket, in-flight RPC, and mutation limits by uid, gateway, and session", () => {
    let now = 100;
    const limiter = new OpenClawControlResourceLimiter({
      maxSockets: 1,
      maxInFlight: 2,
      mutationLimit: 1,
      mutationWindowMs: 1_000,
      now: () => now,
    });
    const identity = { uid: "uid-owner", gatewayId: "walter", sessionId: "session-1" };
    const socket = limiter.acquireSocket(identity);
    expect(socket).not.toBeNull();
    expect(limiter.acquireSocket(identity)).toBeNull();

    const first = limiter.acquireRequest(identity);
    const second = limiter.acquireRequest(identity);
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(limiter.acquireRequest(identity)).toBeNull();
    first?.release();
    expect(limiter.acquireRequest(identity)).not.toBeNull();

    expect(limiter.consumeMutation(identity)).toBe(true);
    expect(limiter.consumeMutation(identity)).toBe(false);
    now = 1_100;
    expect(limiter.consumeMutation(identity)).toBe(true);
    socket?.release();
    expect(limiter.acquireSocket(identity)).not.toBeNull();
  });
});
