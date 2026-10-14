import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  readGatewayConvergenceInstances,
  processOperation,
  readTargetedDurableRuntimeGateways,
  runGatewayConvergencePass,
  serializeGatewayConvergence,
  snapshotHasReconcileRelevantChange,
  snapshotHasReconcileRelevantRootChange,
  startReconciler,
} from "../index";
import { FieldValue } from "firebase-admin/firestore";
import { acknowledgeCustomerRestore, beginCustomerRestore, type FleetStateDeps } from "@octogee/core/fleet-state";
import { FinalHomeCheckpointPendingError } from "../vm-computer-lifecycle";
import { runGatewayRuntimeExclusive } from "../lib/gateway-runtime-mutation";

function durableRoot(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    gatewayId: "default",
    createdAt: 1,
    createdBy: "test",
    updatedAt: 1,
    updatedBy: "test",
    latestRelease: 2,
    desiredRelease: 2,
    liveRelease: 2,
    desiredStatus: "running",
    configSchemaVersion: 1,
    profile: "standard",
    gatewayClass: "shared",
    imageProfile: "standard",
    sizingTier: "m",
    gcpProject: null,
    gatewayContainerSecurityContext: null,
    serviceAccountName: null,
    serviceAccount: null,
    builderAccess: null,
    ownerUid: null,
    builderSlug: null,
    modelBrokerLimits: null,
    preemption: null,
    coOwnerUids: [],
    ...overrides,
  };
}

function servingRuntime(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    docKind: "runtime",
    gatewayId: "default",
    release: 2,
    lifecycle: "serving",
    helm: { imageTag: "abc1234" },
    ...overrides,
  };
}

interface SnapshotCallbacks {
  glm?: (snapshot?: { docChanges?: () => SnapshotChange[] }) => void;
  roots?: (snapshot?: { docChanges?: () => SnapshotChange[] }) => void;
}

interface SnapshotChange {
  type: string;
  doc: { id: string; data(): Record<string, unknown> };
}

function makeDb(input: {
  roots?: Record<string, Record<string, unknown>>;
  runtimes?: Record<string, Record<string, unknown>>;
  releases?: Record<string, Record<number, Record<string, unknown>>>;
  callbacks: SnapshotCallbacks;
  users?: Record<string, Record<string, unknown>>;
  operations?: Record<string, Record<string, unknown>>;
  assignments?: Record<string, Record<string, unknown>>;
}) {
  const roots = input.roots ?? {};
  const runtimes = input.runtimes ?? {};
  const releases = input.releases ?? {};
  const users = input.users ?? {};
  const operations = input.operations ?? {};
  const assignments = input.assignments ?? {};
  const snapshot = (store: Record<string, Record<string, unknown>>) => ({
    size: Object.keys(store).length,
    docs: Object.entries(store).map(([id, data]) => ({ id, data: () => data })),
  });
  const document = (store: Record<string, Record<string, unknown>>, id: string): any => ({
    id,
    collection: (name: string) => {
      if (name !== "assignments") throw new Error(`unexpected subcollection ${name}`);
      return { doc: (uid: string) => document(assignments, `${id}/${uid}`) };
    },
    set: async (data: Record<string, unknown>, options?: { merge: boolean }) => {
      store[id] = options?.merge ? { ...store[id], ...data } : data;
    },
    delete: async () => { delete store[id]; },
    update: async (patch: Record<string, unknown>) => {
      for (const [key, value] of Object.entries(patch)) {
        const parts = key.split(".");
        let row: any = store[id];
        for (const part of parts.slice(0, -1)) row = row[part] ??= {};
        if (value instanceof FieldValue && value.isEqual(FieldValue.delete())) delete row[parts.at(-1)!];
        else row[parts.at(-1)!] = structuredClone(value);
      }
    },
    get: async () => ({
      exists: Object.prototype.hasOwnProperty.call(store, id),
      data: () => store[id],
    }),
  });
  return {
    runTransaction: async (body: (transaction: any) => Promise<unknown>) => {
      const writes: Array<() => Promise<void>> = [];
      const result = await body({
        get: (ref: any) => ref.get(),
        update: (ref: any, data: Record<string, unknown>) => writes.push(() => ref.update(data)),
      });
      for (const write of writes) await write();
      return result;
    },
    doc: (path: string) => {
      const match = /^gateways\/([^/]+)\/releases\/(\d+)$/u.exec(path);
      if (!match) throw new Error(`unexpected document ${path}`);
      const data = releases[match[1]]?.[Number(match[2])];
      return {
        get: async () => ({
          exists: data !== undefined,
          data: () => data,
        }),
      };
    },
    collection: (name: string) => {
      if (name === "glmOperations") return {
        doc: (id: string) => document(operations, id),
        where: (field: string, comparator: string, expected: unknown) => ({ get: async () => {
          if (comparator !== "==") throw new Error(`unexpected comparator ${comparator}`);
          return snapshot(Object.fromEntries(Object.entries(operations).filter(([, operation]) => operation[field] === expected)));
        } }),
      };
      if (name === "users") return {
        doc: (id: string) => document(users, id),
        where: (field: string, comparator: string, expected: unknown) => ({ get: async () => {
          if (comparator !== "==") throw new Error(`unexpected comparator ${comparator}`);
          return snapshot(Object.fromEntries(Object.entries(users).filter(([, user]) =>
            field.split(".").reduce((row: any, part) => row?.[part], user) === expected)));
        } }),
      };
      if (name === "gateways") {
        return {
          get: async () => snapshot(roots),
          doc: (id: string) => document(roots, id),
          onSnapshot: (callback: (snapshot?: { docChanges?: () => SnapshotChange[] }) => void) => {
            input.callbacks.roots = callback;
            return () => {};
          },
        };
      }
      if (name === "glmGateways") {
        return {
          get: async () => snapshot(runtimes),
          doc: (id: string) => document(runtimes, id),
          onSnapshot: (callback: (snapshot?: { docChanges?: () => SnapshotChange[] }) => void) => {
            input.callbacks.glm = callback;
            return () => {};
          },
        };
      }
      throw new Error(`unexpected collection ${name}`);
    },
  } as unknown as Parameters<typeof startReconciler>[0]["db"];
}

