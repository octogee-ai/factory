import { afterEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import type { Firestore } from "firebase-admin/firestore";

import {
  addAdminFleetRoutes,
  projectBuilderRuntime,
  projectDisposableFleetCapacity,
  projectGatewayReservation,
  projectGatewaySummary,
  resolveFleetDeploymentSettings,
  type GatewayPodDiagnostics,
} from "./admin-fleet-router.js";
import {
  GLM_GATEWAYS_COLLECTION,
  GLM_OPERATIONS_COLLECTION,
} from "@octogee/shared/types/glm";
import { SPOT_PRICE_MULTIPLIER } from "@octogee/shared/types/cost-estimator";

// The Fleet card's reservation/cost derives from this projection. Gateway pods
// carry only `cloud.google.com/gke-spot` now — no compute class, and no
// on-demand fallback rung — so the projection is Spot for every class.
describe("projectGatewayReservation — Spot with no fallback rung", () => {
  afterEach(() => vi.unstubAllEnvs());

  it.each([
    ["PROD", "octogee"],
    ["TEST", "octogee-test"],
    ["Build Week", "octogee-build-week"],
  ])("%s gateways are Spot-priced and expose no compute class", (_label, namespace) => {
    vi.stubEnv("K8S_NAMESPACE", namespace);
    const r = projectGatewayReservation({ profile: "operator", gatewayClass: "operator" });
    expect(r).toEqual({ type: "spot", priceMultiplier: SPOT_PRICE_MULTIPLIER });
    expect(r).not.toHaveProperty("computeClass");
  });

  it("ignores a residual computeClass or scheduling field on the glm doc", () => {
    vi.stubEnv("K8S_NAMESPACE", "octogee");
    const r = projectGatewayReservation({
      profile: "operator",
      scheduling: "on-demand",
    });
    expect(r).toEqual({ type: "spot", priceMultiplier: SPOT_PRICE_MULTIPLIER });
  });

});

describe("resolveFleetDeploymentSettings", () => {
  it("uses the active deployment target for the fleet namespace", () => {
    expect(resolveFleetDeploymentSettings("octogee-test")).toMatchObject({
      targetId: "test-central",
      artifactRegistryRepository: "us-west1-docker.pkg.dev/octogee/octogee",
    });
  });

  it("uses an explicit target override regardless of the active pointer", () => {
    expect(resolveFleetDeploymentSettings("octogee-build-week", "build-week-central")).toMatchObject({
      targetId: "build-week-central",
      artifactRegistryRepository: "us-central1-docker.pkg.dev/octogee/octogee",
    });
  });

  it("fails closed for a namespace outside the deployment contract", () => {
    expect(() => resolveFleetDeploymentSettings("feat-alice")).toThrow(
      "Unknown deployment environment for fleet namespace: feat-alice",
    );
  });
});

// Step 1 of the Fleet regroup (GATEWAY-RELEASES-SPEC): every row projects its
// durable "gateway" identity so the client can group blue/green siblings under
// one card without an id/route migration.
describe("projectGatewaySummary — gateway identity projection", () => {
  it("uses the explicit glmGateways.gateway field when present", () => {
    const summary = projectGatewaySummary(
      { id: "default-blue", data: () => ({ gatewayId: "default-blue" }) },
      { gatewayId: "default-blue", gateway: "default" },
      Date.now(),
    );
    expect(summary.gateway).toBe("default");
  });

  it("falls back to convention-parse (strip trailing -blue/-green) when the field is absent", () => {
    const summary = projectGatewaySummary(
      { id: "bender-green", data: () => ({ gatewayId: "bender-green" }) },
      { gatewayId: "bender-green" },
      Date.now(),
    );
    expect(summary.gateway).toBe("bender");
  });

  it("treats an unsuffixed id as its own bare gateway identity", () => {
    const summary = projectGatewaySummary(
      { id: "jack", data: () => ({ gatewayId: "jack" }) },
      { gatewayId: "jack" },
      Date.now(),
    );
    expect(summary.gateway).toBe("jack");
  });

  it("marks an allocated Operator gateway as one disposable Builder generation", () => {
    const summary = projectGatewaySummary(
      { id: "run-alice-12345678", data: () => ({ gatewayId: "run-alice-12345678" }) },
      {
        gatewayId: "run-alice-12345678",
        gatewayClass: "operator",
        ownerUid: "uid-alice",
        allocation: {
          kind: "disposable-builder",
          schemaVersion: 1,
          leaseId: "lease-1",
          generation: 3,
          claimedByUid: "uid-alice",
        },
      },
      Date.now(),
    );

    expect(summary.disposableRuntime).toEqual({
      ownerUid: "uid-alice",
      leaseId: "lease-1",
      generation: 3,
    });
  });
});

describe("projectBuilderRuntime — disposable lifecycle visibility", () => {
  const now = 1_722_000_900_000;

  function user(activationLease: Record<string, unknown>) {
    return {
      id: "uid-alice",
      data: () => ({
        username: "alice",
        provisioning: {
          openclaw: {
            gatewayId: "shared-blue",
            slug: "alice",
            activationLease,
          },
        },
      }),
    };
  }

  it("projects requestedAt as the wake duration origin", () => {
    expect(projectBuilderRuntime(
      user({
        leaseId: "lease-1",
        generation: 1,
        status: "requested",
        cause: "run-start",
        requestedAt: now - 90_000,
        sourceGatewayId: "shared-blue",
        sizingTier: "xs",
      }),
      new Map(),
      new Map(),
      now,
    )).toMatchObject({
      uid: "uid-alice",
      builderSlug: "alice",
      lifecycle: "requested",
      wakeDurationMs: 90_000,
      currentGatewayId: "shared-blue",
      sourceGatewayId: "shared-blue",
      targetGatewayId: null,
      sizingTier: "xs",
    });
  });

  it("keeps stale provisioning visible with the exact disposable target", () => {
    expect(projectBuilderRuntime(
      user({
        leaseId: "lease-1",
        generation: 1,
        status: "provisioning",
        cause: "scheduled",
        requestedAt: now - 20 * 60_000,
        provisionedAt: now - 60_000,
        sourceGatewayId: "shared-blue",
        targetGatewayId: "run-alice-12345678",
        sizingTier: "s",
      }),
      new Map(),
      new Map(),
      now,
    )).toMatchObject({
      lifecycle: "provisioning",
      stale: true,
      targetGatewayId: "run-alice-12345678",
      wakeDurationMs: 20 * 60_000,
    });
  });

  it("freezes wake duration at cutover and never marks an active runtime stale", () => {
    expect(projectBuilderRuntime(
      user({
        leaseId: "lease-1",
        generation: 1,
        status: "active",
        cause: "ticket",
        requestedAt: now - 20 * 60_000,
        activeAt: now - 19 * 60_000,
        sourceGatewayId: "shared-blue",
        targetGatewayId: "run-alice-12345678",
        sizingTier: "xs",
      }),
      new Map(),
      new Map(),
      now,
    )).toMatchObject({
      lifecycle: "active",
      wakeDurationMs: 60_000,
      stale: false,
    });
  });

  it.each([
    ["running", "retiring", null],
    ["failed", "failed", "helm uninstall timed out"],
  ] as const)(
    "projects a %s teardown receipt as %s",
    (operationStatus, lifecycle, error) => {
      const targetGatewayId = "run-alice-12345678";
      const operationId = `placement-retire-uid-alice-${targetGatewayId}`;
      const projected = projectBuilderRuntime(
        user({
          leaseId: "lease-1",
          generation: 1,
          status: "returning",
          requestedAt: now - 300_000,
          returningAt: now - 30_000,
          sourceGatewayId: "shared-blue",
          targetGatewayId,
          sizingTier: "xs",
        }),
        new Map([[targetGatewayId, {
          gatewayId: targetGatewayId,
          desiredStatus: "retired",
        }]]),
        new Map([[operationId, {
          status: operationStatus,
          ...(error ? { error } : {}),
        }]]),
        now,
      );

      expect(projected).toMatchObject({
        lifecycle,
        phase: "retirement",
        operationId,
        error,
      });
    },
  );

  it("keeps a failed activation visible after its target cleanup is retired", () => {
    const targetGatewayId = "run-alice-12345678";
    const activationOperationId = `builder-activate-${targetGatewayId}`;
    const cleanupOperationId = `placement-retire-uid-alice-${targetGatewayId}`;
    const projected = projectBuilderRuntime(
      user({
        leaseId: "lease-1",
        generation: 1,
        status: "failed",
        requestedAt: now - 300_000,
        failedAt: now - 10_000,
        sourceGatewayId: "shared-blue",
        targetGatewayId,
        sizingTier: "xs",
        activationOperationId,
        lastError: {
          message: "restore target failed",
          operationId: activationOperationId,
        },
      }),
      new Map([[targetGatewayId, {
        gatewayId: targetGatewayId,
        desiredStatus: "retired",
        retirementClaim: { operationId: cleanupOperationId },
      }]]),
      new Map([
        [activationOperationId, {
          status: "failed",
          error: "restore target failed",
          steps: [
            { name: "restore-target", status: "failed" },
            { name: "cutover", status: "pending" },
            { secret: "drop-me" },
          ],
        }],
        [cleanupOperationId, {
          status: "running",
          steps: [{ name: "helm-uninstall", status: "running" }],
        }],
      ]),
      now,
    );

    expect(projected).toMatchObject({
      lifecycle: "failed",
      phase: "activation",
      operationId: activationOperationId,
      operationStatus: "failed",
      operationSteps: [
        { name: "restore-target", status: "failed" },
        { name: "cutover", status: "pending" },
      ],
      cleanupOperationId,
      cleanupOperationStatus: "running",
      cleanupOperationSteps: [
        { name: "helm-uninstall", status: "running" },
      ],
      cleanupError: null,
      error: "restore target failed",
    });
  });

  it("omits parked leases after teardown receipts have completed", () => {
    expect(projectBuilderRuntime(
      user({
        leaseId: "lease-1",
        generation: 1,
        status: "parked",
        requestedAt: now - 300_000,
      }),
      new Map(),
      new Map(),
      now,
    )).toBeNull();
  });

  it("keeps a parked lease visible until its disposable teardown completes", () => {
    const targetGatewayId = "run-alice-12345678";
    const operationId = `placement-retire-uid-alice-${targetGatewayId}`;
    expect(projectBuilderRuntime(
      user({
        leaseId: "lease-1",
        generation: 1,
        status: "parked",
        requestedAt: now - 300_000,
        activeAt: now - 240_000,
        sourceGatewayId: "shared-blue",
        targetGatewayId,
      }),
      new Map([[targetGatewayId, {
        gatewayId: targetGatewayId,
        desiredStatus: "retired",
        retirementClaim: { operationId },
      }]]),
      new Map([[operationId, { status: "running" }]]),
      now,
    )).toMatchObject({
      lifecycle: "retiring",
      phase: "retirement",
      operationId,
      operationStatus: "running",
    });
  });

  it("omits a parked lease after its disposable teardown succeeds", () => {
    const targetGatewayId = "run-alice-12345678";
    const operationId = `placement-retire-uid-alice-${targetGatewayId}`;
    expect(projectBuilderRuntime(
      user({
        leaseId: "lease-1",
        generation: 1,
        status: "parked",
        requestedAt: now - 300_000,
        sourceGatewayId: "shared-blue",
        targetGatewayId,
      }),
      new Map([[targetGatewayId, {
        gatewayId: targetGatewayId,
        desiredStatus: "retired",
        retirementClaim: { operationId },
      }]]),
      new Map([[operationId, { status: "succeeded" }]]),
      now,
    )).toBeNull();
  });
});

describe("projectDisposableFleetCapacity", () => {
  it("counts only allocated disposable pods without inventing node disk allocation", () => {
    const gateways = [
      projectGatewaySummary(
        { id: "shared-blue", data: () => ({ gatewayId: "shared-blue" }) },
        { gatewayId: "shared-blue", gatewayClass: "shared" },
        Date.now(),
      ),
      projectGatewaySummary(
        { id: "run-alice", data: () => ({ gatewayId: "run-alice" }) },
        {
          gatewayId: "run-alice",
          gatewayClass: "operator",
          sizingTier: "xs",
          ownerUid: "uid-alice",
          allocation: {
            kind: "disposable-builder",
            schemaVersion: 1,
            leaseId: "lease-1",
            generation: 1,
            claimedByUid: "uid-alice",
          },
        },
        Date.now(),
      ),
    ];

    expect(projectDisposableFleetCapacity(gateways)).toEqual({
      disposableInstances: 1,
      stagedInstances: 0,
      namedReservations: 0,
      byTier: { xs: 1 },
      parkedBuilders: 0,
      byLifecycle: {
        requested: 0,
        provisioning: 0,
        activating: 0,
        active: 0,
        returning: 0,
        retiring: 0,
        failed: 0,
        parked: 0,
      },
      failedBuilders: 0,
      staleActivations: 0,
      oldestActivationAgeMs: null,
    });
  });
});

function valueAtPath(data: Record<string, unknown>, path: string): unknown {
  let cursor: unknown = data;
  for (const part of path.split(".")) {
    if (!cursor || typeof cursor !== "object") return undefined;
    cursor = (cursor as Record<string, unknown>)[part];
  }
  return cursor;
}

function docsFrom(records: Record<string, Record<string, unknown>>) {
  return Object.entries(records).map(([id, data]) => ({ id, data: () => data }));
}

function applyDottedPatch(
  target: Record<string, unknown>,
  patch: Record<string, unknown>,
): void {
  for (const [path, value] of Object.entries(patch)) {
    const parts = path.split(".");
    let cursor = target;
    for (const part of parts.slice(0, -1)) {
      const current = cursor[part];
      if (!current || typeof current !== "object" || Array.isArray(current)) {
        cursor[part] = {};
      }
      cursor = cursor[part] as Record<string, unknown>;
    }
    cursor[parts.at(-1)!] = value;
  }
}

function mkCollection(
  records: Record<string, Record<string, unknown>>,
  createId?: () => string,
) {
  const query = (filters: Array<{ field: string; op: string; value: unknown }> = []) => ({
    where: vi.fn((field: string, op: string, value: unknown) =>
      query([...filters, { field, op, value }]),
    ),
    orderBy: vi.fn(() => query(filters)),
    limit: vi.fn(() => query(filters)),
    get: vi.fn(async () => ({
      docs: docsFrom(records).filter((doc) =>
        filters.every((filter) => {
          const actual = valueAtPath(doc.data(), filter.field);
          return filter.op === "in" && Array.isArray(filter.value)
            ? filter.value.includes(actual)
            : actual === filter.value;
        }),
      ),
      size: docsFrom(records).filter((doc) =>
        filters.every((filter) => {
          const actual = valueAtPath(doc.data(), filter.field);
          return filter.op === "in" && Array.isArray(filter.value)
            ? filter.value.includes(actual)
            : actual === filter.value;
        }),
      ).length,
    })),
    add: vi.fn(async (data: Record<string, unknown>) => {
      if (!createId) throw new Error("collection is read-only in this test harness");
      const id = createId();
      records[id] = data;
      return { id };
    }),
    doc: vi.fn((id: string) => ({
      get: vi.fn(async () => ({
        id,
        exists: records[id] !== undefined,
        data: () => records[id],
      })),
      delete: vi.fn(async () => {
        delete records[id];
      }),
      update: vi.fn(async (patch: Record<string, unknown>) => {
        if (!records[id]) throw new Error(`missing record ${id}`);
        applyDottedPatch(records[id], patch);
      }),
    })),
  });
  return query();
}

function mkAdminFleetRouteApp(opts: {
  config: Record<string, unknown>;
  users: Record<string, Record<string, unknown>>;
  glmGateways?: Record<string, Record<string, unknown>>;
  gateways?: Record<string, Record<string, unknown>>;
  operations?: Record<string, Record<string, unknown>>;
  podDiagnostics?: Record<string, GatewayPodDiagnostics>;
  // gateways/{gatewayId}/assignments/{uid} durable roster docs (PR7).
  assignments?: Record<string, Record<string, Record<string, unknown>>>;
}) {
  const state = {
    config: { ...opts.config },
    users: { ...opts.users },
    operations: { ...(opts.operations ?? {}) },
  };
  let operationId = 0;
  const assignmentDocs = Object.values(opts.assignments ?? {}).flatMap((byUid) =>
    Object.entries(byUid).map(([uid, data]) => ({ id: uid, data: () => data })),
  );
  const db = {
    doc: vi.fn((path: string) => {
      const assignment = /^gateways\/([^/]+)\/assignments\/([^/]+)$/.exec(path);
      if (assignment) {
        const [, gatewayId, uid] = assignment;
        const data = opts.assignments?.[gatewayId]?.[uid];
        return {
          get: vi.fn(async () => ({
            exists: data !== undefined,
            data: () => data,
          })),
        };
      }
      expect(path).toBe("config/orchestrator");
      return {
        get: vi.fn(async () => ({
          exists: true,
          data: () => state.config,
        })),
        set: vi.fn(async (update: Record<string, unknown>) => {
          state.config = { ...state.config, ...update };
        }),
      };
    }),
    collection: vi.fn((name: string) => {
      if (name === "users") return mkCollection(state.users);
      if (name === GLM_GATEWAYS_COLLECTION) return mkCollection(opts.glmGateways ?? {});
      if (name === "gateways") return mkCollection(opts.gateways ?? {});
      if (name === GLM_OPERATIONS_COLLECTION) {
        return mkCollection(state.operations, () => `operation-${++operationId}`);
      }
      return mkCollection({});
    }),
    runTransaction: vi.fn(async (body: (transaction: {
      get: (ref: { get: () => Promise<unknown> }) => Promise<unknown>;
      delete: (ref: { delete: () => Promise<void> }) => void;
      update: (
        ref: { update: (patch: Record<string, unknown>) => Promise<void> },
        patch: Record<string, unknown>,
      ) => void;
    }) => Promise<unknown>) => {
      const pendingDeletes: Array<() => Promise<void>> = [];
      const pendingUpdates: Array<() => Promise<void>> = [];
      const result = await body({
        get: (ref) => ref.get(),
        delete: (ref) => {
          pendingDeletes.push(() => ref.delete());
        },
        update: (ref, patch) => {
          pendingUpdates.push(() => ref.update(patch));
        },
      });
      for (const update of pendingUpdates) await update();
      for (const remove of pendingDeletes) await remove();
      return result;
    }),
    collectionGroup: vi.fn((name: string) => ({
      get: vi.fn(async () => ({
        docs: name === "assignments" ? assignmentDocs : [],
        size: name === "assignments" ? assignmentDocs.length : 0,
      })),
    })),
  } as unknown as Firestore;

  const app = express();
  app.use(express.json());
  addAdminFleetRoutes(app, {
    db,
    logger: { info: vi.fn(), warn: vi.fn() },
    workspaceSlugsForUser: (data) => data.username ? [data.username] : [],
    provisionGatewayAuthSecret: vi.fn(async () => ({})),
    listGatewayBuilds: vi.fn(async () => []),
    ...(opts.podDiagnostics
      ? {
          readGatewayPodDiagnostics: vi.fn(async (gatewayId: string) =>
            opts.podDiagnostics?.[gatewayId] ?? {
              status: "unknown",
              totalPods: 0,
              readyPods: 0,
              totalRestarts: 0,
              pods: [],
              error: "diagnostics unavailable",
            }),
        }
      : {}),
    suspendAuthUser: vi.fn(async () => undefined),
    revokeConnectorGrantsForUser: vi.fn(async () => undefined),
  });
  app.use((error: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(500).json({ error: error.message });
  });
  return { app, state };
}

describe("retired operator reservation routes", () => {
  it.each([
    ["get", "/operator-gateway-reservations"],
    ["delete", "/operator-gateway-reservations/uid-orphan"],
    ["post", "/operator-gateway-reservations/uid-orphan/activate"],
    ["post", "/operator-gateway-reservations/uid-orphan/fulfill"],
    ["patch", "/fleet-settings"],
  ] as const)("returns 404 for %s %s", async (method, path) => {
    const { app } = mkAdminFleetRouteApp({ config: {}, users: {} });
    await request(app)[method](path).send({}).expect(404);
  });
});

function durableGatewayRoot(
  gatewayId: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    gatewayId,
    createdAt: 1,
    createdBy: "test",
    updatedAt: 1,
    updatedBy: "test",
    latestRelease: 1,
    desiredRelease: 1,
    liveRelease: null,
    liveRevisionId: null,
    trafficRevisionId: null,
    desiredStatus: "running",
    roll: null,
    configSchemaVersion: 1,
    profile: null,
    gatewayClass: "shared",
    imageProfile: "standard",
    sizingTier: null,
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
    ...overrides,
  };
}

