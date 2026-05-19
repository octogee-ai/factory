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

  it("calls syncFleetIngress after applyChanges with the gatewayId+instanceName of every desired gateway", async () => {
    const snapCbs: Array<() => void> = [];
    const log = vi.fn();
    const helm = makeFakeHelm({
      upsertInstance: async () => undefined,
    });
    const syncFleetIngress = vi.fn(async () => {});
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
        {
          gatewayId: "gw-test-canary",
          instanceName: "canary",
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
      syncFleetIngress,
      reconcileRetryMs: 5_000,
    });

    snapCbs[0]();
    await vi.advanceTimersByTimeAsync(1_000);
    await flush();
    await flush();

    expect(syncFleetIngress).toHaveBeenCalledTimes(1);
    const arg = (syncFleetIngress.mock.calls[0] ?? [])[0] as
      | ReadonlyArray<{ gatewayId: string; instanceName: string }>
      | undefined;
    expect(arg).toBeDefined();
    expect(arg!.map((g) => g.gatewayId).sort()).toEqual(["gw-test", "gw-test-canary"]);
    expect(arg!.find((g) => g.gatewayId === "gw-test")?.instanceName).toBe("default");
    expect(arg!.find((g) => g.gatewayId === "gw-test-canary")?.instanceName).toBe("canary");
    stop();
  });

  it("calls syncFleetIngress even when there are no helm changes — keeps the Ingress in sync after Helm clobbers", async () => {
    const snapCbs: Array<() => void> = [];
    const log = vi.fn();
    const desired = {
      gatewayId: "gw-test",
      instanceName: "default",
      imageRepository: "repo",
      imageTag: "abc",
      desiredStatus: "running",
      createdBy: "ci",
    };
    const helm = makeFakeHelm({
      // already in sync — read returns the desired instance, so diffInstancesMap returns empty
      read: async () => ({
        default: {
          enabled: true,
          image: { repository: "repo", tag: "abc" },
          gatewayId: "gw-test",
        },
      }),
    });
    const syncFleetIngress = vi.fn(async () => {});
    const db = makeFakeDb({
      glmGateways: [desired],
      onSnapshot: { register: (cb) => snapCbs.push(cb) },
    });

    const stop = startReconciler({
      db,
      helm,
      handlers: {} as Parameters<typeof startReconciler>[0]["handlers"],
      log,
      syncFleetIngress,
      reconcileRetryMs: 5_000,
    });

    snapCbs[0]();
    await vi.advanceTimersByTimeAsync(1_000);
    await flush();
    await flush();

    expect(helm.upsertInstance).not.toHaveBeenCalled();
    expect(syncFleetIngress).toHaveBeenCalledTimes(1);
    stop();
  });

  it("schedules a retry when syncFleetIngress throws", async () => {
    const snapCbs: Array<() => void> = [];
    const log = vi.fn();
    const helm = makeFakeHelm({});
    const syncFleetIngress = vi
      .fn()
      .mockRejectedValueOnce(new Error("kubectl exec failed"))
      .mockResolvedValue(undefined);
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
      syncFleetIngress,
      reconcileRetryMs: 5_000,
    });

    snapCbs[0]();
    await vi.advanceTimersByTimeAsync(1_000);
    await flush();
    await flush();
    expect(syncFleetIngress).toHaveBeenCalledTimes(1);
    const failureLog = log.mock.calls.find(
      ([msg]: [string]) => typeof msg === "string" && msg.includes("retry in 5000ms"),
    );
    expect(failureLog).toBeDefined();

    await vi.advanceTimersByTimeAsync(5_000);
    await flush();
    await flush();
    expect(syncFleetIngress).toHaveBeenCalledTimes(2);
    stop();
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