function releaseArtifact(
  gatewayId: string,
  release: number,
  imageTag: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    gatewayId,
    release,
    payload: {
      imageRepository: "us-central1-docker.pkg.dev/octogee/octogee/octogee-gateway",
      imageTag,
      gatewayEdgeImage: {
        imageRepository: "us-central1-docker.pkg.dev/octogee/octogee/gateway-edge",
        imageTag,
      },
      ...extra,
    },
  };
}

async function runTick(callbacks: SnapshotCallbacks): Promise<void> {
  callbacks.glm?.();
  callbacks.roots?.();
  await vi.advanceTimersByTimeAsync(1_000);
  await Promise.resolve();
  await Promise.resolve();
}

describe("snapshot reconciliation filters", () => {
  it("ignores heartbeat telemetry-only runtime doc changes", () => {
    const fingerprints = new Map<string, string>();
    snapshotHasReconcileRelevantChange(
      [{
        type: "added",
        doc: {
          id: "default",
          data: () => servingRuntime({
            heartbeat: {
              status: "ready",
              version: "abc1234",
              lastHeartbeatAt: 1,
              mountedCustomers: ["alice"],
            },
          }),
        },
      }],
      fingerprints,
    );

    expect(
      snapshotHasReconcileRelevantChange(
        [
          {
            type: "modified",
            doc: {
              id: "default",
              data: () => servingRuntime({
                heartbeat: {
                  status: "ready",
                  version: "abc1234",
                  lastHeartbeatAt: 2,
                  mountedCustomers: ["alice", "bob"],
                },
              }),
            },
          },
        ],
        fingerprints,
      ),
    ).toBe(false);
  });

  it("ignores pod-identity and loss-history changes on the runtime doc", () => {
    const fingerprints = new Map<string, string>();
    snapshotHasReconcileRelevantChange(
      [{
        type: "added",
        doc: {
          id: "default",
          data: () => servingRuntime({
            kubernetes: {
              status: "ready",
              totalPods: 1,
              readyPods: 1,
              observedAt: 1,
              pods: [{ uid: "uid-a", name: "pod-a", replicaSetUid: "rs-1", nodeName: "node-1", instanceId: "1", nodePool: "nap" }],
            },
          }),
        },
      }],
      fingerprints,
    );

    expect(
      snapshotHasReconcileRelevantChange(
        [{
          type: "modified",
          doc: {
            id: "default",
            data: () => servingRuntime({
              kubernetes: {
                status: "ready",
                totalPods: 1,
                readyPods: 1,
                observedAt: 2,
                pods: [{ uid: "uid-b", name: "pod-b", replicaSetUid: "rs-1", nodeName: "node-2", instanceId: "2", nodePool: "nap" }],
              },
              podReplacements: {
                recentAt: [2],
                lastAt: 2,
                lastVacatedPodUid: "uid-a",
                lastVacatedNodeName: "node-1",
                lastVacatedInstanceId: "1",
                lastVacatedNodePool: "nap",
                total: 1,
              },
            }),
          },
        }],
        fingerprints,
      ),
    ).toBe(false);
  });

  it("ignores Builder computer disk reports on the runtime doc", () => {
    const fingerprints = new Map<string, string>();
    const disk = (freeBytes: number, observedAt: number) => servingRuntime({
      runtime: "gce-vm",
      vmDisk: { sizeBytes: 100, freeBytes, instanceId: "4242", observedAt },
    });
    snapshotHasReconcileRelevantChange([{ type: "added", doc: { id: "default", data: () => disk(50, 1) } }], fingerprints);

    expect(
      snapshotHasReconcileRelevantChange([{ type: "modified", doc: { id: "default", data: () => disk(10, 2) } }], fingerprints),
    ).toBe(false);
  });

  it("ignores the Builder's computer egress routing choice", () => {
    const fingerprints = new Map<string, string>();
    const routed = (mode: "cloud" | "desktop", updatedAt: number) => servingRuntime({ runtime: "gce-vm", vmEgress: { mode, updatedAt } });
    snapshotHasReconcileRelevantChange([{ type: "added", doc: { id: "default", data: () => routed("cloud", 1) } }], fingerprints);
    expect(snapshotHasReconcileRelevantChange([{ type: "modified", doc: { id: "default", data: () => routed("desktop", 2) } }], fingerprints)).toBe(false);
  });

  it("ignores VM container image observations without hiding release changes", () => {
    const fingerprints = new Map<string, string>();
    const first = servingRuntime({ vmImages: { instanceId: "4242", observedAt: 1, containers: [] } });
    snapshotHasReconcileRelevantChange([{ type: "added", doc: { id: "default", data: () => first } }], fingerprints);
    const next = { ...first, vmImages: { instanceId: "4242", observedAt: 2, containers: [{ name: "gateway", running: false }] } };
    expect(snapshotHasReconcileRelevantChange([{ type: "modified", doc: { id: "default", data: () => next } }], fingerprints)).toBe(false);
    expect(snapshotHasReconcileRelevantChange([{ type: "modified", doc: { id: "default", data: () => ({ ...next, desiredRelease: 99 }) } }], fingerprints)).toBe(true);
  });

  it.each([
    ["status", { status: "unreachable", version: "abc1234" }],
    ["version", { status: "ready", version: "def5678" }],
  ])("schedules when heartbeat %s changes", (_field, heartbeat) => {
    const fingerprints = new Map<string, string>();
    snapshotHasReconcileRelevantChange(
      [{
        type: "added",
        doc: {
          id: "default",
          data: () => servingRuntime({
            heartbeat: { status: "ready", version: "abc1234", lastHeartbeatAt: 1 },
          }),
        },
      }],
      fingerprints,
    );

    expect(
      snapshotHasReconcileRelevantChange(
        [{
          type: "modified",
          doc: {
            id: "default",
            data: () => servingRuntime({ heartbeat: { ...heartbeat, lastHeartbeatAt: 2 } }),
          },
        }],
        fingerprints,
      ),
    ).toBe(true);
  });

  it("ignores Kubernetes observation freshness-only changes", () => {
    const fingerprints = new Map<string, string>();
    snapshotHasReconcileRelevantChange(
      [{
        type: "added",
        doc: {
          id: "default",
          data: () => servingRuntime({
            kubernetes: { status: "ready", totalPods: 1, readyPods: 1, observedAt: 1 },
          }),
        },
      }],
      fingerprints,
    );

    expect(
      snapshotHasReconcileRelevantChange(
        [{
          type: "modified",
          doc: {
            id: "default",
            data: () => servingRuntime({
              kubernetes: { status: "ready", totalPods: 1, readyPods: 1, observedAt: 2 },
            }),
          },
        }],
        fingerprints,
      ),
    ).toBe(false);
  });

  it("ignores converge-authored helm bookkeeping-only changes", () => {
    const fingerprints = new Map<string, string>();
    snapshotHasReconcileRelevantChange(
      [{
        type: "added",
        doc: {
          id: "default",
          data: () => servingRuntime({
            helm: { imageTag: "abc1234", lastAppliedAt: 1, availableReplicas: 1 },
          }),
        },
      }],
      fingerprints,
    );

    expect(
      snapshotHasReconcileRelevantChange(
        [{
          type: "modified",
          doc: {
            id: "default",
            data: () => servingRuntime({
              helm: { imageTag: "abc1234", lastAppliedAt: 2, availableReplicas: 0 },
            }),
          },
        }],
        fingerprints,
      ),
    ).toBe(false);
  });

  it("still reconciles when the applied helm image changes", () => {
    const fingerprints = new Map<string, string>();
    snapshotHasReconcileRelevantChange(
      [{
        type: "added",
        doc: {
          id: "default",
          data: () => servingRuntime({
            helm: { imageTag: "abc1234", lastAppliedAt: 1 },
          }),
        },
      }],
      fingerprints,
    );

    expect(
      snapshotHasReconcileRelevantChange(
        [{
          type: "modified",
          doc: {
            id: "default",
            data: () => servingRuntime({
              helm: { imageTag: "def5678", lastAppliedAt: 2 },
            }),
          },
        }],
        fingerprints,
      ),
    ).toBe(true);
  });

  it.each([
    ["status", { status: "not-ready", totalPods: 1, readyPods: 1 }],
    ["totalPods", { status: "ready", totalPods: 2, readyPods: 1 }],
    ["readyPods", { status: "ready", totalPods: 1, readyPods: 0 }],
  ])("schedules when Kubernetes %s changes", (_field, kubernetes) => {
    const fingerprints = new Map<string, string>();
    snapshotHasReconcileRelevantChange(
      [{
        type: "added",
        doc: {
          id: "default",
          data: () => servingRuntime({
            kubernetes: { status: "ready", totalPods: 1, readyPods: 1, observedAt: 1 },
          }),
        },
      }],
      fingerprints,
    );

    expect(
      snapshotHasReconcileRelevantChange(
        [{
          type: "modified",
          doc: {
            id: "default",
            data: () => servingRuntime({ kubernetes: { ...kubernetes, observedAt: 2 } }),
          },
        }],
        fingerprints,
      ),
    ).toBe(true);
  });

  it("schedules on a release-bearing runtime change", () => {
    const fingerprints = new Map<string, string>();
    snapshotHasReconcileRelevantChange(
      [{ type: "added", doc: { id: "default", data: () => servingRuntime() } }],
      fingerprints,
    );
    expect(
      snapshotHasReconcileRelevantChange(
        [
          {
            type: "modified",
            doc: { id: "default", data: () => servingRuntime({ release: 3 }) },
          },
        ],
        fingerprints,
      ),
    ).toBe(true);
  });
});

