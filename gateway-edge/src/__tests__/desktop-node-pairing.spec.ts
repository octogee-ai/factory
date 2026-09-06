import { describe, expect, it, vi } from "vitest";
import {
  approveDesktopNodePairing,
  desktopNodePairingRequests,
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
        { ...desktopRequest, requestId: "req-remote", remoteIp: "10.0.0.9" },
        { ...desktopRequest, requestId: "req-other-name", displayName: "laptop" },
      ],
      paired: [],
    });
    expect(requests.map((request) => request.requestId)).toEqual(["req-desktop", "req-v6"]);
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
});