describe("fleet gateway projection", () => {
  it("keeps disposable retirement intent and Builder lifecycle in the Fleet response", async () => {
    const targetGatewayId = "run-alice-12345678";
    const retirementOperationId = `placement-retire-uid-alice-${targetGatewayId}`;
    const { app } = mkAdminFleetRouteApp({
      config: { defaultGatewayId: "shared-blue" },
      users: {
        "uid-alice": {
          username: "alice",
          provisioning: {
            openclaw: {
              slug: "alice",
              gatewayId: "shared-blue",
              activationLease: {
                leaseId: "lease-1",
                generation: 1,
                status: "parked",
                cause: "run-start",
                requestedAt: Date.now() - 120_000,
                activeAt: Date.now() - 90_000,
                sourceGatewayId: "shared-blue",
                targetGatewayId,
                sizingTier: "xs",
              },
            },
          },
        },
      },
      gateways: {
        "shared-blue": durableGatewayRoot("shared-blue"),
        [targetGatewayId]: durableGatewayRoot(targetGatewayId, {
          desiredStatus: "retired",
          profile: "operator",
          gatewayClass: "operator",
          imageProfile: "operator",
          sizingTier: "xs",
          ownerUid: "uid-alice",
          builderSlug: "alice",
          allocation: {
            kind: "disposable-builder",
            schemaVersion: 1,
            leaseId: "lease-1",
            generation: 1,
            claimedByUid: "uid-alice",
          },
        }),
      },
      operations: {
        [retirementOperationId]: {
          kind: "retire-gateway",
          status: "running",
          input: { gatewayId: targetGatewayId },
        },
      },
    });

    const fleet = await request(app).get("/gateways").expect(200);

    expect(fleet.body.builderRuntimes).toEqual([
      expect.objectContaining({
        uid: "uid-alice",
        builderSlug: "alice",
        lifecycle: "retiring",
        phase: "retirement",
        targetGatewayId,
        operationId: retirementOperationId,
        operationStatus: "running",
      }),
    ]);
    expect(fleet.body.gateways).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          gatewayId: targetGatewayId,
          desiredStatus: "retired",
          disposableRuntime: {
            ownerUid: "uid-alice",
            leaseId: "lease-1",
            generation: 1,
          },
        }),
      ]),
    );
    expect(fleet.body.disposableCapacity).toEqual({
      disposableInstances: 1,
      stagedInstances: 0,
      namedReservations: 0,
      byTier: { xs: 1 },
      parkedBuilders: 1,
      byLifecycle: {
        requested: 0,
        provisioning: 0,
        activating: 0,
        active: 0,
        returning: 0,
        retiring: 1,
        failed: 0,
        parked: 1,
      },
      failedBuilders: 0,
      staleActivations: 0,
      oldestActivationAgeMs: null,
    });
  });

  it("keeps a failed activation target in Fleet until its cleanup operation succeeds", async () => {
    const targetGatewayId = "run-alice-failed";
    const activationOperationId = "builder-activate-run-alice-failed";
    const cleanupOperationId = "placement-retire-uid-alice-run-alice-failed";
    const { app } = mkAdminFleetRouteApp({
      config: { defaultGatewayId: "shared-blue" },
      users: {
        "uid-alice": {
          username: "alice",
          provisioning: {
            openclaw: {
              slug: "alice",
              gatewayId: "shared-blue",
              activationLease: {
                leaseId: "lease-1",
                generation: 1,
                status: "failed",
                requestedAt: Date.now() - 120_000,
                failedAt: Date.now() - 30_000,
                sourceGatewayId: "shared-blue",
                targetGatewayId,
                sizingTier: "xs",
                activationOperationId,
                lastError: { message: "restore failed" },
              },
            },
          },
        },
      },
      gateways: {
        "shared-blue": durableGatewayRoot("shared-blue"),
        [targetGatewayId]: durableGatewayRoot(targetGatewayId, {
          desiredStatus: "retired",
          profile: "operator",
          gatewayClass: "operator",
          imageProfile: "operator",
          sizingTier: "xs",
          ownerUid: "uid-alice",
          builderSlug: "alice",
          allocation: {
            kind: "disposable-builder",
            schemaVersion: 1,
            leaseId: "lease-1",
            generation: 1,
            claimedByUid: "uid-alice",
          },
          retirementClaim: { operationId: cleanupOperationId },
        }),
      },
      operations: {
        [activationOperationId]: {
          kind: "migrate-customer",
          status: "failed",
          error: "restore failed",
        },
        [cleanupOperationId]: {
          kind: "retire-gateway",
          status: "running",
          input: { gatewayId: targetGatewayId },
        },
      },
    });

    const fleet = await request(app).get("/gateways").expect(200);

    expect(fleet.body.builderRuntimes).toEqual([
      expect.objectContaining({
        lifecycle: "failed",
        phase: "activation",
        operationId: activationOperationId,
        cleanupOperationId,
        cleanupOperationStatus: "running",
      }),
    ]);
    expect(fleet.body.gateways).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          gatewayId: targetGatewayId,
          desiredStatus: "retired",
        }),
      ]),
    );
    expect(fleet.body.disposableCapacity.disposableInstances).toBe(1);
  });

  it("offers retry only after the retired target has an explicit zero-pod proof", async () => {
    const targetGatewayId = "run-alice-clean";
    const activationOperationId = "builder-activate-run-alice-clean";
    const cleanupOperationId = "placement-retire-uid-alice-run-alice-clean";
    const { app } = mkAdminFleetRouteApp({
      config: { defaultGatewayId: "shared-blue" },
      users: {
        "uid-alice": {
          username: "alice",
          provisioning: {
            openclaw: {
              slug: "alice",
              gatewayId: "shared-blue",
              activationLease: {
                leaseId: "lease-1",
                generation: 1,
                status: "failed",
                requestedAt: Date.now() - 120_000,
                failedAt: Date.now() - 30_000,
                sourceGatewayId: "shared-blue",
                targetGatewayId,
                sizingTier: "xs",
                activationOperationId,
              },
            },
          },
        },
      },
      gateways: {
        "shared-blue": durableGatewayRoot("shared-blue"),
        [targetGatewayId]: durableGatewayRoot(targetGatewayId, {
          desiredStatus: "retired",
          profile: "operator",
          gatewayClass: "operator",
          imageProfile: "operator",
          sizingTier: "xs",
          ownerUid: "uid-alice",
          builderSlug: "alice",
          allocation: {
            kind: "disposable-builder",
            schemaVersion: 1,
            leaseId: "lease-1",
            generation: 1,
            claimedByUid: "uid-alice",
          },
          retirementClaim: { operationId: cleanupOperationId },
        }),
      },
      operations: {
        [activationOperationId]: {
          kind: "migrate-customer",
          status: "failed",
        },
        [cleanupOperationId]: {
          kind: "retire-gateway",
          status: "succeeded",
          input: { gatewayId: targetGatewayId },
        },
      },
      podDiagnostics: {
        "shared-blue": {
          status: "ready",
          totalPods: 1,
          readyPods: 1,
          totalRestarts: 0,
          pods: [],
        },
        [targetGatewayId]: {
          status: "missing",
          totalPods: 0,
          readyPods: 0,
          totalRestarts: 0,
          pods: [],
        },
      },
    });

    const fleet = await request(app).get("/gateways").expect(200);

    expect(fleet.body.builderRuntimes).toEqual([
      expect.objectContaining({
        lifecycle: "failed",
        retryAvailable: true,
        targetPodStatus: "missing",
        targetPodCount: 0,
      }),
    ]);
  });

  it("withholds retry until the disposable cleanup operation succeeds", async () => {
    const targetGatewayId = "run-alice-cleaning";
    const cleanupOperationId = "placement-retire-uid-alice-run-alice-cleaning";
    const { app } = mkAdminFleetRouteApp({
      config: { defaultGatewayId: "shared-blue" },
      users: {
        "uid-alice": {
          username: "alice",
          provisioning: {
            openclaw: {
              gatewayId: "shared-blue",
              activationLease: {
                leaseId: "lease-1",
                generation: 1,
                status: "failed",
                requestedAt: Date.now() - 120_000,
                failedAt: Date.now() - 30_000,
                sourceGatewayId: "shared-blue",
                targetGatewayId,
                sizingTier: "xs",
              },
            },
          },
        },
      },
      gateways: {
        "shared-blue": durableGatewayRoot("shared-blue"),
        [targetGatewayId]: durableGatewayRoot(targetGatewayId, {
          desiredStatus: "retired",
          profile: "operator",
          gatewayClass: "operator",
          imageProfile: "operator",
          sizingTier: "xs",
          ownerUid: "uid-alice",
          builderSlug: "alice",
          allocation: {
            kind: "disposable-builder",
            schemaVersion: 1,
            leaseId: "lease-1",
            generation: 1,
            claimedByUid: "uid-alice",
          },
          retirementClaim: { operationId: cleanupOperationId },
        }),
      },
      operations: {
        [cleanupOperationId]: {
          kind: "retire-gateway",
          status: "running",
          input: { gatewayId: targetGatewayId },
        },
      },
      podDiagnostics: {
        [targetGatewayId]: {
          status: "missing",
          totalPods: 0,
          readyPods: 0,
          totalRestarts: 0,
          pods: [],
        },
      },
    });

    const fleet = await request(app).get("/gateways").expect(200);

    expect(fleet.body.builderRuntimes).toEqual([
      expect.objectContaining({
        lifecycle: "failed",
        cleanupOperationStatus: "running",
        retryAvailable: false,
      }),
    ]);
  });

  it("keeps an old disposable visible after a new lease replaces the user target", async () => {
    const oldGatewayId = "run-alice-old";
    const cleanupOperationId = "placement-retire-uid-alice-run-alice-old";
    const { app } = mkAdminFleetRouteApp({
      config: { defaultGatewayId: "shared-blue" },
      users: {
        "uid-alice": {
          username: "alice",
          provisioning: {
            openclaw: {
              gatewayId: "shared-blue",
              activationLease: {
                leaseId: "lease-new",
                generation: 2,
                status: "requested",
                requestedAt: Date.now(),
                sourceGatewayId: "shared-blue",
              },
            },
          },
        },
      },
      gateways: {
        [oldGatewayId]: durableGatewayRoot(oldGatewayId, {
          desiredStatus: "retired",
          profile: "operator",
          gatewayClass: "operator",
          imageProfile: "operator",
          sizingTier: "xs",
          ownerUid: "uid-alice",
          builderSlug: "alice",
          allocation: {
            kind: "disposable-builder",
            schemaVersion: 1,
            leaseId: "lease-old",
            generation: 1,
            claimedByUid: "uid-alice",
          },
          retirementClaim: { operationId: cleanupOperationId },
        }),
      },
      operations: {
        [cleanupOperationId]: {
          kind: "retire-gateway",
          status: "running",
          input: { gatewayId: oldGatewayId },
        },
      },
    });

    const fleet = await request(app).get("/gateways").expect(200);

    expect(fleet.body.gateways).toEqual([
      expect.objectContaining({ gatewayId: oldGatewayId, desiredStatus: "retired" }),
    ]);
    expect(fleet.body.disposableCapacity.disposableInstances).toBe(1);
  });

  it("summarizes parked Builders, lifecycle failures, staleness, and oldest activation", async () => {
    const now = Date.now();
    const { app } = mkAdminFleetRouteApp({
      config: { defaultGatewayId: "shared-blue" },
      users: {
        parked: {
          provisioning: {
            openclaw: {
              gatewayId: "shared-blue",
              activationLease: {
                leaseId: "lease-parked",
                generation: 1,
                status: "parked",
              },
            },
          },
        },
        requested: {
          provisioning: {
            openclaw: {
              gatewayId: "shared-blue",
              activationLease: {
                leaseId: "lease-requested",
                generation: 1,
                status: "requested",
                requestedAt: now - 20 * 60_000,
              },
            },
          },
        },
        failed: {
          provisioning: {
            openclaw: {
              gatewayId: "shared-blue",
              activationLease: {
                leaseId: "lease-failed",
                generation: 1,
                status: "failed",
                requestedAt: now - 60_000,
                failedAt: now - 30_000,
              },
            },
          },
        },
      },
    });

    const fleet = await request(app).get("/gateways").expect(200);

    expect(fleet.body.disposableCapacity).toMatchObject({
      parkedBuilders: 1,
      byLifecycle: {
        requested: 1,
        failed: 1,
        parked: 1,
      },
      failedBuilders: 1,
      staleActivations: 1,
    });
    expect(fleet.body.disposableCapacity.oldestActivationAgeMs).toBeGreaterThanOrEqual(
      20 * 60_000,
    );
  });

  it("does not revive stale bare runtime state when an existing root is malformed", async () => {
    const { app } = mkAdminFleetRouteApp({
      config: { defaultGatewayId: "default" },
      users: {
        "uid-alice": {
          username: "alice",
          email: "alice@example.com",
          provisioning: { openclaw: { slug: "alice", gatewayId: "default" } },
        },
      },
      gateways: {
        default: {
          gatewayId: "default",
          latestRelease: 1,
          desiredRelease: 1,
          desiredStatus: "running",
          status: "ready",
          mountedCustomers: ["alice"],
        },
      },
      glmGateways: {
        default: {
          gatewayId: "default",
          desiredStatus: "running",
          gatewayClass: "shared",
          heartbeat: { status: "ready", mountedCustomers: ["alice"] },
        },
      },
    });

    const fleet = await request(app).get("/gateways").expect(200);
    expect(fleet.body.gateways).toEqual([]);

    const onboarding = await request(app).get("/onboarding-placement").expect(200);
    expect(onboarding.body.warnings).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "default-gateway-missing" })]),
    );
    expect(onboarding.body.customers).toEqual([
      expect.objectContaining({
        uid: "uid-alice",
        mountedGatewayId: null,
        driftState: "missing-gateway",
      }),
    ]);
  });

  it("keeps the durable gateway ID while reading telemetry from its exact live revision", async () => {
    const { app } = mkAdminFleetRouteApp({
      config: { defaultGatewayId: "default" },
      users: {
        "uid-alice": {
          username: "alice",
          email: "alice@example.com",
          provisioning: { openclaw: { slug: "alice", gatewayId: "default" } },
        },
      },
      gateways: {
        default: durableGatewayRoot("default", {
          liveRelease: 1,
        }),
      },
      glmGateways: {
        default: {
          docKind: "runtime",
          gatewayId: "default",
          release: 1,
          lifecycle: "serving",
          helm: {
            imageRepository: "us-central1-docker.pkg.dev/octogee/octogee/gateway",
            imageTag: "1234567",
          },
          heartbeat: {
            status: "ready",
            mountedCustomers: ["alice"],
            version: "1234567",
            lastHeartbeatAt: 1_000,
            startedAt: 500,
          },
          lastError: { message: null, at: null },
        },
      },
    });

    const fleet = await request(app).get("/gateways").expect(200);
    expect(fleet.body.gateways).toEqual([
      expect.objectContaining({
        gatewayId: "default",
        status: "ready",
        mountedCustomers: ["alice"],
      }),
    ]);

    const onboarding = await request(app).get("/onboarding-placement").expect(200);
    expect(onboarding.body.warnings).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "default-gateway-missing" })]),
    );
    expect(onboarding.body.customers).toEqual([
      expect.objectContaining({
        uid: "uid-alice",
        assignedGatewayId: "default",
        mountedGatewayId: "default",
        driftState: "healthy",
      }),
    ]);

    const distribution = await request(app).get("/customer-distribution").expect(200);
    expect(distribution.body.perGateway).toEqual([
      expect.objectContaining({
        gatewayId: "default",
        status: "ready",
        assignedCount: 1,
        mountedCount: 1,
      }),
    ]);

    const details = await request(app).get("/gateways/default/details").expect(200);
    expect(details.body.mountedCustomers).toEqual([
      expect.objectContaining({ uid: "uid-alice", slug: "alice" }),
    ]);
  });

  it("renders one fleet entry per durable gateway from its bare-id runtime doc", async () => {
    const { app } = mkAdminFleetRouteApp({
      config: { defaultGatewayId: "default" },
      users: {},
      gateways: {
        default: durableGatewayRoot("default", {
          latestRelease: 2,
          desiredRelease: 2,
          liveRelease: 2,
        }),
        bender: durableGatewayRoot("bender", {
          latestRelease: 2,
          desiredRelease: 2,
          liveRelease: 2,
        }),
      },
      glmGateways: {
        bender: {
          docKind: "runtime",
          gatewayId: "bender",
          release: 2,
          lifecycle: "serving",
          helm: {
            imageRepository: "us-central1-docker.pkg.dev/octogee/octogee/gateway",
            imageTag: "1234567",
          },
          heartbeat: { status: "ready", mountedCustomers: ["ceckert"] },
          lastError: { message: null, at: null },
        },
        default: {
          docKind: "runtime",
          gatewayId: "default",
          release: 2,
          lifecycle: "serving",
          helm: {
            imageRepository: "us-central1-docker.pkg.dev/octogee/octogee/gateway",
            imageTag: "1234567",
          },
          heartbeat: { status: "ready", mountedCustomers: ["alice"] },
          lastError: { message: null, at: null },
        },
      },
    });

    const res = await request(app).get("/gateways").expect(200);

    expect(res.body.gateways.map((gateway: { gatewayId: string }) => gateway.gatewayId).sort()).toEqual([
      "bender",
      "default",
    ]);
  });

  it("counts intentionally paused gateways separately from unreachable gateways", async () => {
    const { app } = mkAdminFleetRouteApp({
      config: { defaultGatewayId: "default" },
      users: {},
      gateways: {
        default: durableGatewayRoot("default", { liveRelease: 1 }),
        standby: durableGatewayRoot("standby", { desiredStatus: "paused", liveRelease: 1 }),
      },
      glmGateways: {
        default: {
          docKind: "runtime",
          gatewayId: "default",
          release: 1,
          lifecycle: "serving",
          desiredStatus: "running",
          helm: {
            imageRepository: "us-central1-docker.pkg.dev/octogee/octogee/gateway",
            imageTag: "1234567",
          },
          heartbeat: { status: "ready", mountedCustomers: [], lastHeartbeatAt: Date.now() },
        },
        standby: {
          docKind: "runtime",
          gatewayId: "standby",
          release: 1,
          lifecycle: "serving",
          desiredStatus: "paused",
          helm: {
            imageRepository: "us-central1-docker.pkg.dev/octogee/octogee/gateway",
            imageTag: "1234567",
          },
          heartbeat: { status: "ready", mountedCustomers: [], lastHeartbeatAt: 1 },
        },
      },
    });

    const res = await request(app).get("/gateways").expect(200);

    expect(res.body.stats.gateways).toEqual({
      total: 2,
      ready: 1,
      paused: 1,
      unreachable: 0,
    });
  });

  it("rejects termination when the canonical shared assignment is missing", async () => {
    const { app, state } = mkAdminFleetRouteApp({
      config: { defaultGatewayId: "shared-blue" },
      users: {
        "uid-alice": {
          provisioning: {
            openclaw: {
              gatewayId: "shared-blue",
              activationLease: {
                leaseId: "lease-1",
                generation: 3,
                status: "failed",
                targetGatewayId: "run-alice",
              },
            },
          },
        },
      },
      gateways: {
        "run-alice": {
          gatewayId: "run-alice",
          ownerUid: "uid-alice",
          allocation: {
            kind: "disposable-builder",
            leaseId: "lease-1",
            generation: 3,
            claimedByUid: "uid-alice",
          },
        },
      },
    });

    await request(app)
      .post("/customers/uid-alice/activation-lease/terminate")
      .send({ leaseId: "lease-1", generation: 3 })
      .expect(409);

    expect(state.users["uid-alice"]).toMatchObject({
      provisioning: {
        openclaw: {
          activationLease: {
            status: "failed",
          },
        },
      },
    });
  });
});

