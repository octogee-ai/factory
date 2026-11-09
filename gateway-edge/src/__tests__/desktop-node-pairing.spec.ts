import { describe, expect, it, vi } from "vitest";
import {
  approveDesktopNodePairing,
  desktopNodePairingRequests,
  DESKTOP_NODE_PAIRING_FAST_CHECKS,
  startDesktopNodePairing,
} from "../lib/desktop-node-pairing.js";

const desktopRequest = {
  requestId: "req-desktop",
  nodeId: "node-1",
  displayName: "octogee-desktop",
  remoteIp: "127.0.0.1",
  commands: ["computer.act", "screen.snapshot"],
};

describe("desktop node pairing", () => {
  it("selects only the loopback desktop node's pending requests", () => {
    const requests = desktopNodePairingRequests({
      pending: [
        desktopRequest,
        { ...desktopRequest, requestId: "req-v6", remoteIp: "::ffff:127.0.0.1" },
        { ...desktopRequest, requestId: "req-unreported", remoteIp: undefined },
        { ...desktopRequest, requestId: "req-remote", remoteIp: "10.0.0.9" },
        { ...desktopRequest, requestId: "req-other-name", displayName: "laptop" },
      ],
      paired: [],
    });
    expect(requests.map((request) => request.requestId)).toEqual(["req-desktop", "req-v6", "req-unreported"]);
    expect(requests[0].commands).toEqual(["computer.act", "screen.snapshot"]);
  });

  it("rejects a malformed pairing list instead of approving nothing silently", () => {
    expect(() => desktopNodePairingRequests({ paired: [] })).toThrow("pending");
    expect(() => desktopNodePairingRequests({ pending: [{ displayName: "octogee-desktop" }] })).toThrow("requestId");
  });

  it("approves each matching request through the gateway and reports what it approved", async () => {
    const invoke = vi.fn(async (method: string) => (method === "node.pair.list"
      ? { pending: [desktopRequest, { ...desktopRequest, requestId: "req-remote", remoteIp: "10.0.0.9" }] }
      : { ok: true }));
    const log = vi.fn();
    await expect(approveDesktopNodePairing({ invoke, log })).resolves.toEqual(["req-desktop"]);
    expect(invoke).toHaveBeenCalledWith("node.pair.approve", { requestId: "req-desktop" });
    expect(invoke).not.toHaveBeenCalledWith("node.pair.approve", { requestId: "req-remote" });
    expect(log).toHaveBeenCalledWith("desktop node pairing approved", expect.objectContaining({ requestId: "req-desktop" }));
  });

  it("keeps polling after a failed check and never overlaps checks", async () => {
    let resolveList: ((value: unknown) => void) | null = null;
    const invoke = vi.fn((method: string) => {
      if (method !== "node.pair.list") return Promise.resolve({ ok: true });
      return new Promise<unknown>((resolve) => {
        resolveList = resolve;
      });
    });
    const log = vi.fn();
    let scheduled: (() => void) | null = null;
    const stop = vi.fn();
    const cancel = startDesktopNodePairing({
      invoke,
      log,
      intervalMs: 1,
      schedule: (tick) => {
        scheduled = tick;
        return stop;
      },
    });
    expect(invoke).toHaveBeenCalledTimes(1);
    scheduled!();
    expect(invoke).toHaveBeenCalledTimes(1);
    resolveList!({ nope: true });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(log).toHaveBeenCalledWith("desktop node pairing check failed", expect.objectContaining({ error: expect.stringContaining("pending") }));
    scheduled!();
    expect(invoke).toHaveBeenCalledTimes(2);
    cancel();
    expect(stop).toHaveBeenCalled();
  });
  it("slows to the idle pace after the node is approved", async () => {
    const schedules: Array<{ ms: number; stopped: boolean }> = [];
    const invoke = vi.fn(async (method: string) => method === "node.pair.list" ? { pending: [desktopRequest], paired: [] } : {});
    const cancel = startDesktopNodePairing({
      invoke, log: vi.fn(), intervalMs: 5_000, idleIntervalMs: 60_000,
      schedule: (_tick, ms) => { const entry = { ms, stopped: false }; schedules.push(entry); return () => { entry.stopped = true; }; },
    });
    await vi.waitFor(() => expect(schedules.map(entry => entry.ms)).toEqual([5_000, 60_000]));
    expect(schedules[0].stopped).toBe(true);
    cancel();
    expect(schedules[1].stopped).toBe(true);
  });

  it("slows to the idle pace when no node ever asks", async () => {
    const schedules: number[] = [];
    let scheduled: () => void = () => {};
    const invoke = vi.fn(async () => ({ pending: [], paired: [] }));
    startDesktopNodePairing({
      invoke, log: vi.fn(), intervalMs: 5_000, idleIntervalMs: 60_000,
      schedule: (tick, ms) => { schedules.push(ms); scheduled = tick; return () => {}; },
    });
    for (let check = 1; check < DESKTOP_NODE_PAIRING_FAST_CHECKS; check += 1) {
      await new Promise(resolve => { setTimeout(resolve, 0); });
      scheduled();
    }
    await vi.waitFor(() => expect(schedules).toEqual([5_000, 60_000]));
  });

  it("reports a repeating check failure once", async () => {
    const log = vi.fn();
    let scheduled: () => void = () => {};
    startDesktopNodePairing({
      invoke: vi.fn(async () => { throw new Error("gateway starting"); }), log,
      schedule: (tick) => { scheduled = tick; return () => {}; },
    });
    await new Promise(resolve => { setTimeout(resolve, 0); });
    scheduled();
    await new Promise(resolve => { setTimeout(resolve, 0); });
    expect(log.mock.calls.filter(([line]) => line === "desktop node pairing check failed")).toHaveLength(1);
  });
});
