import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  durableRootRenderSnapshotChanges,
  servingRevisionExistsForGatewayQuery,
  snapshotHasDurableRootRenderChange,
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
    liveRevisionId: "default-r2",
    trafficRevisionId: "default-r2",
    desiredStatus: "running",
    roll: null,
    configSchemaVersion: 1,
    profile: "standard",
    gatewayClass: "shared",
    imageProfile: "standard",
    sizingTier: "medium",
    computeClass: "test-spot",
    gcpProject: null,
    gatewayContainerSecurityContext: null,
    serviceAccountName: null,
    serviceAccount: null,
    operatorAccess: null,
    ownerUid: null,
    coOwnerUids: [],
    builderSlug: null,
    openclawOverrides: null,
    modelBrokerLimits: null,
    preemption: null,
    ...overrides,
  };
}

function servingRevision(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    docKind: "revision",
    revisionId: "default-r2",
    gateway: "default",
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
  revisions?: Record<string, Record<string, unknown>>;
  releases?: Record<string, Record<number, Record<string, unknown>>>;
  callbacks: SnapshotCallbacks;
}) {
  const roots = input.roots ?? {};
  const revisions = input.revisions ?? {};
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
          get: async () => snapshot(revisions),
          doc: (id: string) => document(revisions, id),
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
): Record<string, unknown> {
  return {
    gatewayId,
    release,
    payload: {
      imageRepository: "us-central1-docker.pkg.dev/octogee/octogee/octogee-gateway",
      imageTag,
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
  it("ignores a heartbeat-only runtime revision change", () => {
    const fingerprints = new Map<string, string>();
    snapshotHasReconcileRelevantChange(
      [{ type: "added", doc: { id: "default-r2", data: () => servingRevision() } }],
      fingerprints,
    );

    expect(
      snapshotHasReconcileRelevantChange(
        [
          {
            type: "modified",
            doc: {
              id: "default-r2",
              data: () => ({ ...servingRevision(), heartbeat: { lastHeartbeatAt: 2 } }),
            },
          },
        ],
        fingerprints,
      ),
    ).toBe(false);
  });

  it("marks valid and invalid durable roots dirty for rendering", () => {
    const fingerprints = new Map<string, string>();
    expect(
      snapshotHasDurableRootRenderChange(
        [{ type: "added", doc: { id: "default", data: () => durableRoot() } }],
        fingerprints,
      ),
    ).toBe(true);
    expect(
      snapshotHasDurableRootRenderChange(
        [{ type: "added", doc: { id: "legacy", data: () => ({ gatewayId: "legacy" }) } }],
        fingerprints,
      ),
    ).toBe(true);
  });

  it("queues changed valid and invalid roots but not a removed root for rendering", () => {
    const fingerprints = new Map<string, string>();
    durableRootRenderSnapshotChanges(
      [
        { type: "added", doc: { id: "default", data: () => durableRoot() } },
        { type: "added", doc: { id: "malformed", data: () => ({ gatewayId: "malformed" }) } },
        { type: "added", doc: { id: "gone", data: () => durableRoot({ gatewayId: "gone" }) } },
      ],
      fingerprints,
    );

    expect(
      durableRootRenderSnapshotChanges(
        [
          {
            type: "modified",
            doc: { id: "default", data: () => durableRoot({ desiredRelease: 3 }) },
          },
          {
            type: "modified",
            doc: { id: "malformed", data: () => ({ gatewayId: "malformed", changed: true }) },
          },
          { type: "removed", doc: { id: "gone", data: () => ({}) } },
        ],
        fingerprints,
      ),
    ).toEqual({ shouldSchedule: true, gatewayIds: ["default", "malformed"] });
  });

  it("re-renders a root when guarded compaction clears its legacy bridge", () => {
    const fingerprints = new Map<string, string>();
    durableRootRenderSnapshotChanges(
      [
        {
          type: "added",
          doc: {
            id: "default",
            data: () => durableRoot({
              legacyBackfill: { sourceGlmGatewayIds: ["default-blue"], startedAt: 1 },
            }),
          },
        },
      ],
      fingerprints,
    );

    expect(
      durableRootRenderSnapshotChanges(
        [{ type: "modified", doc: { id: "default", data: () => durableRoot({ legacyBackfill: null }) } }],
        fingerprints,
      ),
    ).toEqual({ shouldSchedule: true, gatewayIds: ["default"] });
  });
});

describe("servingRevisionExistsForGatewayQuery", () => {
  const legacyBridgeSource = () => ({
    gatewayId: "default-blue",
    gateway: "default",
    desiredStatus: "running",
    imageRepository: "us-central1-docker.pkg.dev/octogee/octogee/octogee-gateway",
    imageTag: "abc1234",
    createdBy: "legacy-controller",
  });

  it("skips only the marker-authorized bridge source while checking canonical revisions", () => {
    const root = durableRoot({
      latestRelease: 1,
      desiredRelease: 1,
      liveRelease: null,
      liveRevisionId: null,
      trafficRevisionId: null,
      legacyBackfill: { sourceGlmGatewayIds: ["default-blue"], startedAt: 1 },
    });

    expect(
      servingRevisionExistsForGatewayQuery(
        [
          { id: "default-blue", data: legacyBridgeSource },
          { id: "default-r2", data: servingRevision },
        ],
        root,
      ),
    ).toBe(true);
  });

  it("rejects an unlisted or malformed non-revision query result", () => {
    const root = durableRoot({
      latestRelease: 1,
      desiredRelease: 1,
      liveRelease: null,
      liveRevisionId: null,
      trafficRevisionId: null,
      legacyBackfill: { sourceGlmGatewayIds: ["default-blue"], startedAt: 1 },
    });

    expect(() =>
      servingRevisionExistsForGatewayQuery(
        [
          { id: "default-r2", data: servingRevision },
          { id: "default-green", data: legacyBridgeSource },
        ],
        root,
      ),
    ).toThrow(/not a revision realization/u);
    expect(() =>
      servingRevisionExistsForGatewayQuery(
        [{ id: "default-blue", data: () => ({ ...legacyBridgeSource(), createdBy: undefined }) }],
        root,
      ),
    ).toThrow(/not a revision realization/u);
  });
});

describe("startReconciler — durable root authority", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("does not treat a bare glmGateways document as deployable desired state", async () => {
    const callbacks: SnapshotCallbacks = {};
    const syncFleetIngress = vi.fn(async () => {});
    const log = vi.fn();
    const modelKeySourceIssuer = { syncGatewayModelKeySource: vi.fn(async () => ({ changed: false })) };
    const modelKeySecretEnsurer = { syncGatewayModelKeySecret: vi.fn(async () => ({ changed: false })) };
    const convergeEmpty = vi.fn(async () => {});
    const stop = startReconciler({
      db: makeDb({
        callbacks,
        revisions: {
          legacy: {
            gatewayId: "legacy",
            desiredStatus: "running",
            imageRepository: "repo",
            imageTag: "abc1234",
          },
        },
      }),
      helm: {} as Parameters<typeof startReconciler>[0]["helm"],
      handlers: {} as Parameters<typeof startReconciler>[0]["handlers"],
      modelKeySourceIssuer,
      modelKeySecretEnsurer,
      convergeEmpty,
      syncFleetIngress,
      log,
    });

    await runTick(callbacks);

    expect(modelKeySourceIssuer.syncGatewayModelKeySource).not.toHaveBeenCalled();
    expect(modelKeySecretEnsurer.syncGatewayModelKeySecret).not.toHaveBeenCalled();
    expect(syncFleetIngress).not.toHaveBeenCalled();
    expect(convergeEmpty).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/legacy glmGateway document.*legacy/u));
    stop();
  });

  it("materializes only an explicitly backfilled legacy bridge while holding normal fleet mutations", async () => {
    const callbacks: SnapshotCallbacks = {};
    const syncFleetIngress = vi.fn(async () => {});
    const convergeEmpty = vi.fn(async () => {});
    const convergeRoll = vi.fn(async () => {});
    const renderDurableRootConfigs = vi.fn(async () => ({ failedGatewayIds: [] }));
    const modelKeySourceIssuer = { syncGatewayModelKeySource: vi.fn(async () => ({ changed: false })) };
    const modelKeySecretEnsurer = { syncGatewayModelKeySecret: vi.fn(async () => ({ changed: false })) };
    const stop = startReconciler({
      db: makeDb({
        callbacks,
        roots: {
          default: durableRoot({
            latestRelease: 1,
            desiredRelease: 1,
            liveRelease: null,
            liveRevisionId: null,
            trafficRevisionId: null,
            legacyBackfill: { sourceGlmGatewayIds: ["default-blue"], startedAt: 1 },
          }),
          bender: durableRoot({ gatewayId: "bender" }),
        },
        revisions: {
          "default-blue": {
            gatewayId: "default-blue",
            desiredStatus: "running",
            imageRepository: "us-central1-docker.pkg.dev/octogee/octogee/octogee-gateway",
            imageTag: "abc1234",
            createdBy: "legacy-controller",
          },
        },
      }),
      helm: {} as Parameters<typeof startReconciler>[0]["helm"],
      handlers: {} as Parameters<typeof startReconciler>[0]["handlers"],
      modelKeySourceIssuer,
      modelKeySecretEnsurer,
      convergeEmpty,
      convergeRoll,
      renderDurableRootConfigs,
      syncFleetIngress,
      log: vi.fn(),
    });

    await runTick(callbacks);

    expect(modelKeySourceIssuer.syncGatewayModelKeySource).toHaveBeenCalledTimes(1);
    expect(modelKeySecretEnsurer.syncGatewayModelKeySecret).toHaveBeenCalledTimes(1);
    expect(modelKeySourceIssuer.syncGatewayModelKeySource).toHaveBeenCalledWith(
      expect.objectContaining({ gatewayId: "default" }),
    );
    expect(modelKeySecretEnsurer.syncGatewayModelKeySecret).toHaveBeenCalledWith(
      expect.objectContaining({ gatewayId: "default" }),
    );
    expect(convergeEmpty).toHaveBeenCalledWith(["default"]);
    expect(renderDurableRootConfigs).not.toHaveBeenCalled();
    expect(convergeRoll).not.toHaveBeenCalled();
    expect(syncFleetIngress).not.toHaveBeenCalled();
    stop();
  });

  it("fails closed when a bridge marker loses its listed legacy source", async () => {
    const callbacks: SnapshotCallbacks = {};
    const syncFleetIngress = vi.fn(async () => {});
    const convergeEmpty = vi.fn(async () => {});
    const convergeRoll = vi.fn(async () => {});
    const modelKeySourceIssuer = { syncGatewayModelKeySource: vi.fn(async () => ({ changed: false })) };
    const modelKeySecretEnsurer = { syncGatewayModelKeySecret: vi.fn(async () => ({ changed: false })) };
    const log = vi.fn();
    const stop = startReconciler({
      db: makeDb({
        callbacks,
        roots: {
          default: durableRoot({
            latestRelease: 1,
            desiredRelease: 1,
            liveRelease: null,
            liveRevisionId: null,
            trafficRevisionId: null,
            legacyBackfill: { sourceGlmGatewayIds: ["default-blue"], startedAt: 1 },
          }),
        },
      }),
      helm: {} as Parameters<typeof startReconciler>[0]["helm"],
      handlers: {} as Parameters<typeof startReconciler>[0]["handlers"],
      modelKeySourceIssuer,
      modelKeySecretEnsurer,
      convergeEmpty,
      convergeRoll,
      syncFleetIngress,
      log,
    });

    await runTick(callbacks);

    expect(modelKeySourceIssuer.syncGatewayModelKeySource).not.toHaveBeenCalled();
    expect(modelKeySecretEnsurer.syncGatewayModelKeySecret).not.toHaveBeenCalled();
    expect(convergeEmpty).not.toHaveBeenCalled();
    expect(convergeRoll).not.toHaveBeenCalled();
    expect(syncFleetIngress).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/missing.*default-blue/u));
    stop();
  });

  it("uses a validated serving revision to publish the fleet ingress", async () => {
    const callbacks: SnapshotCallbacks = {};
    const syncFleetIngress = vi.fn(async () => {});
    const stop = startReconciler({
      db: makeDb({
        callbacks,
        roots: { default: durableRoot() },
        revisions: { "default-r2": servingRevision() },
      }),
      helm: {} as Parameters<typeof startReconciler>[0]["helm"],
      handlers: {} as Parameters<typeof startReconciler>[0]["handlers"],
      syncFleetIngress,
      log: vi.fn(),
    });

    await runTick(callbacks);

    expect(syncFleetIngress).toHaveBeenCalledWith([{ gatewayId: "default" }]);
    stop();
  });

  it("preserves ingress and image pins when a non-retired revision shadows a canonical id", async () => {
    const callbacks: SnapshotCallbacks = {};
    const syncFleetIngress = vi.fn(async () => {});
    const reconcileImagePins = vi.fn(async () => {});
    const log = vi.fn();
    const stop = startReconciler({
      db: makeDb({
        callbacks,
        roots: { default: durableRoot() },
        revisions: {
          "default-r2": servingRevision(),
          "default-r2-shadow": servingRevision(),
        },
      }),
      helm: {} as Parameters<typeof startReconciler>[0]["helm"],
      handlers: {} as Parameters<typeof startReconciler>[0]["handlers"],
      reconcileImagePins,
      syncFleetIngress,
      log,
    });

    await runTick(callbacks);

    expect(syncFleetIngress).not.toHaveBeenCalled();
    expect(reconcileImagePins).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/without a valid durable root.*default-r2-shadow/u));
    stop();
  });

  it("pins every active durable revision artifact", async () => {
    const callbacks: SnapshotCallbacks = {};
    const reconcileImagePins = vi.fn(async () => {});
    const stop = startReconciler({
      db: makeDb({
        callbacks,
        roots: { default: durableRoot() },
        revisions: { "default-r2": servingRevision() },
        releases: {
          default: {
            2: releaseArtifact("default", 2, "abc1234"),
          },
        },
      }),
      helm: {} as Parameters<typeof startReconciler>[0]["helm"],
      handlers: {} as Parameters<typeof startReconciler>[0]["handlers"],
      reconcileImagePins,
      log: vi.fn(),
    });

    await runTick(callbacks);

    expect(reconcileImagePins).toHaveBeenCalledWith(
      "prod",
      [{
        imageRepository: "us-central1-docker.pkg.dev/octogee/octogee/octogee-gateway",
        imageTag: "abc1234",
      }],
      expect.any(Function),
    );
    stop();
  });

  it("preserves ingress and image pins when any durable root is invalid", async () => {
    const callbacks: SnapshotCallbacks = {};
    const syncFleetIngress = vi.fn(async () => {});
    const reconcileImagePins = vi.fn(async () => {});
    const log = vi.fn();
    const stop = startReconciler({
      db: makeDb({
        callbacks,
        roots: {
          default: durableRoot(),
          malformed: { gatewayId: "malformed" },
        },
        revisions: { "default-r2": servingRevision() },
      }),
      helm: {} as Parameters<typeof startReconciler>[0]["helm"],
      handlers: {} as Parameters<typeof startReconciler>[0]["handlers"],
      reconcileImagePins,
      syncFleetIngress,
      log,
    });

    await runTick(callbacks);

    expect(syncFleetIngress).not.toHaveBeenCalled();
    expect(reconcileImagePins).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/invalid durable root.*malformed/u));
    stop();
  });

  it("preserves ingress and image pins when a live revision has no durable root", async () => {
    const callbacks: SnapshotCallbacks = {};
    const syncFleetIngress = vi.fn(async () => {});
    const reconcileImagePins = vi.fn(async () => {});
    const log = vi.fn();
    const stop = startReconciler({
      db: makeDb({
        callbacks,
        revisions: { "default-r2": servingRevision() },
      }),
      helm: {} as Parameters<typeof startReconciler>[0]["helm"],
      handlers: {} as Parameters<typeof startReconciler>[0]["handlers"],
      reconcileImagePins,
      syncFleetIngress,
      log,
    });

    await runTick(callbacks);

    expect(syncFleetIngress).not.toHaveBeenCalled();
    expect(reconcileImagePins).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/without a valid durable root.*default-r2/u));
    stop();
  });

  it("restarts the traffic revision, never the bare gateway deployment, after a model-key change", async () => {
    const callbacks: SnapshotCallbacks = {};
    const restartGatewayDeployment = vi.fn(async () => {});
    const stop = startReconciler({
      db: makeDb({
        callbacks,
        roots: {
          default: durableRoot({ gatewayClass: "builder", ownerUid: "owner-1" }),
        },
        revisions: { "default-r2": servingRevision() },
      }),
      helm: {} as Parameters<typeof startReconciler>[0]["helm"],
      handlers: {} as Parameters<typeof startReconciler>[0]["handlers"],
      modelKeySourceIssuer: {
        syncGatewayModelKeySource: vi.fn(async () => ({ changed: true })),
      },
      modelKeySecretEnsurer: {
        syncGatewayModelKeySecret: vi.fn(async () => ({ changed: true })),
      },
      restartGatewayDeployment,
      log: vi.fn(),
    });

    await runTick(callbacks);

    expect(restartGatewayDeployment).toHaveBeenCalledWith("default-r2");
    expect(restartGatewayDeployment).not.toHaveBeenCalledWith("default");
    stop();
  });

  it("renders only durable roots after a root snapshot", async () => {
    const callbacks: SnapshotCallbacks = {};
    const renderDurableRootConfigs = vi.fn(async () => ({ failedGatewayIds: [] }));
    const stop = startReconciler({
      db: makeDb({
        callbacks,
        roots: {
          default: durableRoot(),
          legacy: { gatewayId: "legacy", desiredStatus: "running" },
        },
      }),
      helm: {} as Parameters<typeof startReconciler>[0]["helm"],
      handlers: {} as Parameters<typeof startReconciler>[0]["handlers"],
      renderDurableRootConfigs,
      log: vi.fn(),
    });

    await runTick(callbacks);

    expect(renderDurableRootConfigs).toHaveBeenCalledWith({ all: true, gatewayIds: [] });
    stop();
  });

  it("requeues only a targeted renderer exception", async () => {
    const callbacks: SnapshotCallbacks = {};
    let failTargetedRender = true;
    const renderDurableRootConfigs = vi.fn(async (request: { all: boolean; gatewayIds: string[] }) => {
      if (!request.all && failTargetedRender) {
        failTargetedRender = false;
        throw new Error("targeted render failure");
      }
      return { failedGatewayIds: [] };
    });
    const stop = startReconciler({
      db: makeDb({
        callbacks,
        roots: { default: durableRoot() },
        revisions: { "default-r2": servingRevision() },
        releases: { default: { 2: releaseArtifact("default", 2, "abc1234") } },
      }),
      helm: {} as Parameters<typeof startReconciler>[0]["helm"],
      handlers: {} as Parameters<typeof startReconciler>[0]["handlers"],
      renderDurableRootConfigs,
      reconcileRetryMs: 10,
      log: vi.fn(),
    });

    await runTick(callbacks);
    renderDurableRootConfigs.mockClear();
    callbacks.roots?.({
      docChanges: () => [
        {
          type: "modified",
          doc: { id: "default", data: () => durableRoot({ desiredRelease: 3 }) },
        },
      ],
    });
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.advanceTimersByTimeAsync(10);

    expect(renderDurableRootConfigs).toHaveBeenNthCalledWith(1, {
      all: false,
      gatewayIds: ["default"],
    });
    expect(renderDurableRootConfigs).toHaveBeenNthCalledWith(2, {
      all: false,
      gatewayIds: ["default"],
    });
    expect(renderDurableRootConfigs).not.toHaveBeenCalledWith({ all: true, gatewayIds: [] });
    stop();
  });

  it("reconciles a removed root without scheduling a render for it", async () => {
    const callbacks: SnapshotCallbacks = {};
    const roots = { default: durableRoot() };
    const revisions = { "default-r2": servingRevision() };
    const syncFleetIngress = vi.fn(async () => {});
    const renderDurableRootConfigs = vi.fn(async () => ({ failedGatewayIds: [] }));
    const stop = startReconciler({
      db: makeDb({
        callbacks,
        roots,
        revisions,
        releases: { default: { 2: releaseArtifact("default", 2, "abc1234") } },
      }),
      helm: {} as Parameters<typeof startReconciler>[0]["helm"],
      handlers: {} as Parameters<typeof startReconciler>[0]["handlers"],
      renderDurableRootConfigs,
      syncFleetIngress,
      log: vi.fn(),
    });

    await runTick(callbacks);
    renderDurableRootConfigs.mockClear();
    delete roots.default;
    delete revisions["default-r2"];
    callbacks.roots?.({
      docChanges: () => [{ type: "removed", doc: { id: "default", data: () => ({}) } }],
    });
    await vi.advanceTimersByTimeAsync(1_000);

    expect(renderDurableRootConfigs).not.toHaveBeenCalled();
    expect(syncFleetIngress).toHaveBeenLastCalledWith([]);
    stop();
  });
});