describe("manual disposable runtime return", () => {
  it("records an idempotent return request against the exact active lease generation", async () => {
    const { app, state } = mkAdminFleetRouteApp({
      config: { defaultGatewayId: "shared-blue" },
      users: {
        "uid-alice": {
          username: "alice",
          provisioning: {
            openclaw: {
              gatewayId: "run-alice",
              slug: "alice",
              activationLease: {
                leaseId: "lease-1",
                generation: 3,
                status: "active",
                targetGatewayId: "run-alice",
              },
            },
          },
        },
      },
    });

    await request(app)
      .post("/customers/uid-alice/activation-lease/return")
      .send({ leaseId: "lease-1", generation: 3 })
      .expect(202);
    const duplicate = await request(app)
      .post("/customers/uid-alice/activation-lease/return")
      .send({ leaseId: "lease-1", generation: 3 })
      .expect(200);

    expect(duplicate.body).toMatchObject({
      status: "return-requested",
      leaseId: "lease-1",
      generation: 3,
      adopted: true,
    });
    expect(state.users["uid-alice"]).toMatchObject({
      provisioning: {
        openclaw: {
          activationLease: {
            returnRequestedBy: "unknown",
            returnRequestedAt: expect.any(Number),
          },
        },
      },
    });
  });

  it("rejects stale generations and caller-selected target gateways", async () => {
    const { app, state } = mkAdminFleetRouteApp({
      config: { defaultGatewayId: "shared-blue" },
      users: {
        "uid-alice": {
          username: "alice",
          provisioning: {
            openclaw: {
              gatewayId: "run-alice",
              activationLease: {
                leaseId: "lease-1",
                generation: 3,
                status: "active",
                targetGatewayId: "run-alice",
              },
            },
          },
        },
      },
    });

    await request(app)
      .post("/customers/uid-alice/activation-lease/return")
      .send({ leaseId: "lease-1", generation: 2 })
      .expect(409);
    await request(app)
      .post("/customers/uid-alice/activation-lease/return")
      .send({
        leaseId: "lease-1",
        generation: 3,
        targetGatewayId: "forged",
      })
      .expect(400);

    expect(state.users["uid-alice"]).not.toMatchObject({
      provisioning: {
        openclaw: {
          activationLease: {
            returnRequestedAt: expect.any(Number),
          },
        },
      },
    });
  });

  it("records an exact lifecycle-owned termination intent for a failed pre-cutover runtime", async () => {
    const { app, state } = mkAdminFleetRouteApp({
      config: { defaultGatewayId: "shared-blue" },
      users: {
        "uid-alice": {
          username: "alice",
          provisioning: {
            openclaw: {
              gatewayId: "shared-blue",
              activationLease: {
                leaseId: "lease-1",
                generation: 3,
                status: "failed",
                targetGatewayId: "run-alice",
              },
            },
          },
        },
      },
      gateways: {
        "run-alice": {
          gatewayId: "run-alice",
          ownerUid: "uid-alice",
          allocation: {
            kind: "disposable-builder",
            leaseId: "lease-1",
            generation: 3,
            claimedByUid: "uid-alice",
          },
        },
      },
      assignments: {
        "shared-blue": {
          "uid-alice": {
            uid: "uid-alice",
            gatewayId: "shared-blue",
            state: "serving",
            epoch: 4,
          },
        },
      },
    });

    await request(app)
      .post("/customers/uid-alice/activation-lease/terminate")
      .send({ leaseId: "lease-1", generation: 3 })
      .expect(202);

    expect(state.users["uid-alice"]).toMatchObject({
      provisioning: {
        openclaw: {
          activationLease: {
            status: "returning",
            operatorTerminateRequestedAt: expect.any(Number),
            operatorTerminateRequestedBy: "unknown",
          },
        },
      },
    });
  });
});