describe("startReconciler — issue #997: a PROD platform release must not roll customer gateways", () => {
  // The test runner leaves K8S_NAMESPACE unset, so index.ts derives
  // NAMESPACE="octogee" → the PROD policy path. These pin the issue #997
  // acceptance: a glm-controller image bump (fresh chartFingerprint) on a
  // platform release leaves the existing customer gateway pod untouched,
  // while an explicit operator-driven imageTag change still rolls.
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  async function flush() {
    await Promise.resolve();
    await Promise.resolve();
  }

  it("does NOT upsert (roll) an existing customer gateway when only the baked-in chart fingerprint changed", async () => {
    const snapCbs: Array<() => void> = [];
    const log = vi.fn();
    const helm = makeFakeHelm({
      read: async () => ({
        default: {
          enabled: true,
          image: { repository: "repo", tag: "sha-prod" },
          gatewayId: "gw-prod",
          chartFingerprint: "fp-OLD",
        },
      }),
    });
    const db = makeFakeDb({
      glmGateways: [
        {
          gatewayId: "gw-prod",
          instanceName: "default",
          imageRepository: "repo",
          imageTag: "sha-prod",
          desiredStatus: "running",
          createdBy: "operator",
        },
      ],
      onSnapshot: { register: (cb) => snapCbs.push(cb) },
    });

    const stop = startReconciler({
      db,
      helm,
      handlers: {} as Parameters<typeof startReconciler>[0]["handlers"],
      log,
      // Fresh Cowboy image baked with a changed gateway chart.
      chartFingerprint: "fp-NEW",
    });

    snapCbs[0]();
    await vi.advanceTimersByTimeAsync(1_000);
    await flush();
    await flush();

    expect(helm.upsertInstance).not.toHaveBeenCalled();
    const noChange = log.mock.calls.find(
      ([msg]: [string]) => typeof msg === "string" && msg.includes("no changes"),
    );
    expect(noChange).toBeDefined();
    stop();
  });

  it("STILL upserts on a fresh PROD cluster — empty actual is a `create`, never gated by the chart-fingerprint policy", async () => {
    const snapCbs: Array<() => void> = [];
    const log = vi.fn();
    const helm = makeFakeHelm({
      read: async () => ({}), // fresh cluster: no deployed gateway releases
    });
    const db = makeFakeDb({
      glmGateways: [
        {
          gatewayId: "gw-prod",
          instanceName: "default",
          imageRepository: "repo",
          imageTag: "sha-prod",
          desiredStatus: "running",
          createdBy: "controller-default-bootstrap",
        },
      ],
      onSnapshot: { register: (cb) => snapCbs.push(cb) },
    });

    const stop = startReconciler({
      db,
      helm,
      handlers: {} as Parameters<typeof startReconciler>[0]["handlers"],
      log,
      chartFingerprint: "fp-NEW",
    });

    snapCbs[0]();
    await vi.advanceTimersByTimeAsync(1_000);
    await flush();
    await flush();

    expect(helm.upsertInstance).toHaveBeenCalledTimes(1);
    stop();
  });

  it("STILL upserts when the operator changes the desired imageTag (operator-driven PROD rollout via promote-gateway.ts)", async () => {
    const snapCbs: Array<() => void> = [];
    const log = vi.fn();
    const helm = makeFakeHelm({
      read: async () => ({
        default: {
          enabled: true,
          image: { repository: "repo", tag: "sha-OLD" },
          gatewayId: "gw-prod",
          chartFingerprint: "fp-OLD",
        },
      }),
    });
    const db = makeFakeDb({
      glmGateways: [
        {
          gatewayId: "gw-prod",
          instanceName: "default",
          imageRepository: "repo",
          imageTag: "sha-NEW",
          desiredStatus: "running",
          createdBy: "operator",
        },
      ],
      onSnapshot: { register: (cb) => snapCbs.push(cb) },
    });

    const stop = startReconciler({
      db,
      helm,
      handlers: {} as Parameters<typeof startReconciler>[0]["handlers"],
      log,
      chartFingerprint: "fp-NEW",
    });

    snapCbs[0]();
    await vi.advanceTimersByTimeAsync(1_000);
    await flush();
    await flush();

    expect(helm.upsertInstance).toHaveBeenCalledTimes(1);
    stop();
  });
});

