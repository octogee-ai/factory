import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { startReconciler } from "../index";
import type { HelmInstancesMap } from "@octogee/shared/types/glm";

const TEST_GATEWAY_GSA = "octogee-gateway@octogee.iam.gserviceaccount.com";

interface FakeSnapshot {
  docs: Array<{ id?: string; data: () => unknown }>;
}

function setGatewayServiceAccountEnv(): () => void {
  const original = process.env.GATEWAY_SERVICE_ACCOUNT;
  process.env.GATEWAY_SERVICE_ACCOUNT = TEST_GATEWAY_GSA;
  return () => {
    if (original === undefined) {
      delete process.env.GATEWAY_SERVICE_ACCOUNT;
    } else {
      process.env.GATEWAY_SERVICE_ACCOUNT = original;
    }
  };
}

function makeFakeDb(args: {
  glmGateways: Array<Record<string, unknown>>;
  gatewayDocs?: Record<string, Record<string, unknown>>;
  glmOperations?: Record<string, Record<string, unknown>>;
  onSnapshot: { register: (cb: () => void) => void };
}) {
  const gatewayDocs = args.gatewayDocs ?? {};
  const glmOperations = args.glmOperations ?? {};
  function makeDocRef(store: Record<string, Record<string, unknown>>, id: string) {
    return {
      get: async () => ({
        exists: Object.prototype.hasOwnProperty.call(store, id),
        data: () => store[id],
      }),
      set: async (data: Record<string, unknown>, options?: { merge?: boolean }) => {
        store[id] = options?.merge ? { ...(store[id] ?? {}), ...data } : data;
      },
      update: async (data: Record<string, unknown>) => {
        store[id] = { ...(store[id] ?? {}), ...data };
      },
    };
  }
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
          get: async (): Promise<FakeSnapshot> => ({
            docs: Object.entries(gatewayDocs).map(([id, data]) => ({
              id,
              ref: makeDocRef(gatewayDocs, id),
              data: () => data,
            })),
          }),
          doc: (id: string) => makeDocRef(gatewayDocs, id),
        };
      }
      if (name === "glmOperations") {
        const collection = {
          where: (field: string, op: string, value: unknown) => {
            if (op !== "==") throw new Error(`unexpected where op: ${op}`);
            return {
              get: async (): Promise<FakeSnapshot> => ({
                docs: Object.entries(glmOperations)
                  .filter(([, data]) => data[field] === value)
                  .map(([id, data]) => ({
                    id,
                    ref: makeDocRef(glmOperations, id),
                    data: () => data,
                  })),
              }),
            };
          },
          doc: (id: string) => makeDocRef(glmOperations, id),
        };
        return collection;
      }
      throw new Error(`unexpected collection: ${name}`);
    },
    runTransaction: async <T,>(body: (txn: {
      get: (ref: { get: () => Promise<unknown> }) => Promise<unknown>;
      set: (
        ref: { set: (data: Record<string, unknown>, options?: { merge?: boolean }) => Promise<void> },
        data: Record<string, unknown>,
        options?: { merge?: boolean },
      ) => void;
      update: (
        ref: { update: (data: Record<string, unknown>) => Promise<void> },
        data: Record<string, unknown>,
      ) => void;
    }) => Promise<T>) => {
      const writes: Array<() => Promise<void>> = [];
      const result = await body({
        get: async (ref) => ref.get(),
        set: (ref, data, options) => {
          writes.push(() => ref.set(data, options));
        },
        update: (ref, data) => {
          writes.push(() => ref.update(data));
        },
      });
      await Promise.all(writes.map((write) => write()));
      return result;
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

await Promise.resolve();
    await Promise.resolve();
  }

  it("schedules a retry when a tick fails, then succeeds on the retry", async () => {
    const snapCbs: Array<() => void> = [];
    const log = vi.fn();
    const helm = makeFakeHelm({
      
      upsertInstance: vi
        .fn()
        .mockRejectedValueOnce(new Error("another operation in progress"))
        .mockResolvedValue(undefined) as unknown as () => Promise<void>,
    });
    const db = makeFakeDb({
      glmGateways: [
        {
          gatewayId: "default",
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
    const failureLog = log.mock.calls.find(
      ([msg]: [string]) => typeof msg === "string" && msg.includes("retry in 5000ms"),
    );
    expect(failureLog).toBeDefined();

await vi.advanceTimersByTimeAsync(5_000);
    await flush();
    await flush();

    expect(helm.upsertInstance).toHaveBeenCalledTimes(2);
    stop();
  });

  it("invokes reconcileImagePins with the prod/test env label (not the raw namespace) and the desired instances each tick", async () => {
    const snapCbs: Array<() => void> = [];
    const log = vi.fn();
    const helm = makeFakeHelm({ upsertInstance: async () => undefined });
    const pinSpy = vi.fn(async () => {});
    const db = makeFakeDb({
      glmGateways: [
        { gatewayId: "default", imageRepository: "repo", imageTag: "abc", desiredStatus: "running", createdBy: "ci" },
      ],
      onSnapshot: { register: (cb) => snapCbs.push(cb) },
    });
    const stop = startReconciler({
      db,
      helm,
      handlers: {} as Parameters<typeof startReconciler>[0]["handlers"],
      log,
      reconcileImagePins: pinSpy,
      reconcileRetryMs: 5_000,
    });
    snapCbs[0]();
    await vi.advanceTimersByTimeAsync(1_000);
    await flush();
    await flush();
    expect(pinSpy).toHaveBeenCalled();
    expect(pinSpy.mock.calls[0][0]).toBe("prod");
    expect(pinSpy.mock.calls[0][1]).toContainEqual(
      expect.objectContaining({ imageRepository: "repo", imageTag: "abc" }),
    );
    stop();
  });

  it("a throwing reconcileImagePins does not break the fleet reconcile", async () => {
    const snapCbs: Array<() => void> = [];
    const log = vi.fn();
    const helm = makeFakeHelm({ upsertInstance: async () => undefined });
    const db = makeFakeDb({
      glmGateways: [
        { gatewayId: "default", imageRepository: "repo", imageTag: "abc", desiredStatus: "running", createdBy: "ci" },
      ],
      onSnapshot: { register: (cb) => snapCbs.push(cb) },
    });
    const stop = startReconciler({
      db,
      helm,
      handlers: {} as Parameters<typeof startReconciler>[0]["handlers"],
      log,
      reconcileImagePins: vi.fn(async () => {
        throw new Error("boom");
      }),
      reconcileRetryMs: 5_000,
    });
    snapCbs[0]();
    await vi.advanceTimersByTimeAsync(1_000);
    await flush();
    await flush();
    expect(helm.upsertInstance).toHaveBeenCalled();
    expect(
      log.mock.calls.some(([m]: [string]) => typeof m === "string" && m.includes("image-pins")),
    ).toBe(true);
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
          gatewayId: "default",
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

await vi.advanceTimersByTimeAsync(20_000);
    await flush();

    expect(helm.upsertInstance).toHaveBeenCalledTimes(1);
    stop();
  });

  it("passes builderSlug from desired state through to helm upsert", async () => {
    const restoreGatewayServiceAccount = setGatewayServiceAccountEnv();
    const snapCbs: Array<() => void> = [];
    const log = vi.fn();
    const helm = makeFakeHelm({
      upsertInstance: async () => undefined,
    });
    const db = makeFakeDb({
      glmGateways: [
        {
          gatewayId: "eggman",
          imageRepository: "repo",
          imageTag: "abc",
          desiredStatus: "running",
          createdBy: "ci",
          gatewayClass: "operator",
          imageProfile: "operator",
          profile: "operator",
          builderSlug: "eggman",
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
      ensureGatewayWorkloadIdentity: vi.fn(async () => undefined),
    });

    snapCbs[0]();
    await vi.advanceTimersByTimeAsync(1_000);
    await flush();
    await flush();

    expect(helm.upsertInstance).toHaveBeenCalledWith(
      expect.objectContaining({ builderSlug: "eggman" }),
    );
    stop();
    restoreGatewayServiceAccount();
  });

  it("runs a follow-up tick when desired state changes during an in-flight reconcile", async () => {
    const snapCbs: Array<() => void> = [];
    const log = vi.fn();
    let resolveFirstUpgrade: () => void = () => {};
    const upsertInstance = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            resolveFirstUpgrade = resolve;
          }),
      )
      .mockResolvedValue(undefined);
    const desired = [
      {
        gatewayId: "default",
        imageRepository: "repo",
        imageTag: "abc",
        desiredStatus: "running",
        createdBy: "ci",
      },
    ];
    const helm = makeFakeHelm({
      upsertInstance: upsertInstance as unknown as () => Promise<void>,
    });
    const db = makeFakeDb({
      glmGateways: desired,
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

    desired[0] = { ...desired[0], imageTag: "def" };
    snapCbs[0]();
    await vi.advanceTimersByTimeAsync(1_000);
    await flush();
    await flush();
    expect(helm.upsertInstance).toHaveBeenCalledTimes(1);

    resolveFirstUpgrade();
    await flush();
    await flush();
    await vi.advanceTimersByTimeAsync(1_000);
    await flush();
    await flush();

    expect(helm.upsertInstance).toHaveBeenCalledTimes(2);
    expect(helm.upsertInstance).toHaveBeenLastCalledWith(
      expect.objectContaining({ imageTag: "def" }),
    );
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
          gatewayId: "default",
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

stop();

resolveUpgrade(undefined);
    await flush();
    await flush();

    await vi.advanceTimersByTimeAsync(60_000);
    await flush();
    
    expect(helm.upsertInstance).toHaveBeenCalledTimes(1);
  });

  it("calls syncFleetIngress after applyChanges with the gatewayId of every targeted gateway", async () => {
    const snapCbs: Array<() => void> = [];
    const log = vi.fn();
    const helm = makeFakeHelm({
      upsertInstance: async () => undefined,
    });
    const syncFleetIngress = vi.fn(async () => {});
    const db = makeFakeDb({
      glmGateways: [
        {
          gatewayId: "default",
          imageRepository: "repo",
          imageTag: "abc",
          desiredStatus: "running",
          createdBy: "ci",
        },
        {
          gatewayId: "canary",
          imageRepository: "repo",
          imageTag: "abc",
          desiredStatus: "running",
          createdBy: "ci",
        },
        {
          gatewayId: "retired-stale",
          imageRepository: "repo",
          imageTag: "abc",
          desiredStatus: "retired",
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
      | ReadonlyArray<{ gatewayId: string }>
      | undefined;
    expect(arg).toBeDefined();
    expect(arg!.map((g) => g.gatewayId).sort()).toEqual(["canary", "default"]);
    stop();
  });

  it("syncs the model-key source before mirroring the K8s model-key secret", async () => {
    const snapCbs: Array<() => void> = [];
    const log = vi.fn();
    const order: string[] = [];
    const helm = makeFakeHelm({
      upsertInstance: async () => undefined,
    });
    const modelKeySourceIssuer = {
      syncGatewayModelKeySource: vi.fn(async () => {
        order.push("source");
        return {
          gatewayId: "jack",
          secretName: "gateway-model-key-jack",
          changed: true,
          action: "issued" as const,
        };
      }),
    };
    const modelKeySecretEnsurer = {
      syncGatewayModelKeySecret: vi.fn(async () => {
        order.push("secret");
        return {
          gatewayId: "jack",
          secretName: "gateway-model-key-jack",
          changed: true,
          action: "upserted" as const,
        };
      }),
    };
    const restartGatewayDeployment = vi.fn(async () => {});
    const db = makeFakeDb({
      glmGateways: [
        {
          gatewayId: "jack",
          gatewayClass: "builder",
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
      modelKeySourceIssuer,
      modelKeySecretEnsurer,
      restartGatewayDeployment,
      log,
      reconcileRetryMs: 5_000,
    });

    snapCbs[0]();
    await vi.advanceTimersByTimeAsync(1_000);
    await flush();
    await flush();

    expect(order).toEqual(["source", "secret"]);
    expect(restartGatewayDeployment).not.toHaveBeenCalled();
    stop();
  });

  it("calls syncFleetIngress even when there are no helm changes — keeps the Ingress in sync after Helm clobbers", async () => {
    const snapCbs: Array<() => void> = [];
    const log = vi.fn();
    const desired = {
      gatewayId: "default",
      imageRepository: "repo",
      imageTag: "abc",
      desiredStatus: "running",
      createdBy: "ci",
    };
    const helm = makeFakeHelm({
      
      read: async () => ({
        default: {
          enabled: true,
          image: { repository: "repo", tag: "abc" },
          gatewayId: "default",
          replicas: 1,
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
          gatewayId: "default",
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
          gatewayId: "default",
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
    expect(helm.upsertInstance).toHaveBeenCalledTimes(1); 

snapCbs[0]();
    await vi.advanceTimersByTimeAsync(1_000);
    await flush();
    await flush();
    expect(helm.upsertInstance).toHaveBeenCalledTimes(2); 

await vi.advanceTimersByTimeAsync(120_000);
    await flush();
    expect(helm.upsertInstance).toHaveBeenCalledTimes(2);
    stop();
  });
});

describe("startReconciler — issue #997: a PROD platform release must not roll customer gateways", () => {

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
          gatewayId: "default",
          chartFingerprint: "fp-OLD",
          replicas: 1,
        },
      }),
    });
    const db = makeFakeDb({
      glmGateways: [
        {
          gatewayId: "default",
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
          gatewayId: "default",
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

  it("ensures generated operator KSA Workload Identity before helm upsert", async () => {
    const restoreGatewayServiceAccount = setGatewayServiceAccountEnv();
    const snapCbs: Array<() => void> = [];
    const log = vi.fn();
    const ensureGatewayWorkloadIdentity = vi.fn(async () => undefined);
    const helm = makeFakeHelm({
      upsertInstance: async () => undefined,
    });
    const db = makeFakeDb({
      glmGateways: [
        {
          gatewayId: "bender-green",
          imageRepository: "repo",
          imageTag: "abc",
          desiredStatus: "running",
          createdBy: "ci",
          profile: "operator",
          ownerUid: "uid-chris",
          serviceAccountName: "octogee-gw-bender-green",
          serviceAccount: { create: true },
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
      ensureGatewayWorkloadIdentity,
    });

    snapCbs[0]();
    await vi.advanceTimersByTimeAsync(1_000);
    await flush();
    await flush();

    expect(ensureGatewayWorkloadIdentity).toHaveBeenCalledWith({
      serviceAccountName: "octogee-gw-bender-green",
    });
    expect(helm.upsertInstance).toHaveBeenCalledTimes(1);
    expect(ensureGatewayWorkloadIdentity.mock.invocationCallOrder[0]).toBeLessThan(
      helm.upsertInstance.mock.invocationCallOrder[0],
    );
    stop();
    restoreGatewayServiceAccount();
  });

  it("STILL upserts when the operator changes the desired imageTag (operator-driven PROD rollout via promote-gateway.ts)", async () => {
    const snapCbs: Array<() => void> = [];
    const log = vi.fn();
    const helm = makeFakeHelm({
      read: async () => ({
        default: {
          enabled: true,
          image: { repository: "repo", tag: "sha-OLD" },
          gatewayId: "default",
          chartFingerprint: "fp-OLD",
        },
      }),
    });
    const db = makeFakeDb({
      glmGateways: [
        {
          gatewayId: "default",
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

read: async () => ({
        orphan: {
          enabled: true,
          image: { repository: "repo", tag: "abc1234" },
          gatewayId: "orphan",
        },
      }),
    });
    const db = makeFakeDb({
      glmGateways: [], // intentionally empty — no doc matches orphan
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
    expect(orphanWarn?.[0]).toContain("orphan");
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
          gatewayId: "draining",
        },
      }),
    });

const db = {
      collection: (name: string) => {
        if (name === "glmGateways") {
          return {
            get: async () => ({
              docs: [
                {
                  data: () => ({
                    gatewayId: "draining",
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
                  id: "draining",
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

function makeFakeKubeOps(behavior: {
  scale?: () => Promise<void>;
  restart?: () => Promise<void>;
  readReplicas?: () => Promise<number | null>;
  readAvailableReplicas?: () => Promise<number | null>;
} = {}) {
  return {
    scaleDeployment: vi.fn(behavior.scale ?? (async () => undefined)),
    restartOpenClawInPlace: vi.fn(behavior.restart ?? (async () => undefined)),
    readDeployedReplicas: vi.fn(behavior.readReplicas ?? (async () => null)),
    readAvailableReplicas: vi.fn(behavior.readAvailableReplicas ?? (async () => null)),
    deletePersistentVolumeClaim: vi.fn(async () => undefined),
  } as unknown as Parameters<typeof startReconciler>[0]["kubeOps"];
}

describe("startReconciler — kubectl scale shortcut for replicas-only diffs", () => {
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

  it("paused desired-state on a running release calls kubeOps.scaleDeployment(replicas=0), not helm.upsertInstance", async () => {
    const snapCbs: Array<() => void> = [];
    const helm = makeFakeHelm({
      read: async () => ({
        default: {
          enabled: true,
          image: { repository: "repo", tag: "abc" },
          gatewayId: "default",
          replicas: 1,
        },
      }),
    });
    const kubeOps = makeFakeKubeOps({
      readReplicas: async () => 1,
    });
    const db = makeFakeDb({
      glmGateways: [
        {
          gatewayId: "default",
          imageRepository: "repo",
          imageTag: "abc",
          desiredStatus: "paused",
          createdBy: "ci",
        },
      ],
      onSnapshot: { register: (cb) => snapCbs.push(cb) },
    });

    const stop = startReconciler({
      db,
      helm,
      kubeOps,
      handlers: {} as Parameters<typeof startReconciler>[0]["handlers"],
      log: vi.fn(),
      reconcileRetryMs: 5_000,
      ensureGatewayWorkloadIdentity: vi.fn(async () => undefined),
    });

    snapCbs[0]();
    await vi.advanceTimersByTimeAsync(1_000);
    await flush();
    await flush();

    expect(kubeOps!.scaleDeployment).toHaveBeenCalledTimes(1);
    expect(kubeOps!.scaleDeployment).toHaveBeenCalledWith({
      namespace: expect.any(String),
      name: "octogee-gateway-default",
      replicas: 0,
    });
    expect(helm.upsertInstance).not.toHaveBeenCalled();
    stop();
  });

  it("resume (paused → running) calls kubeOps.scaleDeployment(replicas=1), not helm.upsertInstance", async () => {
    const snapCbs: Array<() => void> = [];
    const helm = makeFakeHelm({
      read: async () => ({
        bender: {
          enabled: true,
          image: { repository: "repo", tag: "abc" },
          gatewayId: "bender",
          replicas: 0,
        },
      }),
    });
    const kubeOps = makeFakeKubeOps({
      readReplicas: async () => 0,
    });
    const db = makeFakeDb({
      glmGateways: [
        {
          gatewayId: "bender",
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
      kubeOps,
      handlers: {} as Parameters<typeof startReconciler>[0]["handlers"],
      log: vi.fn(),
      reconcileRetryMs: 5_000,
      ensureGatewayWorkloadIdentity: vi.fn(async () => undefined),
    });

    snapCbs[0]();
    await vi.advanceTimersByTimeAsync(1_000);
    await flush();
    await flush();

    expect(kubeOps!.scaleDeployment).toHaveBeenCalledWith({
      namespace: expect.any(String),
      name: "octogee-gateway-bender",
      replicas: 1,
    });
    expect(helm.upsertInstance).not.toHaveBeenCalled();
    stop();
  });

  it("chart-shape change (image tag + replicas flip) still goes through helm.upsertInstance, NOT kubectl scale", async () => {
    const snapCbs: Array<() => void> = [];
    const helm = makeFakeHelm({
      read: async () => ({
        default: {
          enabled: true,
          image: { repository: "repo", tag: "old-tag" },
          gatewayId: "default",
          replicas: 1,
        },
      }),
    });
    const kubeOps = makeFakeKubeOps({
      readReplicas: async () => 1,
    });
    const db = makeFakeDb({
      glmGateways: [
        {
          gatewayId: "default",
          imageRepository: "repo",
          imageTag: "new-tag",
          desiredStatus: "paused",
          createdBy: "ci",
        },
      ],
      onSnapshot: { register: (cb) => snapCbs.push(cb) },
    });

    const stop = startReconciler({
      db,
      helm,
      kubeOps,
      handlers: {} as Parameters<typeof startReconciler>[0]["handlers"],
      log: vi.fn(),
      reconcileRetryMs: 5_000,
      ensureGatewayWorkloadIdentity: vi.fn(async () => undefined),
    });

    snapCbs[0]();
    await vi.advanceTimersByTimeAsync(1_000);
    await flush();
    await flush();

    expect(helm.upsertInstance).toHaveBeenCalledTimes(1);
    expect(kubeOps!.scaleDeployment).not.toHaveBeenCalled();
    stop();
  });

  it("reads live replicas from kube to compute actual.replicas (helm-stored value is overridden)", async () => {
    const snapCbs: Array<() => void> = [];
    const helm = makeFakeHelm({
      read: async () => ({
        default: {
          enabled: true,
          image: { repository: "repo", tag: "abc" },
          gatewayId: "default",
          replicas: 1,
        },
      }),
    });
    const kubeOps = makeFakeKubeOps({
      readReplicas: async () => 0,
    });
    const db = makeFakeDb({
      glmGateways: [
        {
          gatewayId: "default",
          imageRepository: "repo",
          imageTag: "abc",
          desiredStatus: "paused",
          createdBy: "ci",
        },
      ],
      onSnapshot: { register: (cb) => snapCbs.push(cb) },
    });

    const stop = startReconciler({
      db,
      helm,
      kubeOps,
      handlers: {} as Parameters<typeof startReconciler>[0]["handlers"],
      log: vi.fn(),
      reconcileRetryMs: 5_000,
    });

    snapCbs[0]();
    await vi.advanceTimersByTimeAsync(1_000);
    await flush();
    await flush();

    expect(kubeOps!.readDeployedReplicas).toHaveBeenCalledWith({
      namespace: expect.any(String),
      name: "octogee-gateway-default",
    });
    expect(helm.upsertInstance).not.toHaveBeenCalled();
    expect(kubeOps!.scaleDeployment).not.toHaveBeenCalled();
    stop();
  });

  it("refreshes a platform-owned ready record for available operator gateways", async () => {
    const restoreGatewayServiceAccount = setGatewayServiceAccountEnv();
    const snapCbs: Array<() => void> = [];
    const gatewayDocs: Record<string, Record<string, unknown>> = {};
    const helm = makeFakeHelm({
      read: async () => ({
        "op-canary": {
          enabled: true,
          image: { repository: "repo", tag: "abc-oc2026.5.28" },
          gatewayId: "op-canary",
          profile: "operator",
          replicas: 1,
        },
      }),
    });
    const kubeOps = makeFakeKubeOps({
      readReplicas: async () => 1,
      readAvailableReplicas: async () => 1,
    });
    const db = makeFakeDb({
      glmGateways: [
        {
          gatewayId: "op-canary",
          imageRepository: "repo",
          imageTag: "abc-oc2026.5.28",
          profile: "operator",
          desiredStatus: "running",
          createdBy: "ci",
        },
      ],
      gatewayDocs,
      onSnapshot: { register: (cb) => snapCbs.push(cb) },
    });

    const stop = startReconciler({
      db,
      helm,
      kubeOps,
      handlers: {} as Parameters<typeof startReconciler>[0]["handlers"],
      log: vi.fn(),
      reconcileRetryMs: 5_000,
      ensureGatewayWorkloadIdentity: vi.fn(async () => undefined),
    });

    snapCbs[0]();
    await vi.advanceTimersByTimeAsync(1_000);
    await flush();
    await flush();

    expect(kubeOps!.readAvailableReplicas).toHaveBeenCalledWith({
      namespace: expect.any(String),
      name: "octogee-gateway-op-canary",
    });
    expect(gatewayDocs["op-canary"]).toMatchObject({
      gatewayId: "op-canary",
      status: "ready",
      version: "abc",
      mountedCustomers: [],
      internalUrl: expect.stringContaining("octogee-gateway-op-canary"),
    });
    expect(gatewayDocs["op-canary"]).not.toHaveProperty("lastHeartbeatAt");
    stop();
    restoreGatewayServiceAccount();
  });

  it("also refreshes the ready record (live SHA) for available STANDARD gateways", async () => {
    const snapCbs: Array<() => void> = [];
    const gatewayDocs: Record<string, Record<string, unknown>> = {};
    const helm = makeFakeHelm({
      read: async () => ({
        default: {
          enabled: true,
          image: { repository: "repo", tag: "abc-oc2026.5.28" },
          gatewayId: "default",
          profile: "standard",
          replicas: 1,
        },
      }),
    });
    const kubeOps = makeFakeKubeOps({
      readReplicas: async () => 1,
      readAvailableReplicas: async () => 1,
    });
    const db = makeFakeDb({
      glmGateways: [
        {
          gatewayId: "default",
          imageRepository: "repo",
          imageTag: "abc-oc2026.5.28",
          profile: "standard",
          desiredStatus: "running",
          createdBy: "ci",
        },
      ],
      gatewayDocs,
      onSnapshot: { register: (cb) => snapCbs.push(cb) },
    });

    const stop = startReconciler({
      db,
      helm,
      kubeOps,
      handlers: {} as Parameters<typeof startReconciler>[0]["handlers"],
      log: vi.fn(),
      reconcileRetryMs: 5_000,
    });

    snapCbs[0]();
    await vi.advanceTimersByTimeAsync(1_000);
    await flush();
    await flush();

    expect(kubeOps!.readAvailableReplicas).toHaveBeenCalledWith({
      namespace: expect.any(String),
      name: "octogee-gateway-default",
    });
    expect(gatewayDocs["default"]).toMatchObject({
      gatewayId: "default",
      status: "ready",
      version: "abc",
    });
    stop();
  });

  it("recovers a running operator add-gateway op once the reconciler sees the deployment ready", async () => {
    const restoreGatewayServiceAccount = setGatewayServiceAccountEnv();
    const snapCbs: Array<() => void> = [];
    const gatewayDocs: Record<string, Record<string, unknown>> = {};
    const glmOperations: Record<string, Record<string, unknown>> = {
      op1: {
        id: "op1",
        kind: "add-gateway",
        status: "running",
        createdBy: "ci",
        createdAt: 100,
        startedAt: 200,
        completedAt: null,
        input: {
          gatewayId: "op-canary",
          profile: "operator",
        },
        steps: [{ name: "helm-render", status: "running", startedAt: 200 }],
        error: "controller exited mid-install",
      },
    };
    const log = vi.fn();
    const syncFleetIngress = vi.fn(async () => undefined);
    const helm = makeFakeHelm({
      read: async () => ({
        "op-canary": {
          enabled: true,
          image: { repository: "repo", tag: "abc-oc2026.5.28" },
          gatewayId: "op-canary",
          profile: "operator",
          replicas: 1,
        },
      }),
    });
    const kubeOps = makeFakeKubeOps({
      readReplicas: async () => 1,
      readAvailableReplicas: async () => 1,
    });
    const db = makeFakeDb({
      glmGateways: [
        {
          gatewayId: "op-canary",
          imageRepository: "repo",
          imageTag: "abc-oc2026.5.28",
          profile: "operator",
          desiredStatus: "running",
          createdBy: "ci",
        },
      ],
      gatewayDocs,
      glmOperations,
      onSnapshot: { register: (cb) => snapCbs.push(cb) },
    });

    const stop = startReconciler({
      db,
      helm,
      kubeOps,
      syncFleetIngress,
      handlers: {} as Parameters<typeof startReconciler>[0]["handlers"],
      log,
      reconcileRetryMs: 5_000,
      ensureGatewayWorkloadIdentity: vi.fn(async () => undefined),
    });

    snapCbs[0]();
    await vi.advanceTimersByTimeAsync(1_000);
    await flush();
    await flush();

    expect(syncFleetIngress).toHaveBeenCalledTimes(1);
    expect(glmOperations.op1).toMatchObject({
      status: "succeeded",
      completedAt: expect.any(Number),
      rolledBack: false,
    });
    expect(glmOperations.op1.steps).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "helm-render", status: "done" }),
        expect.objectContaining({ name: "deployment-ready", status: "done" }),
        expect.objectContaining({ name: "platform-ready-record", status: "done" }),
        expect.objectContaining({ name: "fleet-ingress", status: "done" }),
        expect.objectContaining({ name: "reconciler-recovery", status: "done" }),
      ]),
    );
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining("recovered operator add-gateway from ready deployment"),
    );
    stop();
    restoreGatewayServiceAccount();
  });
});

describe("startReconciler — never in-place-roll a mounted gateway (the builder1 outage guard)", () => {
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

  it("REFUSES an in-place image upgrade when the gateway has mounted customers, and logs it loudly", async () => {
    const snapCbs: Array<() => void> = [];
    const log = vi.fn();
    const helm = makeFakeHelm({
      read: async () => ({
        default: {
          enabled: true,
          image: { repository: "repo", tag: "old-sha" },
          gatewayId: "default",
          replicas: 1,
        },
      }),
    });
    const db = makeFakeDb({
      glmGateways: [
        {
          gatewayId: "default",
          imageRepository: "repo",
          imageTag: "new-sha",
          desiredStatus: "running",
          createdBy: "ci",
        },
      ],
      gatewayDocs: { default: { mountedCustomers: ["cust-1", "cust-2"] } },
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

    expect(helm.upsertInstance).not.toHaveBeenCalled();
    const refused = log.mock.calls.find(
      ([msg]: [string]) =>
        typeof msg === "string" && msg.includes("REFUSED in-place image roll"),
    );
    expect(refused).toBeDefined();
    expect(refused?.[0]).toContain("default");
    expect(refused?.[0]).toContain("2 customer(s)");
    stop();
  });

  it("STILL upgrades in place when the SAME image change targets a gateway with NO mounted customers (fast path)", async () => {
    const snapCbs: Array<() => void> = [];
    const log = vi.fn();
    const helm = makeFakeHelm({
      read: async () => ({
        canary: {
          enabled: true,
          image: { repository: "repo", tag: "old-sha" },
          gatewayId: "canary",
          replicas: 1,
        },
      }),
    });
    const db = makeFakeDb({
      glmGateways: [
        {
          gatewayId: "canary",
          imageRepository: "repo",
          imageTag: "new-sha",
          desiredStatus: "running",
          createdBy: "ci",
        },
      ],
      gatewayDocs: { canary: { mountedCustomers: [] } },
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
    stop();
  });
});
