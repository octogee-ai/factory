import { describe, expect, it, vi } from "vitest";
import {
  createUnmountFromGateway,
  type UnmountFromGatewayDeps,
} from "../lib/customer-ops/unmount-gateway";

function connectionError(): TypeError {
  return new TypeError("fetch failed", { cause: { code: "ECONNREFUSED" } });
}

function mkDeps(overrides: Partial<UnmountFromGatewayDeps> = {}): UnmountFromGatewayDeps {
  return {
    resolveGatewayUnmountTarget: vi.fn(async (gatewayId: string) => ({
      gatewayId,
      revisionId: `${gatewayId}-r7`,
      profile: "standard" as const,
    })),
    readAvailableReplicas: vi.fn(async () => 1),
    unmountRpc: vi.fn(async () => undefined),
    wait: vi.fn(async () => undefined),
    now: vi.fn(() => 0),
    log: vi.fn(),
    ...overrides,
  };
}

describe("createUnmountFromGateway — durable runtime resolution", () => {
  it("throws when the gateway has no validated serving revision", async () => {
    const deps = mkDeps({ resolveGatewayUnmountTarget: vi.fn(async () => null) });
    const unmount = createUnmountFromGateway(deps);
    await expect(unmount("ghost-gw", "alice")).rejects.toThrow(
      /gateway ghost-gw has no validated serving revision/,
    );
    expect(deps.unmountRpc).not.toHaveBeenCalled();
  });
});

describe("createUnmountFromGateway — no live pod", () => {
  it("skips when the deployment has zero available replicas (scaled to zero)", async () => {
    const deps = mkDeps({ readAvailableReplicas: vi.fn(async () => 0) });
    const unmount = createUnmountFromGateway(deps);
    await expect(unmount("default", "alice")).resolves.toBe("skipped-no-live-pod");
    expect(deps.unmountRpc).not.toHaveBeenCalled();
  });

  it("skips when the deployment does not exist", async () => {
    const deps = mkDeps({ readAvailableReplicas: vi.fn(async () => null) });
    const unmount = createUnmountFromGateway(deps);
    await expect(unmount("default", "alice")).resolves.toBe("skipped-no-live-pod");
    expect(deps.unmountRpc).not.toHaveBeenCalled();
  });
});

describe("createUnmountFromGateway — live pod unmount", () => {
  it("calls the platform-signed unmount RPC for standard gateways", async () => {
    const deps = mkDeps();
    const unmount = createUnmountFromGateway(deps);
    await expect(unmount("default", "alice")).resolves.toBe("unmounted");
    expect(deps.unmountRpc).toHaveBeenCalledWith({
      gatewayId: "default",
      revisionId: "default-r7",
      slug: "alice",
    });
  });

  it("uses the same platform-signed unmount RPC for Builder gateways", async () => {
    const deps = mkDeps({
      resolveGatewayUnmountTarget: vi.fn(async () => ({
        gatewayId: "bender",
        revisionId: "bender-r7",
        profile: "builder" as const,
      })),
    });
    const unmount = createUnmountFromGateway(deps);
    await expect(unmount("bender", "theo")).resolves.toBe("unmounted");
    expect(deps.unmountRpc).toHaveBeenCalledWith({
      gatewayId: "bender",
      revisionId: "bender-r7",
      slug: "theo",
    });
  });
});

describe("createUnmountFromGateway — connection-error retry", () => {
  it("retries connection-level failures until the RPC succeeds", async () => {
    let calls = 0;
    const deps = mkDeps({
      unmountRpc: vi.fn(async () => {
        calls += 1;
        if (calls < 3) throw connectionError();
      }),
      retryIntervalMs: 50,
      retryDeadlineMs: 1_000,
    });
    let clock = 0;
    deps.now = vi.fn(() => clock);
    deps.wait = vi.fn(async (ms: number) => {
      clock += ms;
    });
    const unmount = createUnmountFromGateway(deps);
    await expect(unmount("default", "alice")).resolves.toBe("unmounted");
    expect(deps.unmountRpc).toHaveBeenCalledTimes(3);
    expect(deps.wait).toHaveBeenCalledTimes(2);
  });

  it("re-checks replicas between retries and skips if the pod went away", async () => {
    const replicaReads = [1, 0];
    const deps = mkDeps({
      readAvailableReplicas: vi.fn(async () => replicaReads.shift() ?? 0),
      unmountRpc: vi.fn(async () => {
        throw connectionError();
      }),
      retryIntervalMs: 50,
      retryDeadlineMs: 1_000,
    });
    let clock = 0;
    deps.now = vi.fn(() => clock);
    deps.wait = vi.fn(async (ms: number) => {
      clock += ms;
    });
    const unmount = createUnmountFromGateway(deps);
    await expect(unmount("default", "alice")).resolves.toBe("skipped-no-live-pod");
    expect(deps.unmountRpc).toHaveBeenCalledTimes(1);
  });

  it("gives up loudly when the deadline elapses with the pod still unreachable", async () => {
    const deps = mkDeps({
      unmountRpc: vi.fn(async () => {
        throw connectionError();
      }),
      retryIntervalMs: 100,
      retryDeadlineMs: 250,
    });
    let clock = 0;
    deps.now = vi.fn(() => clock);
    deps.wait = vi.fn(async (ms: number) => {
      clock += ms;
    });
    const unmount = createUnmountFromGateway(deps);
    await expect(unmount("default", "alice")).rejects.toThrow(
      /unmount unreachable after 3 attempts.*gatewayId=default revisionId=default-r7 slug=alice.*fetch failed \(ECONNREFUSED\)/,
    );
  });

  it("does not retry HTTP-level failures (the server was reached)", async () => {
    const deps = mkDeps({
      unmountRpc: vi.fn(async () => {
        throw new Error("unmount failed: 500 internal");
      }),
    });
    const unmount = createUnmountFromGateway(deps);
    await expect(unmount("default", "alice")).rejects.toThrow(/unmount failed: 500/);
    expect(deps.unmountRpc).toHaveBeenCalledTimes(1);
    expect(deps.wait).not.toHaveBeenCalled();
  });

  it("does not retry TypeErrors that are not undici connection failures", async () => {
    const deps = mkDeps({
      unmountRpc: vi.fn(async () => {
        throw new TypeError("Cannot read properties of undefined (reading 'x')");
      }),
    });
    const unmount = createUnmountFromGateway(deps);
    await expect(unmount("default", "alice")).rejects.toThrow(/Cannot read properties/);
    expect(deps.unmountRpc).toHaveBeenCalledTimes(1);
    expect(deps.wait).not.toHaveBeenCalled();
  });

  it("does not call the unmount RPC when a Builder gateway has no live pod", async () => {
    const deps = mkDeps({
      resolveGatewayUnmountTarget: vi.fn(async () => ({
        gatewayId: "bender",
        revisionId: "bender-r7",
        profile: "builder" as const,
      })),
      readAvailableReplicas: vi.fn(async () => 0),
    });
    const unmount = createUnmountFromGateway(deps);
    await expect(unmount("bender", "theo")).resolves.toBe("skipped-no-live-pod");
    expect(deps.unmountRpc).not.toHaveBeenCalled();
  });
});