describe("startReconciler — orphan vs drainee drift classification", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  async function flush() {
    await Promise.resolve();
    await Promise.resolve();
  }

  it("logs a 🧟 warn line when a helm release has no matching glmGateways doc (orphan)", async () => {
    const snapCbs: Array<() => void> = [];
    const log = vi.fn();
    const helm = makeFakeHelm({
      // helm reports octogee-gw-orphan deployed (e.g. retire-gateway short-
      // circuited; doc deleted but uninstall never ran). buildInstancesMap
      // would not include it (no doc). preserve-drift semantic keeps it in
      // target — but Cowboy should LOUDLY flag it as orphan, not silent.
      read: async () => ({
        orphan: {
          enabled: true,
          image: { repository: "repo", tag: "abc1234" },
          gatewayId: "gw-orphan",
        },
      }),
    });
    const db = makeFakeDb({
      glmGateways: [], // intentionally empty — no doc matches gw-orphan
      onSnapshot: { register: (cb) => snapCbs.push(cb) },
    });

    const stop = startReconciler({
      db,
      helm,
      handlers: {} as Parameters<typeof startReconciler>[0]["handlers"],
      log,
    });

    snapCbs[0]();
    await vi.advanceTimersByTimeAsync(1_000);
    await flush();
    await flush();

    const orphanWarn = log.mock.calls.find(
      ([msg]: [string]) =>
        typeof msg === "string" && msg.includes("⚠") && msg.includes("🧟"),
    );
    expect(orphanWarn).toBeDefined();
    expect(orphanWarn?.[0]).toContain("orphan");
    expect(orphanWarn?.[0]).toContain("gw-orphan");
    stop();
  });

  it("does NOT use the orphan glyph for retired-with-customers drainees (legitimate preserve-drift)", async () => {
    const snapCbs: Array<() => void> = [];
    const log = vi.fn();
    const helm = makeFakeHelm({
      read: async () => ({
        draining: {
          enabled: true,
          image: { repository: "repo", tag: "abc1234" },
          gatewayId: "gw-draining",
        },
      }),
    });
    // makeFakeDb's "gateways" mock returns []. To simulate mountedCustomers
    // without rewriting the helper, swap in a richer db that records customers.
    const db = {
      collection: (name: string) => {
        if (name === "glmGateways") {
          return {
            get: async () => ({
              docs: [
                {
                  data: () => ({
                    gatewayId: "gw-draining",
                    instanceName: "draining",
                    imageRepository: "repo",
                    imageTag: "abc1234",
                    desiredStatus: "retired",
                    createdBy: "ci",
                  }),
                },
              ],
            }),
            onSnapshot: (cb: () => void) => {
              snapCbs.push(cb);
              return () => {};
            },
          };
        }
        if (name === "gateways") {
          return {
            get: async () => ({
              docs: [
                {
                  id: "gw-draining",
                  data: () => ({ mountedCustomers: ["cust-1", "cust-2"] }),
                },
              ],
            }),
          };
        }
        throw new Error(`unexpected: ${name}`);
      },
    } as unknown as Parameters<typeof startReconciler>[0]["db"];

    const stop = startReconciler({
      db,
      helm,
      handlers: {} as Parameters<typeof startReconciler>[0]["handlers"],
      log,
    });

    snapCbs[0]();
    await vi.advanceTimersByTimeAsync(1_000);
    await flush();
    await flush();

    const orphanWarn = log.mock.calls.find(
      ([msg]: [string]) =>
        typeof msg === "string" && msg.includes("🧟"),
    );
    expect(orphanWarn).toBeUndefined();
    const drainNote = log.mock.calls.find(
      ([msg]: [string]) =>
        typeof msg === "string" && msg.includes("draining") && msg.includes("preserved"),
    );
    expect(drainNote).toBeDefined();
    stop();
  });
});