describe("root snapshot reconciliation filters", () => {
  it("ignores a gateway pod's reconcile-error report", () => {
    const fingerprints = new Map<string, string>();
    snapshotHasReconcileRelevantRootChange(
      [{ type: "added", doc: { id: "default", data: () => durableRoot() } }],
      fingerprints,
    );

    expect(
      snapshotHasReconcileRelevantRootChange(
        [{
          type: "modified",
          doc: {
            id: "default",
            data: () => durableRoot({
              lastError: { slug: "alice", message: "mount failed", at: 2 },
            }),
          },
        }],
        fingerprints,
      ),
    ).toBe(false);

    expect(
      snapshotHasReconcileRelevantRootChange(
        [{
          type: "modified",
          doc: {
            id: "default",
            data: () => durableRoot({
              lastError: { slug: "alice", message: "mount failed again", at: 3 },
            }),
          },
        }],
        fingerprints,
      ),
    ).toBe(false);

    expect(
      snapshotHasReconcileRelevantRootChange(
        [{
          type: "modified",
          doc: { id: "default", data: () => durableRoot({ lastError: null }) },
        }],
        fingerprints,
      ),
    ).toBe(false);
  });

  it.each([
    ["desiredRelease", { desiredRelease: 3 }],
    ["desiredStatus", { desiredStatus: "draining" }],
    ["liveRelease", { liveRelease: 1 }],
    ["updatedAt", { updatedAt: 2 }],
  ])("still reconciles when the root %s changes", (_field, overrides) => {
    const fingerprints = new Map<string, string>();
    snapshotHasReconcileRelevantRootChange(
      [{ type: "added", doc: { id: "default", data: () => durableRoot() } }],
      fingerprints,
    );

    expect(
      snapshotHasReconcileRelevantRootChange(
        [{
          type: "modified",
          doc: {
            id: "default",
            data: () => durableRoot({
              ...overrides,
              lastError: { slug: "alice", message: "mount failed", at: 2 },
            }),
          },
        }],
        fingerprints,
      ),
    ).toBe(true);
  });
});

