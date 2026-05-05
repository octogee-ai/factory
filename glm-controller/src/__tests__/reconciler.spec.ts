import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { startReconciler } from "../index";
import type { HelmInstancesMap } from "../../../shared/types/glm";

interface FakeSnapshot {
  docs: Array<{ data: () => unknown }>;
}

function makeFakeDb(args: {
  glmGateways: Array<Record<string, unknown>>;
  onSnapshot: { register: (cb: () => void) => void };
}) {
  return {
    collection: (name: string) => {
      if (name === "glmGateways") {
        return {
          get: async (): Promise<FakeSnapshot> => ({
            docs: args.glmGateways.map((d) => ({ data: () => d })),
          }),
          onSnapshot: (cb: () => void) => {
            args.onSnapshot.register(cb);
            return () => {};
          },
        };
      }
      if (name === "gateways") {
        return {
          get: async (): Promise<FakeSnapshot> => ({ docs: [] }),
        };
      }
      throw new Error(`unexpected collection: ${name}`);
    },
  } as unknown as Parameters<typeof startReconciler>[0]["db"];
}

function makeFakeHelm(behavior: {
  read?: () => Promise<HelmInstancesMap>;
  upsertInstance?: () => Promise<void>;
  removeInstance?: () => Promise<void>;
}) {
  return {
    readDeployedInstances: vi.fn(behavior.read ?? (async () => ({}))),
    upsertInstance: vi.fn(behavior.upsertInstance ?? (async () => undefined)),
    removeInstance: vi.fn(behavior.removeInstance ?? (async () => undefined)),
  } as unknown as Parameters<typeof startReconciler>[0]["helm"];
}