describe("onboarding placement (post-cohorts)", () => {
  it("labels in-flight operations with the builder slug and uid", async () => {
    const { app } = mkAdminFleetRouteApp({
      config: { defaultGatewayId: "default" },
      users: {
        "uid-alice": {
          username: "alice",
          email: "alice@example.com",
          provisioning: { openclaw: { slug: "alice", gatewayId: "default" } },
        },
      },
      glmGateways: { default: { gatewayClass: "shared", desiredStatus: "running" } },
      operations: {
        "operation-opaque-id": {
          kind: "migrate-customer",
          status: "pending",
          inputUid: "uid-alice",
          createdAt: 1_000,
        },
      },
    });

    const res = await request(app).get("/onboarding-placement").expect(200);

    expect(res.body.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "migration-in-flight",
          operationId: "operation-opaque-id",
          message: "migrate-customer alice (uid-alice) is pending",
        }),
      ]),
    );
  });

  it("excludes non-interactive accounts from the active Builder roster", async () => {
    const { app } = mkAdminFleetRouteApp({
      config: { defaultGatewayId: "default" },
      users: {
        "uid-active": {
          username: "active-builder",
          provisioning: { openclaw: { slug: "active-builder", gatewayId: "default" } },
        },
        "uid-scheduled": {
          username: "scheduled-builder",
          accountLifecycle: { status: "deletion_scheduled", eraseAfter: 1_800_000_000_000 },
          provisioning: { openclaw: { slug: "scheduled-builder", gatewayId: "default" } },
        },
        "uid-erasing": {
          username: "erasing-builder",
          accountLifecycle: { status: "erasing" },
          provisioning: { openclaw: { slug: "erasing-builder", gatewayId: "default" } },
        },
        "uid-suspended": {
          username: "suspended-builder",
          accountLifecycle: { status: "suspended" },
          provisioning: { openclaw: { slug: "suspended-builder", gatewayId: "default" } },
        },
      },
      glmGateways: { default: { gatewayClass: "shared", desiredStatus: "running" } },
      operations: {
        "erase-operation": {
          kind: "erase-customer",
          status: "pending",
          inputUid: "uid-scheduled",
          createdAt: 1_000,
        },
      },
    });

    const res = await request(app).get("/onboarding-placement").expect(200);

    expect(res.body.customers.map((customer: { uid: string }) => customer.uid)).toEqual([
      "uid-active",
    ]);
    expect(res.body.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "account-deletion-pending",
          uid: "uid-scheduled",
          slug: "scheduled-builder",
          operationId: "erase-operation",
          expiresAt: 1_800_000_000_000,
          message: "scheduled-builder (uid-scheduled) is scheduled for deletion",
        }),
      ]),
    );
  });

  it("returns the placement config with default-gateway warnings", async () => {
    const { app } = mkAdminFleetRouteApp({
      config: { defaultGatewayId: "gw-missing" },
      users: {},
      glmGateways: {
        "gw-shared": { gatewayClass: "shared", desiredStatus: "running" },
      },
    });

    const res = await request(app).get("/onboarding-placement").expect(200);

    expect(res.body.config).toEqual({ defaultGatewayId: "gw-missing" });
    expect(res.body.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "default-gateway-missing", gatewayId: "gw-missing" }),
      ]),
    );
    const shared = res.body.gateways.find(
      (g: { gatewayId: string }) => g.gatewayId === "gw-shared",
    );
    expect(shared).toMatchObject({ assignableAsDefault: false, defaultTarget: false });
  });

  it("surfaces the DURABLE roster state + epoch from the assignment doc", async () => {
    const { app } = mkAdminFleetRouteApp({
      config: { defaultGatewayId: "default" },
      users: {
        "uid-a": {
          username: "alice",
          email: "alice@example.com",
          provisioning: { openclaw: { slug: "alice", gatewayId: "default" } },
        },
      },
      glmGateways: { default: { gatewayClass: "shared", desiredStatus: "running" } },
      assignments: {
        default: {
          "uid-a": {
            uid: "uid-a",
            slug: "alice",
            gatewayId: "default",
            source: "migrate-customer",
            state: "quiescing",
            epoch: 5,
          },
        },
      },
    });

    const res = await request(app).get("/onboarding-placement").expect(200);
    const customer = res.body.customers.find((c: { uid: string }) => c.uid === "uid-a");
    expect(customer).toMatchObject({
      rosterState: "quiescing",
      rosterEpoch: 5,
    });
  });

  it("reports null roster fields for a customer with no assignment doc (legacy/un-backfilled)", async () => {
    const { app } = mkAdminFleetRouteApp({
      config: { defaultGatewayId: "default" },
      users: {
        "uid-a": {
          username: "alice",
          email: "alice@example.com",
          provisioning: { openclaw: { slug: "alice", gatewayId: "default" } },
        },
      },
      glmGateways: { default: { gatewayClass: "shared", desiredStatus: "running" } },
    });

    const res = await request(app).get("/onboarding-placement").expect(200);
    const customer = res.body.customers.find((c: { uid: string }) => c.uid === "uid-a");
    expect(customer).toMatchObject({
      rosterState: null,
      rosterEpoch: null,
    });
  });

  it("PATCH validates the target and queues active shared Builders without moving dedicated Builders", async () => {
    const { app, state } = mkAdminFleetRouteApp({
      config: { defaultGatewayId: "gw-old" },
      users: {
        "uid-shared": {
          username: "shared-builder",
          provisioning: { openclaw: { slug: "shared-builder", gatewayId: "gw-old" } },
        },
        "uid-dedicated": {
          username: "dedicated-builder",
          provisioning: { openclaw: { slug: "dedicated-builder", gatewayId: "gw-operator" } },
        },
        "uid-adopted": {
          username: "adopted-builder",
          provisioning: { openclaw: { slug: "adopted-builder", gatewayId: "gw-old" } },
        },
        "uid-deleting": {
          username: "deleting-builder",
          accountLifecycle: { status: "deletion_scheduled" },
          provisioning: { openclaw: { slug: "deleting-builder", gatewayId: "gw-old" } },
        },
      },
      glmGateways: {
        "gw-bare": { gatewayClass: "shared", desiredStatus: "running" },
        "gw-new": {
          docKind: "runtime",
          gatewayId: "gw-new",
          release: 1,
          lifecycle: "serving",
          helm: { imageRepository: "gateway", imageTag: "1234567" },
          heartbeat: { status: "ready", mountedCustomers: [] },
          lastError: { message: null, at: null },
        },
      },
      gateways: {
        "gw-old": durableGatewayRoot("gw-old"),
        "gw-new": durableGatewayRoot("gw-new"),
        "gw-builder": durableGatewayRoot("gw-builder", {
          gatewayClass: "builder",
          ownerUid: "uid-builder",
          builderSlug: "builder",
        }),
        "gw-operator": durableGatewayRoot("gw-operator", {
          gatewayClass: "operator",
          ownerUid: "uid-dedicated",
          builderSlug: "dedicated-builder",
        }),
      },
      operations: {
        "existing-migration": {
          kind: "migrate-customer",
          status: "running",
          inputUid: "uid-adopted",
          input: {
            uid: "uid-adopted",
            fromGatewayId: "gw-old",
            toGatewayId: "gw-new",
          },
        },
      },
    });

    const rejected = await request(app)
      .patch("/onboarding-placement")
      .send({ defaultGatewayId: "gw-builder" })
      .expect(400);
    expect(rejected.body.error).toContain("shared gateway");

    const bare = await request(app)
      .patch("/onboarding-placement")
      .send({ defaultGatewayId: "gw-bare" })
      .expect(400);
    expect(bare.body.error).toContain("desired state not found");

    const response = await request(app)
      .patch("/onboarding-placement")
      .send({ defaultGatewayId: "gw-new" })
      .expect(200);
    expect(state.config.defaultGatewayId).toBe("gw-new");
    expect(response.body.defaultChange).toMatchObject({
      previousGatewayId: "gw-old",
      targetGatewayId: "gw-new",
      enqueued: [{ uid: "uid-shared", operationId: "operation-1" }],
      adopted: [{ uid: "uid-adopted", operationId: "existing-migration" }],
      blocked: [],
      dedicatedUntouched: 1,
    });
    expect(state.operations["operation-1"]).toMatchObject({
      kind: "migrate-customer",
      status: "pending",
      input: {
        uid: "uid-shared",
        builderSlug: "shared-builder",
        fromGatewayId: "gw-old",
        toGatewayId: "gw-new",
        source: "platform-default-change",
      },
    });
  });

  it("ignores retired override data and exposes no override API", async () => {
    const { app } = mkAdminFleetRouteApp({
      config: { defaultGatewayId: "gw-default", overrides: { "uid-alice": "gw-canary" } },
      users: {
        "uid-alice": {
          username: "alice-old",
          email: "alice@example.com",
          provisioning: { openclaw: { slug: "alice" } },
        },
      },
      gateways: {
        "gw-default": durableGatewayRoot("gw-default"),
        "gw-canary": durableGatewayRoot("gw-canary"),
      },
    });

    const res = await request(app).get("/onboarding-placement").expect(200);

    expect(res.body.config).toEqual({ defaultGatewayId: "gw-default" });
    expect(res.body).not.toHaveProperty("overrides");
    expect(res.body.customers[0]).not.toHaveProperty("overrideGatewayId");

    await request(app)
      .put("/onboarding-placement/overrides/by-slug/alice")
      .send({ gatewayId: "gw-canary" })
      .expect(404);

    await request(app).delete("/onboarding-placement/overrides/uid-alice").expect(404);
  });

  it("does not report pointer drift for an operator-owned dedicated gateway outside onboarding placement", async () => {
    const { app } = mkAdminFleetRouteApp({
      config: { defaultGatewayId: "default-blue" },
      users: {
        "uid-ceckert": {
          username: "ceckert",
          email: "ceckert@example.com",
          builderSubscription: { tier: "pro", status: "active" },
          provisioning: {
            openclaw: {
              slug: "ceckert",
              gatewayId: "bender-blue",
              activationLease: {
                leaseId: "lease-one",
                generation: 1,
                status: "active",
                targetGatewayId: "bender-blue",
                requestedAt: 1_000,
                activeAt: 2_000,
              },
            },
          },
        },
      },
      glmGateways: {
        "default-blue": { gatewayId: "default-blue", gatewayClass: "shared", desiredStatus: "running" },
        "bender-blue": {
          gatewayId: "bender-blue",
          gatewayClass: "operator",
          desiredStatus: "running",
          ownerUid: "uid-ceckert",
          builderSlug: "ceckert",
          // Readiness/mounted telemetry relocated to glmGateways/{id}.heartbeat
          // (cutover step 2); the flat gateways/{id} writer is contracted.
          heartbeat: { status: "ready", mountedCustomers: ["ceckert"] },
        },
      },
    });

    const res = await request(app).get("/onboarding-placement").expect(200);

    const customer = res.body.customers.find((c: { uid: string }) => c.uid === "uid-ceckert");
    expect(customer).toMatchObject({
      uid: "uid-ceckert",
      assignedGatewayId: "bender-blue",
      mountedGatewayId: "bender-blue",
      policyTargetGatewayId: "bender-blue",
      driftState: "healthy",
    });
    expect(customer.warnings).toEqual([]);
    expect(res.body.driftSummary).toMatchObject({
      healthy: 1,
      "pointer-drift": 0,
    });
  });

  it("targets the Platform default when a stale dedicated assignment has no live entitlement", async () => {
    const { app } = mkAdminFleetRouteApp({
      config: { defaultGatewayId: "default-blue" },
      users: {
        "uid-stale": {
          username: "stale",
          provisioning: { openclaw: { slug: "stale", gatewayId: "stale-operator" } },
        },
      },
      glmGateways: {
        "default-blue": { gatewayId: "default-blue", gatewayClass: "shared", desiredStatus: "running" },
        "stale-operator": {
          gatewayId: "stale-operator",
          gatewayClass: "operator",
          desiredStatus: "running",
          ownerUid: "uid-stale",
          builderSlug: "stale",
          heartbeat: { status: "ready", mountedCustomers: ["stale"] },
        },
      },
    });

    const res = await request(app).get("/onboarding-placement").expect(200);

    expect(res.body.customers[0]).toMatchObject({
      uid: "uid-stale",
      policyTargetGatewayId: "default-blue",
      assignedGatewayId: "stale-operator",
      driftState: "pointer-drift",
    });
  });
});

