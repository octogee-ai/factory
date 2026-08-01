import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  readGatewayConvergenceInstances,
  serializeGatewayConvergence,
  snapshotHasReconcileRelevantChange,
  startReconciler,
} from "../index";

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
    operatorAccess: null,
    ownerUid: null,
    builderSlug: null,
    openclawOverrides: null,
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
}) {
  const roots = input.roots ?? {};
  const runtimes = input.runtimes ?? {};
  const releases = input.releases ?? {};
  const snapshot = (store: Record<string, Record<string, unknown>>) => ({
    docs: Object.entries(store).map(([id, data]) => ({ id, data: () => data })),
  });
  const document = (store: Record<string, Record<string, unknown>>, id: string) => ({
    get: async () => ({
      exists: Object.prototype.hasOwnProperty.call(store, id),
      data: () => store[id],
    }),
  });
  return {
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
    const reconcileImagePins = vi.fn(async () => {});
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
      reconcileImagePins,
      syncFleetIngress,
      log,
    });

    await runTick(callbacks);
    stop();

    expect(reconcileImagePins).not.toHaveBeenCalled();
    expect(syncFleetIngress).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining("stray glmGateway document(s): default-r2"),
    );
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

  it("pins desired+live release artifacts with the recorded gateway-edge sidecar", async () => {
    const callbacks: SnapshotCallbacks = {};
    const reconcileImagePins = vi.fn(async () => {});
    const log = vi.fn();
    const stop = startReconciler({
      db: makeDb({
        roots: { default: durableRoot({ desiredRelease: 3, liveRelease: 2, latestRelease: 3 }) },
        runtimes: { default: servingRuntime() },
        releases: {
          default: {
            2: releaseArtifact("default", 2, "abc1234"),
            3: releaseArtifact("default", 3, "def5678"),
          },
        },
        callbacks,
      }),
      helm: {} as never,
      handlers: {} as never,
      reconcileImagePins,
      log,
    });

    await runTick(callbacks);
    stop();

    expect(reconcileImagePins.mock.calls).toHaveLength(1);
    const [, artifacts] = reconcileImagePins.mock.calls[0] as [
      string,
      Array<{ imageRepository: string; imageTag: string }>,
    ];
    const tags = artifacts.map((a) => `${a.imageRepository.split("/").at(-1)}:${a.imageTag}`).sort();
    expect(tags).toEqual([
      "gateway-edge:abc1234",
      "gateway-edge:def5678",
      "octogee-gateway:abc1234",
      "octogee-gateway:def5678",
    ]);
  });

  it("pins the effective operator gateway image instead of the standard release repository", async () => {
    const gatewayId = "builder-alice";
    const callbacks: SnapshotCallbacks = {};
    const reconcileImagePins = vi.fn(async () => {});
    const log = vi.fn();
    const operatorRoot = durableRoot({
      gatewayId,
      profile: "operator",
      gatewayClass: "operator",
      imageProfile: "operator",
      sizingTier: "xs",
      serviceAccountName: "octogee-gw-builder-alice",
      serviceAccount: { create: false },
      operatorAccess: {
        shellsEnabled: false,
        controlUiEnabled: false,
      },
      ownerUid: "uid-alice",
      builderSlug: "alice",
      allocation: {
        kind: "disposable-builder",
        schemaVersion: 1,
        leaseId: "lease-one",
        generation: 1,
        claimedByUid: "uid-alice",
      },
    });
    const stop = startReconciler({
      db: makeDb({
        roots: {
          [gatewayId]: { ...operatorRoot, liveRelease: 2 },
        },
        runtimes: {
          [gatewayId]: servingRuntime({ gatewayId }),
        },
        releases: {
          [gatewayId]: {
            2: releaseArtifact(gatewayId, 2, "abc1234"),
          },
        },
        callbacks,
      }),
      helm: {} as never,
      handlers: {} as never,
      reconcileImagePins,
      log,
    });

    await runTick(callbacks);
    stop();

    const [, artifacts] = reconcileImagePins.mock.calls[0] as [
      string,
      Array<{ imageRepository: string; imageTag: string }>,
    ];
    expect(artifacts).toEqual(expect.arrayContaining([
      {
        imageRepository:
          "us-central1-docker.pkg.dev/octogee/octogee/octogee-gateway-operator",
        imageTag: "abc1234",
      },
    ]));
    expect(artifacts).not.toEqual(expect.arrayContaining([
      {
        imageRepository: "us-central1-docker.pkg.dev/octogee/octogee/octogee-gateway",
        imageTag: "abc1234",
      },
    ]));
  });

  it("pins the W9 gateway-edge candidate artifact alongside the gateway image", async () => {
    const digestTag = `agent-conversation-w9a-8c356bb1@sha256:${"a".repeat(64)}`;
    const edgeTag = `agent-conversation-w9a-8c356bb1@sha256:${"d".repeat(64)}`;
    const callbacks: SnapshotCallbacks = {};
    const reconcileImagePins = vi.fn(async () => {});
    const stop = startReconciler({
      db: makeDb({
        roots: { default: durableRoot({ desiredRelease: 2, liveRelease: 2 }) },
        runtimes: { default: servingRuntime() },
        releases: {
          default: {
            2: releaseArtifact("default", 2, digestTag, {
              gatewayEdgeImage: {
                imageRepository: "us-central1-docker.pkg.dev/octogee/octogee/gateway-edge",
                imageTag: edgeTag,
              },
              testExperiment: {
                kind: "w9-agent-conversation",
                mode: "publisher-live",
                candidateManifest: {
                  path: "infra/gateway/openclaw-candidates/agent-conversation.json",
                  sha256: "b".repeat(64),
                },
                mattermostOverlay: {
                  valuesPath: "infra/candidates/values.mattermost-silent-post.yaml",
                  imageReference: `mattermostdevelopment/mattermost-team-edition:cce485f@sha256:${"c".repeat(64)}`,
                },
              },
            }),
          },
        },
        callbacks,
      }),
      helm: {} as never,
      handlers: {} as never,
      reconcileImagePins,
      log: vi.fn(),
    });

    await runTick(callbacks);
    stop();

    const [, artifacts] = reconcileImagePins.mock.calls[0] as [
      string,
      Array<{ imageRepository: string; imageTag: string }>,
    ];
    expect(artifacts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ imageTag: digestTag }),
        expect.objectContaining({ imageTag: edgeTag }),
      ]),
    );
  });

  it("restarts the bare gateway deployment after a model-key change", async () => {
    const callbacks: SnapshotCallbacks = {};
    const restartGatewayDeployment = vi.fn(async () => {});
    const stop = startReconciler({
      db: makeDb({
        roots: {
          default: durableRoot({
            gatewayClass: "builder",
            imageProfile: "standard",
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
    const reconcileImagePins = vi.fn(async () => {});
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
      reconcileImagePins,
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
    reconcileImagePins.mockClear();
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
    expect(reconcileImagePins).not.toHaveBeenCalled();
    expect(syncFleetIngress).not.toHaveBeenCalled();
  });

  it("runs a full safety reconciliation only after the configured interval", async () => {
    const callbacks: SnapshotCallbacks = {};
    const reconcileImagePins = vi.fn(async () => {});
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
      reconcileImagePins,
      convergeGateways,
      reconcileSafetyRefreshMs: 5_000,
      log: vi.fn(),
    });

    await runTick(callbacks);
    reconcileImagePins.mockClear();
    convergeGateways.mockClear();
    await vi.advanceTimersByTimeAsync(3_999);
    expect(reconcileImagePins).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1_001);
    stop();

    expect(reconcileImagePins).toHaveBeenCalledTimes(1);
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
      "image-pins",
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
});