describe("startReconciler — periodic retry after failed tick", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  async function flush() {
    // Drain microtasks so awaited promises in tick() complete after timer
    // advancement. Two passes covers chained awaits without overshooting.
    await Promise.resolve();
    await Promise.resolve();
  }

  it("schedules a retry when a tick fails, then succeeds on the retry", async () => {
    const snapCbs: Array<() => void> = [];
    const log = vi.fn();
    const helm = makeFakeHelm({
      // First upsert rejects, second resolves.
      upsertInstance: vi
        .fn()
        .mockRejectedValueOnce(new Error("another operation in progress"))
        .mockResolvedValue(undefined) as unknown as () => Promise<void>,
    });
    const db = makeFakeDb({
      glmGateways: [
        {
          gatewayId: "gw-test",
          instanceName: "default",
          imageRepository: "repo",
          imageTag: "abc",
          desiredStatus: "running",
          createdBy: "ci",
        },
      ],
      onSnapshot: { register: (cb) => snapCbs.push(cb) },
    });

    const stop = startReconciler({
      db,
      helm,
      handlers: {} as Parameters<typeof startReconciler>[0]["handlers"],
      log,
      reconcileRetryMs: 5_000,
    });

    // Trigger first tick
    snapCbs[0]();
    await vi.advanceTimersByTimeAsync(1_000); // debounce
    await flush();
    await flush();

    expect(helm.upsertInstance).toHaveBeenCalledTimes(1);
    const failureLog = log.mock.calls.find(
      ([msg]: [string]) => typeof msg === "string" && msg.includes("retry in 5000ms"),
    );
    expect(failureLog).toBeDefined();

    // Advance the retry interval; the retry tick should run helm.upsertInstance again
    await vi.advanceTimersByTimeAsync(5_000);
    await flush();
    await flush();

    expect(helm.upsertInstance).toHaveBeenCalledTimes(2);
    stop();
  });

  it("does NOT schedule a retry when a tick succeeds", async () => {
    const snapCbs: Array<() => void> = [];
    const log = vi.fn();
    const helm = makeFakeHelm({
      upsertInstance: async () => undefined,
    });
    const db = makeFakeDb({
      glmGateways: [
        {
          gatewayId: "gw-test",
          instanceName: "default",
          imageRepository: "repo",
          imageTag: "abc",
          desiredStatus: "running",
          createdBy: "ci",
        },
      ],
      onSnapshot: { register: (cb) => snapCbs.push(cb) },
    });

    const stop = startReconciler({
      db,
      helm,
      handlers: {} as Parameters<typeof startReconciler>[0]["handlers"],
      log,
      reconcileRetryMs: 5_000,
    });

    snapCbs[0]();
    await vi.advanceTimersByTimeAsync(1_000);
    await flush();
    await flush();

    expect(helm.upsertInstance).toHaveBeenCalledTimes(1);

    // No retry should fire even after well past retryMs
    await vi.advanceTimersByTimeAsync(20_000);
    await flush();

    expect(helm.upsertInstance).toHaveBeenCalledTimes(1);
    stop();
  });

  it("does NOT schedule a retry after stop() has been called (no post-stop fires)", async () => {
    const snapCbs: Array<() => void> = [];
    const log = vi.fn();
    let resolveUpgrade: (v: unknown) => void = () => {};
    const helm = makeFakeHelm({
      upsertInstance: () =>
        new Promise<void>((_, reject) => {
          resolveUpgrade = (() => reject(new Error("boom"))) as typeof resolveUpgrade;
        }),
    });
    const db = makeFakeDb({
      glmGateways: [
        {
          gatewayId: "gw-test",
          instanceName: "default",
          imageRepository: "repo",
          imageTag: "abc",
          desiredStatus: "running",
          createdBy: "ci",
        },
      ],
      onSnapshot: { register: (cb) => snapCbs.push(cb) },
    });

    const stop = startReconciler({
      db,
      helm,
      handlers: {} as Parameters<typeof startReconciler>[0]["handlers"],
      log,
      reconcileRetryMs: 5_000,
    });

    snapCbs[0]();
    await vi.advanceTimersByTimeAsync(1_000);
    await flush();

    // Stop the reconciler while the helm.upsertInstance is still in-flight
    stop();
    // Now resolve the in-flight helm call with a rejection — the catch must
    // see `stopped` and skip scheduling a retry.
    resolveUpgrade(undefined);
    await flush();
    await flush();

    await vi.advanceTimersByTimeAsync(60_000);
    await flush();
    // Only the original failed call ran; no retry after stop()
    expect(helm.upsertInstance).toHaveBeenCalledTimes(1);
  });

  it("a fresh snapshot during a pending retry cancels the retry and runs a debounced tick", async () => {
    const snapCbs: Array<() => void> = [];
    const log = vi.fn();
    const upgradeCalls: number[] = [];
    let upgradeCounter = 0;
    const helm = makeFakeHelm({
      upsertInstance: vi
        .fn()
        .mockImplementationOnce(async () => {
          upgradeCounter++;
          upgradeCalls.push(upgradeCounter);
          throw new Error("boom");
        })
        .mockImplementation(async () => {
          upgradeCounter++;
          upgradeCalls.push(upgradeCounter);
        }) as unknown as () => Promise<void>,
    });
    const db = makeFakeDb({
      glmGateways: [
        {
          gatewayId: "gw-test",
          instanceName: "default",
          imageRepository: "repo",
          imageTag: "abc",
          desiredStatus: "running",
          createdBy: "ci",
        },
      ],
      onSnapshot: { register: (cb) => snapCbs.push(cb) },
    });

    const stop = startReconciler({
      db,
      helm,
      handlers: {} as Parameters<typeof startReconciler>[0]["handlers"],
      log,
      reconcileRetryMs: 60_000, // long retry — we'll preempt with a snapshot
    });

    snapCbs[0]();
    await vi.advanceTimersByTimeAsync(1_000);
    await flush();
    await flush();
    expect(helm.upsertInstance).toHaveBeenCalledTimes(1); // failed first tick

    // New snapshot fires — debounced tick should run before retry would
    snapCbs[0]();
    await vi.advanceTimersByTimeAsync(1_000);
    await flush();
    await flush();
    expect(helm.upsertInstance).toHaveBeenCalledTimes(2); // snapshot-triggered tick

    // Long after the original retryMs, no extra retry should have fired
    await vi.advanceTimersByTimeAsync(120_000);
    await flush();
    expect(helm.upsertInstance).toHaveBeenCalledTimes(2);
    stop();
  });
});