describe("targeted durable state reads", () => {
  function targetedDb(input: {
    roots: Record<string, Record<string, unknown>>;
    runtimes: Record<string, Record<string, unknown>>;
  }) {
    const scanned: string[] = [];
    const fetched: string[] = [];
    const store = (name: string) => (name === "gateways" ? input.roots : input.runtimes);
    const db = {
      collection: (name: string) => ({
        get: async () => {
          scanned.push(name);
          return {
            docs: Object.entries(store(name)).map(([id, data]) => ({ id, data: () => data })),
          };
        },
        doc: (id: string) => ({ collection: name, id }),
      }),
      getAll: async (...refs: Array<{ collection: string; id: string }>) => {
        for (const ref of refs) fetched.push(`${ref.collection}/${ref.id}`);
        return refs.map((ref) => {
          const data = store(ref.collection)[ref.id];
          return { id: ref.id, exists: data !== undefined, data: () => data };
        });
      },
    };
    return { db, scanned, fetched };
  }

  it("reads only the selected roots and runtimes", async () => {
    const { db, scanned, fetched } = targetedDb({
      roots: { default: durableRoot(), other: durableRoot({ gatewayId: "other" }) },
      runtimes: {
        default: servingRuntime(),
        other: servingRuntime({ gatewayId: "other" }),
      },
    });

    const state = await readTargetedDurableRuntimeGateways(db as never, ["default"]);

    expect(scanned).toEqual([]);
    expect(fetched.sort()).toEqual(["gateways/default", "glmGateways/default"]);
    expect(state.gateways.map((gateway) => gateway.gatewayId)).toEqual(["default"]);
    expect(state.runtimeDocs.map((doc) => doc.gatewayId)).toEqual(["default"]);
    expect(state.invalidRootIds).toEqual([]);
    expect(state.strayGlmDocs).toEqual([]);
  });

  it("treats a fully removed gateway as absent, not invalid", async () => {
    const { db } = targetedDb({ roots: {}, runtimes: {} });

    await expect(readTargetedDurableRuntimeGateways(db as never, ["gone"])).resolves.toEqual({
      gateways: [],
      runtimeDocs: [],
      invalidRootIds: [],
      strayGlmDocs: [],
    });
  });

  it("still refuses a selected invalid root or stray runtime doc", async () => {
    const invalid = targetedDb({
      roots: { legacy: { gatewayId: "legacy", desiredStatus: "running" } },
      runtimes: {},
    });
    await expect(readTargetedDurableRuntimeGateways(invalid.db as never, ["legacy"]))
      .resolves.toMatchObject({ invalidRootIds: ["legacy"] });

    const stray = targetedDb({
      roots: {},
      runtimes: { orphan: servingRuntime({ gatewayId: "orphan" }) },
    });
    await expect(readTargetedDurableRuntimeGateways(stray.db as never, ["orphan"]))
      .resolves.toMatchObject({ strayGlmDocs: [{ id: "orphan", remedy: expect.stringContaining("delete glmGateways/orphan") }] });
  });

  it("does not scan either fleet collection for a targeted convergence pass", async () => {
    const { db, scanned } = targetedDb({ roots: {}, runtimes: {} });
    const passDeps = {
      db: db as never,
      helm: {
        readDeployedInstance: vi.fn(async () => null),
        readDeployedInstances: vi.fn(async () => ({})),
      } as never,
      kubeOps: {} as never,
      chartFingerprint: "chart",
      prepareGatewayConfig: vi.fn(async (config) => config),
      reconcileSurgeHandoff: vi.fn(async () => ({ ready: true })),
      log: vi.fn(),
    };

    await runGatewayConvergencePass(passDeps, ["ghost"]);
    expect(scanned).toEqual([]);

    await runGatewayConvergencePass(passDeps);
    expect(scanned).toEqual(["gateways", "glmGateways"]);
  });
});