describe("account deletion revokes connector grants at the provider first", () => {
  function makeDeleteApp(
    users: Record<string, Record<string, unknown>>,
    otherDocs: Record<string, Record<string, unknown>> = {},
  ) {
    const calls: string[] = [];
    const remaining = { ...users };
    const added: Record<string, unknown>[] = [];
    let autoId = 0;
    let transactionTail = Promise.resolve();
    const ref = (path: string) => ({
      id: path.split("/").at(-1)!,
      path,
      get: async () => ({
        id: path.split("/").at(-1)!,
        exists: path in otherDocs,
        data: () => otherDocs[path],
      }),
      collection: (name: string) => ref(`${path}/${name}`),
      doc: (id = `auto-${++autoId}`) => ref(`${path}/${id}`),
    });
    const queryCollection = (
      name: string,
      collectionGroup: boolean,
      filters: Array<{ field: string; value: unknown }> = [],
    ) => {
      const chain = {
        collectionName: name,
        where: (field: string, _op: string, value: unknown) =>
          queryCollection(name, collectionGroup, [...filters, { field, value }]),
        get: async () => ({
          docs: Object.entries(otherDocs)
            .filter(([path, data]) => {
              const parts = path.split("/");
              const inCollection = collectionGroup
                ? parts.at(-2) === name
                : parts.length === 2 && parts[0] === name;
              return inCollection && filters.every(({ field, value }) => {
                const actual = field.split(".").reduce<unknown>((current, part) =>
                  current && typeof current === "object"
                    ? (current as Record<string, unknown>)[part]
                    : undefined, data);
                return actual === value;
              });
            })
            .map(([path, data]) => ({
              id: path.split("/").at(-1)!,
              ref: ref(path),
              data: () => data,
            })),
        }),
        doc: (id = `op-${++autoId}`) => ref(`${name}/${id}`),
      };
      return chain;
    };
    const db = {
      collection: (name: string) => {
        if (name === "users") {
          return {
            doc: (id: string) => ({
              id,
              path: `users/${id}`,
              get: async () => ({
                id,
                exists: id in remaining,
                data: () => remaining[id],
              }),
              collection: (sub: string) => ref(`users/${id}/${sub}`),
            }),
          };
        }
        return queryCollection(name, false);
      },
      collectionGroup: (name: string) => queryCollection(name, true),
      batch: () => ({
        update: (target: { path?: string }, data: Record<string, unknown>) => {
          calls.push(`batch:update:${target.path ?? "unknown"}`);
          added.push(data);
        },
        set: (target: { path: string }, data: Record<string, unknown>) => {
          calls.push(`batch:set:${target.path.split("/")[0]}`);
          added.push(data);
        },
        delete: (target: { path: string }) => {
          calls.push(`batch:delete:${target.path}`);
        },
        commit: async () => {
          calls.push("batch:commit");
        },
      }),
      runTransaction: <T>(callback: (transaction: {
        get: (target: { path?: string; collectionName?: string }) => Promise<unknown>;
        update: (target: { path: string }, data: Record<string, unknown>) => void;
        set: (target: { path: string }, data: Record<string, unknown>) => void;
        delete: (target: { path: string }) => void;
      }) => Promise<T>) => {
        const transaction = {
          get: async (target: { path?: string; collectionName?: string }) => {
            if (target.path?.startsWith("users/")) {
              const id = target.path.split("/")[1]!;
              return { exists: id in remaining, data: () => remaining[id] };
            }
            if (typeof (target as { get?: unknown }).get === "function") {
              return (target as { get(): Promise<unknown> }).get();
            }
            throw new Error("unexpected transaction read");
          },
          update: (target: { path: string }, data: Record<string, unknown>) => {
            calls.push(`batch:update:${target.path}`);
            added.push(data);
            if (target.path.startsWith("users/")) {
              const id = target.path.split("/")[1]!;
              remaining[id] = { ...remaining[id], ...data };
            } else if (target.path in otherDocs) {
              otherDocs[target.path] = { ...otherDocs[target.path], ...data };
            }
          },
          set: (target: { path: string }, data: Record<string, unknown>) => {
            calls.push(`batch:set:${target.path.split("/")[0]}`);
            added.push(data);
            otherDocs[target.path] = data;
          },
          delete: (target: { path: string }) => {
            calls.push(`batch:delete:${target.path}`);
            delete otherDocs[target.path];
          },
        };
        const execution = transactionTail.then(() => callback(transaction));
        transactionTail = execution.then(() => undefined, () => undefined);
        return execution;
      },
    } as unknown as Firestore;

    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as unknown as { uid?: string }).uid = "admin-1";
      next();
    });
    addAdminFleetRoutes(app, {
      db,
      logger: { info: vi.fn(), warn: vi.fn() },
      workspaceSlugsForUser: (data) => (data.username ? [String(data.username)] : []),
      provisionGatewayAuthSecret: vi.fn(async () => ({})),
      listGatewayBuilds: vi.fn(async () => []),
      suspendAuthUser: vi.fn(async (uid: string) => {
        calls.push(`suspend-auth:${uid}`);
      }),
      revokeConnectorGrantsForUser: vi.fn(async (uid: string) => {
        calls.push(`revoke:${uid}`);
      }),
    });
    return { app, calls, added, remaining };
  }

  it("schedules retention for a pre-provisioning account instead of deleting inline", async () => {
    const { app, calls } = makeDeleteApp({ u1: { email: "a@b.co" } });

    const res = await request(app).post("/customer/u1/delete").expect(202);

    expect(res.body).toMatchObject({ status: "deletion_scheduled", slug: null });
    expect(calls.at(-2)).toBe("suspend-auth:u1");
    expect(calls.at(-1)).toBe("revoke:u1");
  });

  it("queues independent suspension and delayed erasure operations", async () => {
    const { app, calls, added } = makeDeleteApp({
      u2: { username: "acme", email: "c@d.co" },
    });

    const res = await request(app).post("/customer/u2/delete").expect(202);

    expect(res.body).toMatchObject({ status: "deletion_scheduled", slug: "acme" });
    expect(added).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "suspend-customer", inputUid: "u2" }),
      expect.objectContaining({ kind: "erase-customer", inputUid: "u2" }),
    ]));
    expect(calls.at(-2)).toBe("suspend-auth:u2");
    expect(calls.at(-1)).toBe("revoke:u2");
  });

  it("atomically admits one deletion when two requests race for the same user", async () => {
    const { app, added } = makeDeleteApp({
      u2: { username: "acme", email: "c@d.co" },
    });

    const responses = await Promise.all([
      request(app).post("/customer/u2/delete"),
      request(app).post("/customer/u2/delete"),
    ]);

    expect(responses.map((response) => response.status).sort()).toEqual([202, 409]);
    expect(added.filter((data) => data.kind === "suspend-customer")).toHaveLength(1);
    expect(added.filter((data) => data.kind === "erase-customer")).toHaveLength(1);
  });

  it("admits deletion without reading or writing an unbounded public-document fan-out", async () => {
    const publicDocs = {
      "workspaces/acme": { ownerUid: "u2", ownerActive: true },
      "workspaces/acme/projects/project-one": { ownerUid: "u2", ownerActive: true },
      "posts/post-one": { authorUid: "u2", ownerActive: true },
      "feed/feed-one": { actorUid: "u2" },
      "stars/star-one": { target: { ownerUid: "u2" } },
      "follows/follow-one": { actorUid: "u2" },
    };
    const { app } = makeDeleteApp({ u2: { username: "acme" } }, publicDocs);

    await request(app).post("/customer/u2/delete").expect(202);

    expect(publicDocs).toMatchObject({
      "workspaces/acme": { ownerUid: "u2", ownerActive: true },
      "workspaces/acme/projects/project-one": { ownerUid: "u2", ownerActive: true },
      "posts/post-one": { authorUid: "u2", ownerActive: true },
      "feed/feed-one": { actorUid: "u2" },
      "stars/star-one": { target: { ownerUid: "u2" } },
      "follows/follow-one": { actorUid: "u2" },
    });
  });

  it("does not revoke or delete when the user does not exist", async () => {
    const { app, calls } = makeDeleteApp({});

    await request(app).post("/customer/ghost/delete").expect(404);

    expect(calls).toEqual([]);
  });

  it("moves an already scheduled erasure to now only after an explicit eraseNow request", async () => {
    const { app, calls, added } = makeDeleteApp(
      {
        u3: {
          username: "later",
          accountLifecycle: {
            status: "deletion_scheduled",
            deletionId: "delete-3",
            eraseAfter: Date.now() + 90 * 24 * 60 * 60 * 1_000,
          },
        },
      },
      {
        "customerDeletionJobs/delete-3": {
          erasureOperationId: "erase-3",
        },
        "glmOperations/erase-3": {
          kind: "erase-customer",
          status: "pending",
        },
      },
    );

    const res = await request(app)
      .post("/customer/u3/delete")
      .send({ eraseNow: true })
      .expect(202);

    expect(res.body).toMatchObject({
      status: "erasure_requested",
      deletionId: "delete-3",
      erasureOperationId: "erase-3",
    });
    expect(added).toEqual(expect.arrayContaining([
      expect.objectContaining({ "accountLifecycle.eraseAfter": expect.any(Number) }),
      expect.objectContaining({ eraseAfter: expect.any(Number) }),
      expect.objectContaining({ nextAttemptAt: expect.any(Number) }),
    ]));
    expect(calls).not.toContain("suspend-auth:u3");
    expect(calls).not.toContain("revoke:u3");
  });
});