describe("gateway convergence pass outcomes", () => {
  function retainedGateway(input: { desiredStatus?: string; gatewayClass?: string } = {}) {
    const gatewayId = "shared-1";
    const roots = { [gatewayId]: durableRoot({ gatewayId, ...input }) };
    const runtimes = { [gatewayId]: servingRuntime({ gatewayId, runtime: "cluster" }) };
    const users: Record<string, any> = { u: { username: "alice", provisioning: {
      status: "complete", openclaw: { gatewayId, status: "complete" },
    } } };
    const operations = { return: { kind: "migrate-customer", status: "running", startedAt: 100,
      input: { uid: "u", fromGatewayId: "builder-alice", toGatewayId: gatewayId }, cutoverCommittedAt: 50,
      schedulerHandoff: { uid: "u", slug: "alice", fromGatewayId: "builder-alice", toGatewayId: gatewayId } } };
    const db = makeDb({ roots, runtimes, users, operations, callbacks: {},
      releases: { [gatewayId]: { 2: releaseArtifact(gatewayId, 2, "abc1234") } },
      assignments: { [`${gatewayId}/u`]: { uid: "u", slug: "alice", gatewayId, epoch: 3, state: "serving" } },
    });
    const helm = {
      upsertInstance: vi.fn(async (_opts: Record<string, unknown>) => {}), removeInstance: vi.fn(async () => {}),
      readDeployedInstances: vi.fn(async () => ({ [gatewayId]: { gatewayId, enabled: true, release: 2,
        image: { repository: "us-central1-docker.pkg.dev/octogee/octogee/octogee-gateway", tag: "abc1234" },
        chartFingerprint: "chart", deploymentIntentFingerprint: "stale-intent", replicas: 1 } })),
    };
    const deps = { db, helm: helm as never, kubeOps: {} as never, chartFingerprint: "chart",
      prepareGatewayConfig: vi.fn(async (config: any) => config),
      reconcileSurgeHandoff: vi.fn(async () => ({ ready: true })), log: vi.fn() };
    const stateDeps: FleetStateDeps = { db, deleteField: () => FieldValue.delete(), serverTimestamp: () => FieldValue.serverTimestamp() };
    return { roots, runtimes, users, operations, deps, helm, stateDeps };
  }

  it("keeps a rejected storage preflight from poisoning later fleet reconciliation", async () => {
    const roots = {
      blocked: durableRoot({ gatewayId: "blocked", gatewayClass: "builder", profile: null, imageProfile: "builder", sizingTier: "s", ownerUid: "u", builderSlug: "alice", liveRelease: null }),
      healthy: durableRoot({ gatewayId: "healthy", liveRelease: null }),
    };
    const runtimes: Record<string, Record<string, unknown>> = {};
    const db = makeDb({ roots, runtimes, callbacks: {},
      users: { u: { provisioning: { computer: { id: "retained-computer" } } } },
      releases: Object.fromEntries(Object.keys(roots).map(id => [id, { 2: releaseArtifact(id, 2, "abc1234", { profileImages: { builder: { imageRepository: "us-central1-docker.pkg.dev/octogee/octogee/octogee-gateway-builder", imageTag: `abc1234@sha256:${"b".repeat(64)}` } } }) }])),
    });
    const helm = { upsertInstance: vi.fn(async () => {}), readDeployedInstances: vi.fn(async () => ({})) };
    const deps = { db, helm: helm as never, kubeOps: {} as never, chartFingerprint: "chart",
      prepareGatewayConfig: vi.fn(async (config: any) => config),
      reconcileSurgeHandoff: vi.fn(async () => ({ ready: true })), log: vi.fn() };

    for (let attempt = 0; attempt < 2; attempt += 1) {
      helm.upsertInstance.mockClear();
      await expect(runGatewayConvergencePass(deps)).rejects.toThrow("Retained GCE computer state requires an explicit storage migration");
      expect(runtimes.blocked).toBeUndefined();
      expect(helm.upsertInstance).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ gatewayId: "healthy" }));
    }
  });

  it("holds same-release stale Helm intent until native restore acknowledges customer custody", async () => {
    const h = retainedGateway();
    const intent = await beginCustomerRestore(h.stateDeps, { uid: "u", slug: "alice", gatewayId: "shared-1",
      fromGatewayId: "builder-alice", assignmentEpoch: 3, operationId: "return", claimStartedAt: 100, attemptId: "native" });
    const before = structuredClone(h.runtimes);
    await expect(runGatewayConvergencePass(h.deps)).rejects.toThrow("outcome is unresolved");
    expect(h.helm.upsertInstance).not.toHaveBeenCalled();
    expect(h.runtimes).toEqual(before);
    expect(h.users.u.provisioning.openclaw.restoreFence).toMatchObject({ phase: "dispatched", attemptId: "native" });
    await acknowledgeCustomerRestore(h.stateDeps, intent);
    await runGatewayConvergencePass(h.deps);
    expect(h.users.u.provisioning.openclaw.restoreFence).toBeUndefined();
    expect(h.operations.return).toMatchObject({ restoreAttempt: { phase: "acknowledged" } });
    expect(h.helm.upsertInstance).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ gatewayId: "shared-1", imageTag: "abc1234", replicas: 1 }));
  });

  it("keeps native handoff progress available while customer restore custody remains", async () => {
    const h = retainedGateway();
    await runGatewayConvergencePass(h.deps);
    const applied = h.helm.upsertInstance.mock.calls[0][0];
    const instances = await h.helm.readDeployedInstances();
    instances["shared-1"].deploymentIntentFingerprint = String(applied.deploymentIntentFingerprint);
    h.helm.readDeployedInstances.mockResolvedValue(instances);
    h.helm.upsertInstance.mockClear();
    h.users.u.provisioning.openclaw.restoreFence = { phase: "dispatched" };
    await runGatewayConvergencePass(h.deps);
    expect(h.deps.reconcileSurgeHandoff).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ gatewayId: "shared-1" }));
    expect(h.helm.upsertInstance).not.toHaveBeenCalled();
    expect(h.helm.removeInstance).not.toHaveBeenCalled();
    expect(h.users.u.provisioning.openclaw.restoreFence).toEqual({ phase: "dispatched" });
  });

  it.each(["running", "retired"])("orders native restore admission after in-flight Helm work for %s gateways", async desiredStatus => {
    const h = retainedGateway({ desiredStatus });
    const events: string[] = [];
    let releaseHelm!: () => void;
    let helmEntered!: () => void;
    const held = new Promise<void>(resolve => { releaseHelm = resolve; });
    const entered = new Promise<void>(resolve => { helmEntered = resolve; });
    const mutate = async () => {
      events.push("helm-start");
      helmEntered();
      await held;
      expect(h.users.u.provisioning.openclaw.restoreFence).toBeUndefined();
      events.push("helm-end");
    };
    h.helm.upsertInstance.mockImplementation(mutate);
    h.helm.removeInstance.mockImplementation(mutate);
    const converge = serializeGatewayConvergence(() => runGatewayConvergencePass(h.deps));
    const applying = converge();
    await entered;
    const restoring = runGatewayRuntimeExclusive(() => {
      events.push("restore-begin");
      return beginCustomerRestore(h.stateDeps, { uid: "u", slug: "alice", gatewayId: "shared-1",
        fromGatewayId: "builder-alice", assignmentEpoch: 3, operationId: "return", claimStartedAt: 100, attemptId: "native" });
    });
    await Promise.resolve();
    expect(h.users.u.provisioning.openclaw.restoreFence).toBeUndefined();
    releaseHelm();
    await applying;
    const intent = await restoring;
    expect(events).toEqual(["helm-start", "helm-end", "restore-begin"]);
    expect(desiredStatus === "retired" ? h.helm.removeInstance : h.helm.upsertInstance).toHaveBeenCalledOnce();
    expect(h.users.u.provisioning.openclaw.restoreFence).toMatchObject({ attemptId: "native", phase: "dispatched" });
    await acknowledgeCustomerRestore(h.stateDeps, intent);
    expect(h.users.u.provisioning.openclaw.restoreFence).toBeUndefined();
  });

  it("keeps acquired customer custody after the queue releases until native acknowledgement", async () => {
    const h = retainedGateway();
    const converge = serializeGatewayConvergence(() => runGatewayConvergencePass(h.deps));
    const restoring = runGatewayRuntimeExclusive(() => beginCustomerRestore(h.stateDeps, { uid: "u", slug: "alice", gatewayId: "shared-1",
      fromGatewayId: "builder-alice", assignmentEpoch: 3, operationId: "return", claimStartedAt: 100, attemptId: "native" }));
    const applying = converge();
    const intent = await restoring;
    await expect(applying).rejects.toThrow("outcome is unresolved");
    expect(h.helm.upsertInstance).not.toHaveBeenCalled();
    await expect(acknowledgeCustomerRestore(h.stateDeps, { ...intent, attemptId: "wrong" })).rejects.toThrow();
    await expect(converge()).rejects.toThrow("outcome is unresolved");
    await acknowledgeCustomerRestore(h.stateDeps, intent);
    await converge();
    expect(h.helm.upsertInstance).toHaveBeenCalledOnce();
  });

  it("orders the real operation handler's native restore admission behind Helm and releases before restore work", async () => {
    const h = retainedGateway();
    Object.assign(h.operations.return, { id: "return", status: "pending", startedAt: null, createdAt: 1, steps: [] });
    const events: string[] = [];
    let releaseHelm!: () => void;
    let helmEntered!: () => void;
    let handlerEntered!: () => void;
    const held = new Promise<void>(resolve => { releaseHelm = resolve; });
    const entered = new Promise<void>(resolve => { helmEntered = resolve; });
    const handling = new Promise<void>(resolve => { handlerEntered = resolve; });
    h.helm.upsertInstance.mockImplementation(async () => {
      events.push("helm-start");
      helmEntered();
      await held;
      events.push("helm-end");
    });
    const converge = serializeGatewayConvergence(() => runGatewayConvergencePass(h.deps));
    const applying = converge();
    await entered;
    const handler = vi.fn(async (_op, ctx) => {
      handlerEntered();
      await ctx.withCustomerRestoreFence({ uid: "u", slug: "alice", gatewayId: "shared-1",
        fromGatewayId: "builder-alice", assignmentEpoch: 3 }, async () => {
        events.push("restore-work");
        expect(h.users.u.provisioning.openclaw.restoreFence).toMatchObject({ phase: "dispatched" });
        await runGatewayRuntimeExclusive(async () => undefined);
      });
      return { success: true, steps: [] };
    });
    const operation = processOperation(h.operations.return as never, h.deps.db.collection("glmOperations").doc("return"),
      { ...h.deps, handlers: { "migrate-customer": handler } } as never);
    await handling;
    await new Promise<void>(resolve => setImmediate(resolve));
    releaseHelm();
    await Promise.all([applying, operation]);
    expect(events).toEqual(["helm-start", "helm-end", "restore-work"]);
    expect(h.operations.return).toMatchObject({ status: "succeeded", restoreAttempt: { phase: "acknowledged" } });
    expect(h.users.u.provisioning.openclaw.restoreFence).toBeUndefined();
  });

  it("releases the queue after Helm failure so a native restore can acquire its own custody", async () => {
    const h = retainedGateway();
    h.helm.upsertInstance.mockRejectedValue(new Error("Helm failed"));
    const converge = serializeGatewayConvergence(() => runGatewayConvergencePass(h.deps));
    const applying = converge();
    const restoring = runGatewayRuntimeExclusive(() => beginCustomerRestore(h.stateDeps, { uid: "u", slug: "alice", gatewayId: "shared-1",
      fromGatewayId: "builder-alice", assignmentEpoch: 3, operationId: "return", claimStartedAt: 100, attemptId: "native" }));
    await expect(applying).rejects.toThrow("Helm failed");
    const intent = await restoring;
    expect(h.users.u.provisioning.openclaw.restoreFence).toMatchObject({ attemptId: "native" });
    await acknowledgeCustomerRestore(h.stateDeps, intent);
  });

  it("rechecks customer custody immediately before applying Helm", async () => {
    const h = retainedGateway();
    h.deps.log.mockImplementation((message: string) => {
      if (message.startsWith("[converge-gateway]")) h.users.u.provisioning.openclaw.restoreFence = {};
    });
    await expect(runGatewayConvergencePass(h.deps)).rejects.toThrow("outcome is unresolved");
    expect(h.helm.upsertInstance).not.toHaveBeenCalled();
  });

  it("does not block a gateway for unrelated customer custody", async () => {
    const h = retainedGateway();
    h.users.u.provisioning.openclaw = { gatewayId: "elsewhere", restoreFence: {},
      sourceTransferFence: { sourceGatewayId: "elsewhere", targetGatewayId: "another" } };
    await runGatewayConvergencePass(h.deps);
    expect(h.helm.upsertInstance).toHaveBeenCalledOnce();
  });

  it.each(["restore", "malformed-restore", "source", "target", "mirrored-transfer", "restart"])("holds generic Helm convergence for %s custody", async (fence) => {
    const h = retainedGateway();
    const openclaw = h.users.u.provisioning.openclaw;
    if (fence === "restore" || fence === "malformed-restore") openclaw.restoreFence = fence === "restore" ? { phase: "dispatched" } : null;
    if (fence === "source" || fence === "target") {
      openclaw.gatewayId = "elsewhere";
      openclaw.sourceTransferFence = { [fence === "source" ? "sourceGatewayId" : "targetGatewayId"]: "shared-1" };
    }
    if (fence === "mirrored-transfer") openclaw.sourceTransferFence = {};
    if (fence === "restart") h.roots["shared-1"].runtimeRestartFence = {};
    await expect(runGatewayConvergencePass(h.deps)).rejects.toThrow("outcome is unresolved");
    expect(h.helm.upsertInstance).not.toHaveBeenCalled();
    expect(h.helm.removeInstance).not.toHaveBeenCalled();
  });

  it.each(["paused", "retired"])("holds %s runtime mutation while customer restore custody remains", async (desiredStatus) => {
    const h = retainedGateway({ desiredStatus });
    h.users.u.provisioning.openclaw.restoreFence = {};
    await expect(runGatewayConvergencePass(h.deps)).rejects.toThrow("outcome is unresolved");
    expect(h.helm.upsertInstance).not.toHaveBeenCalled();
    expect(h.helm.removeInstance).not.toHaveBeenCalled();
  });

  it("waits out a pending final home checkpoint quietly while still failing the pass for real errors", async () => {
    const removeInstance = vi.fn(async ({ gatewayId }: { gatewayId: string }) => {
      if (gatewayId === "parking") throw new FinalHomeCheckpointPendingError("computer c is taking its final home checkpoint (requested at 1); parking on a later converge");
      throw new Error("compute API unavailable");
    });
    const log = vi.fn();
    const passDeps = (roots: Record<string, Record<string, unknown>>) => ({
      db: makeDb({ roots, runtimes: {}, callbacks: {} }) as never,
      helm: {
        removeInstance,
        readDeployedInstances: vi.fn(async () => Object.fromEntries(Object.keys(roots).map((gatewayId) => [gatewayId, { enabled: true, image: { repository: "repo", tag: "abc1234" }, gatewayId }]))),
      } as never,
      kubeOps: {} as never,
      chartFingerprint: "chart",
      prepareGatewayConfig: vi.fn(async (config) => config),
      reconcileSurgeHandoff: vi.fn(async () => ({ ready: true })),
      log,
    });

    await runGatewayConvergencePass(passDeps({ parking: durableRoot({ gatewayId: "parking", desiredStatus: "retired" }) }));
    expect(removeInstance).toHaveBeenCalledWith({ namespace: expect.any(String), gatewayId: "parking" });
    expect(log.mock.calls.flat().filter((line) => String(line).includes("⚠"))).toEqual([]);

    await expect(runGatewayConvergencePass(passDeps({
      parking: durableRoot({ gatewayId: "parking", desiredStatus: "retired" }),
      broken: durableRoot({ gatewayId: "broken", desiredStatus: "retired" }),
    }))).rejects.toThrow("(source=converge-gateway) broken: compute API unavailable");
    expect(log).toHaveBeenCalledWith("[converge-gateway] ⚠ broken: compute API unavailable");
    expect(log.mock.calls.flat().filter((line) => String(line).includes("⚠ parking"))).toEqual([]);
  });
});

describe("gateway convergence observations", () => {
  it("reads only selected Helm releases for targeted convergence", async () => {
    const readDeployedInstances = vi.fn(async () => ({}));
    let activeReads = 0;
    let maxActiveReads = 0;
    const readDeployedInstance = vi.fn(async ({ gatewayId }: { gatewayId: string }) => {
      activeReads += 1;
      maxActiveReads = Math.max(maxActiveReads, activeReads);
      await Promise.resolve();
      activeReads -= 1;
      return gatewayId === "default"
        ? {
            enabled: true,
            image: { repository: "repo", tag: "abc1234" },
            gatewayId,
          }
        : null;
    });

    await expect(readGatewayConvergenceInstances(
      { readDeployedInstance, readDeployedInstances },
      "octogee-test",
      ["default", "canary"],
    )).resolves.toEqual({
      default: {
        enabled: true,
        image: { repository: "repo", tag: "abc1234" },
        gatewayId: "default",
      },
    });
    expect(readDeployedInstance.mock.calls).toEqual([
      [{ namespace: "octogee-test", gatewayId: "default" }],
      [{ namespace: "octogee-test", gatewayId: "canary" }],
    ]);
    expect(maxActiveReads).toBe(1);
    expect(readDeployedInstances).not.toHaveBeenCalled();
  });
});

describe("startReconciler — durable root authority (GATEWAY-SIMPLE-ROLL-SPEC)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("refuses fleet mutation while a stray (non-runtime) glmGateways doc exists", async () => {
    const callbacks: SnapshotCallbacks = {};
    const log = vi.fn();
    const syncFleetIngress = vi.fn(async () => {});
    const stop = startReconciler({
      db: makeDb({
        roots: { default: durableRoot() },
        runtimes: {
          "default-r2": {
            docKind: "revision",
            revisionId: "default-r2",
            gateway: "default",
            release: 2,
            lifecycle: "serving",
          },
        },
        callbacks,
      }),
      helm: {} as never,
      handlers: {} as never,
      syncFleetIngress,
      log,
    });

    await runTick(callbacks);
    stop();

    expect(syncFleetIngress).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining("stray glmGateway document(s): default-r2 (revision doc; run scripts/ops/cutover-simple-roll.ts)"),
    );
  });

  it("names deletion, not the cutover script, for a vm-only stray that no durable root owns", async () => {
    const callbacks: SnapshotCallbacks = {};
    const log = vi.fn();
    const syncFleetIngress = vi.fn(async () => {});
    const stop = startReconciler({
      db: makeDb({
        roots: { default: durableRoot() },
        runtimes: {
          "jefe-s-3e8d49e8": { vm: { status: "TERMINATED", stopReason: "idle", instanceName: "octogee-pool-dd5de412", updatedAt: 1 } },
        },
        callbacks,
      }),
      helm: {} as never,
      handlers: {} as never,
      syncFleetIngress,
      log,
    });

    await runTick(callbacks);
    stop();

    expect(log).toHaveBeenCalledWith(
      expect.stringContaining("stray glmGateway document(s): jefe-s-3e8d49e8 (not a runtime doc of a durable gateway, fields: vm; delete glmGateways/jefe-s-3e8d49e8)"),
    );
    expect(log).not.toHaveBeenCalledWith(expect.stringContaining("cutover-simple-roll"));
  });

  it("refuses fleet mutation for an invalid durable root", async () => {
    const callbacks: SnapshotCallbacks = {};
    const log = vi.fn();
    const syncFleetIngress = vi.fn(async () => {});
    const stop = startReconciler({
      db: makeDb({
        roots: { legacy: { gatewayId: "legacy", desiredStatus: "running" } },
        callbacks,
      }),
      helm: {} as never,
      handlers: {} as never,
      syncFleetIngress,
      log,
    });

    await runTick(callbacks);
    stop();

    expect(syncFleetIngress).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining("invalid durable root document(s): legacy"),
    );
  });

  it("restarts the bare gateway deployment after a model-key change", async () => {
    const callbacks: SnapshotCallbacks = {};
    const restartGatewayDeployment = vi.fn(async () => {});
    const stop = startReconciler({
      db: makeDb({
        roots: {
          default: durableRoot({
            profile: "builder",
            gatewayClass: "builder",
            imageProfile: "builder",
            ownerUid: "uid-b",
            builderSlug: "b",
          }),
        },
        runtimes: { default: servingRuntime() },
        releases: { default: { 2: releaseArtifact("default", 2, "abc1234") } },
        callbacks,
      }),
      helm: {} as never,
      handlers: {} as never,
      modelKeySecretEnsurer: {
        syncGatewayModelKeySecret: vi.fn(async () => ({ changed: true })),
      } as never,
      restartGatewayDeployment,
      log: vi.fn(),
    });

    await runTick(callbacks);
    stop();

    expect(restartGatewayDeployment).toHaveBeenCalledWith("default");
  });

  it("publishes the fleet ingress from every non-retired durable root", async () => {
    const callbacks: SnapshotCallbacks = {};
    const syncFleetIngress = vi.fn(async () => {});
    const stop = startReconciler({
      db: makeDb({
        roots: {
          default: durableRoot(),
          paused: durableRoot({ gatewayId: "paused", desiredStatus: "paused" }),
          gone: durableRoot({ gatewayId: "gone", desiredStatus: "retired" }),
        },
        runtimes: { default: servingRuntime() },
        releases: {
          default: { 2: releaseArtifact("default", 2, "abc1234") },
          paused: { 2: releaseArtifact("paused", 2, "abc1234") },
        },
        callbacks,
      }),
      helm: {} as never,
      handlers: {} as never,
      syncFleetIngress,
      log: vi.fn(),
    });

    await runTick(callbacks);
    stop();

    expect(syncFleetIngress).toHaveBeenCalledWith([
      { gatewayId: "default" },
      { gatewayId: "paused" },
    ]);
  });

  it("runs the convergence arm each tick after dependencies sync", async () => {
    const callbacks: SnapshotCallbacks = {};
    const convergeGateways = vi.fn(async () => {});
    const stop = startReconciler({
      db: makeDb({
        roots: { default: durableRoot() },
        runtimes: { default: servingRuntime() },
        releases: { default: { 2: releaseArtifact("default", 2, "abc1234") } },
        callbacks,
      }),
      helm: {} as never,
      handlers: {} as never,
      convergeGateways,
      log: vi.fn(),
    });

    await runTick(callbacks);
    stop();

    expect(convergeGateways).toHaveBeenCalledTimes(1);
  });

  it("limits runtime changes to targeted gateway convergence", async () => {
    const callbacks: SnapshotCallbacks = {};
    const syncFleetIngress = vi.fn(async () => {});
    const convergeGateways = vi.fn(async () => {});
    const stop = startReconciler({
      db: makeDb({
        roots: { default: durableRoot() },
        runtimes: { default: servingRuntime() },
        releases: { default: { 2: releaseArtifact("default", 2, "abc1234") } },
        callbacks,
      }),
      helm: {} as never,
      handlers: {} as never,
      syncFleetIngress,
      convergeGateways,
      log: vi.fn(),
    });

    callbacks.glm?.({
      docChanges: () => [{
        type: "added",
        doc: { id: "default", data: () => servingRuntime() },
      }],
    });
    callbacks.roots?.({
      docChanges: () => [{
        type: "added",
        doc: { id: "default", data: () => durableRoot() },
      }],
    });
    await vi.advanceTimersByTimeAsync(1_000);
    syncFleetIngress.mockClear();
    convergeGateways.mockClear();

    callbacks.glm?.({
      docChanges: () => [{
        type: "modified",
        doc: { id: "default", data: () => servingRuntime({ release: 3 }) },
      }],
    });
    await vi.advanceTimersByTimeAsync(1_000);
    stop();

    expect(convergeGateways).toHaveBeenCalledWith(["default"]);
    expect(syncFleetIngress).not.toHaveBeenCalled();
  });

  it("does not reconcile the fleet when a root doc only records a reconcile error", async () => {
    const callbacks: SnapshotCallbacks = {};
    const convergeGateways = vi.fn(async () => {});
    const stop = startReconciler({
      db: makeDb({
        roots: { default: durableRoot() },
        runtimes: { default: servingRuntime() },
        releases: { default: { 2: releaseArtifact("default", 2, "abc1234") } },
        callbacks,
      }),
      helm: {} as never,
      handlers: {} as never,
      convergeGateways,
      log: vi.fn(),
    });

    callbacks.roots?.({
      docChanges: () => [{
        type: "added",
        doc: { id: "default", data: () => durableRoot() },
      }],
    });
    await vi.advanceTimersByTimeAsync(1_000);
    convergeGateways.mockClear();

    callbacks.roots?.({
      docChanges: () => [{
        type: "modified",
        doc: {
          id: "default",
          data: () => durableRoot({
            lastError: { slug: "alice", message: "mount failed", at: 2 },
          }),
        },
      }],
    });
    await vi.advanceTimersByTimeAsync(1_000);
    stop();

    expect(convergeGateways).not.toHaveBeenCalled();
  });

  it("runs a full safety reconciliation only after the configured interval", async () => {
    const callbacks: SnapshotCallbacks = {};
    const convergeGateways = vi.fn(async () => {});
    const stop = startReconciler({
      db: makeDb({
        roots: { default: durableRoot() },
        runtimes: { default: servingRuntime() },
        releases: { default: { 2: releaseArtifact("default", 2, "abc1234") } },
        callbacks,
      }),
      helm: {} as never,
      handlers: {} as never,
      convergeGateways,
      reconcileSafetyRefreshMs: 5_000,
      log: vi.fn(),
    });

    await runTick(callbacks);
    convergeGateways.mockClear();
    await vi.advanceTimersByTimeAsync(3_999);
    expect(convergeGateways).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1_001);
    stop();

    expect(convergeGateways).toHaveBeenCalledTimes(1);
    expect(convergeGateways).toHaveBeenCalledWith(undefined);
  });

  it("logs bounded timing for each reconciliation phase", async () => {
    const callbacks: SnapshotCallbacks = {};
    const log = vi.fn();
    const stop = startReconciler({
      db: makeDb({
        roots: { default: durableRoot() },
        runtimes: { default: servingRuntime() },
        releases: { default: { 2: releaseArtifact("default", 2, "abc1234") } },
        callbacks,
      }),
      helm: {} as never,
      handlers: {} as never,
      convergeGateways: vi.fn(async () => {}),
      log,
    });

    await runTick(callbacks);
    stop();

    for (const phase of [
      "durable-state",
      "runtime-dependencies",
      "convergence",
      "fleet-ingress",
    ]) {
      expect(log).toHaveBeenCalledWith(
        `[glm-controller] reconcile phase=${phase} started`,
      );
      expect(log).toHaveBeenCalledWith(
        expect.stringMatching(
          new RegExp(`^\\[glm-controller\\] reconcile phase=${phase} completed durationMs=\\d+$`),
        ),
      );
    }
  });

  it("serializes global and targeted convergence passes", async () => {
    const started: Array<readonly string[] | undefined> = [];
    let releaseFirst: (() => void) | undefined;
    const firstPass = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const converge = serializeGatewayConvergence(async (gatewayIds) => {
      started.push(gatewayIds);
      if (started.length === 1) await firstPass;
    });

    const global = converge();
    const targeted = converge(["default-b"]);
    await Promise.resolve();

    expect(started).toEqual([undefined]);
    releaseFirst?.();
    await Promise.all([global, targeted]);
    expect(started).toEqual([undefined, ["default-b"]]);
  });
  it('serializes runtime recovery with convergence and releases the turn after failure', async () => {
    const events: string[] = [];
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    const converge = serializeGatewayConvergence(async () => { events.push('converge'); });
    const recovery = converge.runExclusive(async () => { events.push('recover'); await pending; throw new Error('lost reply'); });
    const observed = expect(recovery).rejects.toThrow('lost reply');
    const next = converge();
    await Promise.resolve();
    expect(events).toEqual(['recover']);
    release(); await observed; await next;
    expect(events).toEqual(['recover', 'converge']);
  });
});
