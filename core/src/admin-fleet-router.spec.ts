import { afterEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import type { Firestore } from "firebase-admin/firestore";

import {
  addAdminFleetRoutes,
  DEDICATED_GATEWAY_IDLE_DEFAULT_MS,
  parseDedicatedGatewayIdlePatch,
  projectDedicatedGatewayIdleSettings,
  projectGatewayReservation,
  projectGatewaySummary,
} from "./admin-fleet-router.js";
import {
  GLM_GATEWAYS_COLLECTION,
  GLM_OPERATIONS_COLLECTION,
} from "@octogee/shared/types/glm";

// The Fleet card's reservation/cost derives from this projection. It must match
// the helm posture (#1932: all classes ride Spot by default) — a prod operator
// gateway with no per-gateway override is on Spot, not on-demand.
describe("projectGatewayReservation — Spot is the default for every class", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("a PROD operator gateway with no scheduling override projects spot", () => {
    vi.stubEnv("K8S_NAMESPACE", "octogee");
    const r = projectGatewayReservation({ profile: "operator", gatewayClass: "operator" });
    expect(r.type).toBe("spot");
    expect(r.computeClass).toBe("octogee-gateway-spot");
  });

  it("an explicit on-demand scheduling override still wins", () => {
    vi.stubEnv("K8S_NAMESPACE", "octogee");
    const r = projectGatewayReservation({ profile: "operator", scheduling: "on-demand" });
    expect(r.type).toBe("on-demand");
  });

  it("TEST gateways resolve the env-specific spot class", () => {
    vi.stubEnv("K8S_NAMESPACE", "octogee-test");
    const r = projectGatewayReservation({ profile: "operator", gatewayClass: "operator" });
    expect(r.type).toBe("spot");
    expect(r.computeClass).toBe("octogee-gateway-test-spot");
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
});

describe("dedicated gateway idle settings", () => {
  it("uses the 30 minute default when no runtime override exists", () => {
    expect(projectDedicatedGatewayIdleSettings({}, undefined, 60_000)).toEqual({
      configuredMs: null,
      defaultMs: DEDICATED_GATEWAY_IDLE_DEFAULT_MS,
      effectiveMs: DEDICATED_GATEWAY_IDLE_DEFAULT_MS,
      sweepMs: 60_000,
      disabled: false,
    });
  });

  it("projects 0ms as the operator-controlled never setting", () => {
    expect(projectDedicatedGatewayIdleSettings({ dedicatedGatewayIdleMs: 0 }, 86_400_000, 60_000))
      .toMatchObject({
        configuredMs: 0,
        defaultMs: 86_400_000,
        effectiveMs: 0,
        disabled: true,
      });
  });

  it("accepts non-negative integer patches and rejects invalid values", () => {
    expect(parseDedicatedGatewayIdlePatch({ dedicatedGatewayIdleMs: 0 })).toEqual({ ok: 0 });
    expect(parseDedicatedGatewayIdlePatch({ dedicatedGatewayIdleMs: 1_800_000 })).toEqual({
      ok: 1_800_000,
    });
    expect(parseDedicatedGatewayIdlePatch({ dedicatedGatewayIdleMs: null })).toEqual({
      ok: null,
    });
    expect(parseDedicatedGatewayIdlePatch({ dedicatedGatewayIdleMs: -1 })).toMatchObject({
      error: { status: 400 },
    });
    expect(parseDedicatedGatewayIdlePatch({ dedicatedGatewayIdleMs: 1.5 })).toMatchObject({
      error: { status: 400 },
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

function mkCollection(records: Record<string, Record<string, unknown>>) {
  const query = (filters: Array<{ field: string; value: unknown }> = []) => ({
    where: vi.fn((field: string, _op: string, value: unknown) =>
      query([...filters, { field, value }]),
    ),
    orderBy: vi.fn(() => query(filters)),
    limit: vi.fn(() => query(filters)),
    get: vi.fn(async () => ({
      docs: docsFrom(records).filter((doc) =>
        filters.every((filter) => valueAtPath(doc.data(), filter.field) === filter.value),
      ),
      size: docsFrom(records).filter((doc) =>
        filters.every((filter) => valueAtPath(doc.data(), filter.field) === filter.value),
      ).length,
    })),
    doc: vi.fn((id: string) => ({
      get: vi.fn(async () => ({
        id,
        exists: records[id] !== undefined,
        data: () => records[id],
      })),
      delete: vi.fn(async () => {
        delete records[id];
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
  reservations?: Record<string, Record<string, unknown>>;
  // gateways/{gatewayId}/assignments/{uid} durable roster docs (PR7).
  assignments?: Record<string, Record<string, Record<string, unknown>>>;
}) {
  const state = {
    config: { ...opts.config },
    users: { ...opts.users },
    reservations: { ...(opts.reservations ?? {}) },
  };
  const assignmentDocs = Object.values(opts.assignments ?? {}).flatMap((byUid) =>
    Object.entries(byUid).map(([uid, data]) => ({ id: uid, data: () => data })),
  );
  const db = {
    doc: vi.fn((path: string) => {
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
      if (name === GLM_OPERATIONS_COLLECTION) return mkCollection({});
      if (name === "operatorGatewayReservations") {
        return mkCollection(state.reservations);
      }
      return mkCollection({});
    }),
    runTransaction: vi.fn(async (body: (transaction: {
      get: (ref: { get: () => Promise<unknown> }) => Promise<unknown>;
      delete: (ref: { delete: () => Promise<void> }) => void;
    }) => Promise<unknown>) => {
      const pendingDeletes: Array<() => Promise<void>> = [];
      const result = await body({
        get: (ref) => ref.get(),
        delete: (ref) => {
          pendingDeletes.push(() => ref.delete());
        },
      });
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
    suspendAuthUser: vi.fn(async () => undefined),
    revokeConnectorGrantsForUser: vi.fn(async () => undefined),
  });
  return { app, state };
}

describe("operator reservation orphan cleanup", () => {
  const reservation = {
    uid: "uid-orphan",
    builderSlug: "orphan",
    requestedSizingTier: "nano",
    status: "requested",
    billingStatus: "active",
    requestedAt: 1_000,
    updatedAt: 2_000,
  };

  it("marks a reservation without an owner user as orphaned and not fulfillable", async () => {
    const { app } = mkAdminFleetRouteApp({
      config: {},
      users: {},
      reservations: { "uid-orphan": reservation },
    });

    const response = await request(app)
      .get("/operator-gateway-reservations")
      .expect(200);

    expect(response.body.reservations).toEqual([
      expect.objectContaining({
        uid: "uid-orphan",
        ownerExists: false,
        readyToFulfill: false,
        fulfillBlockedReason: "owner user is missing",
      }),
    ]);
  });

  it("uses the reservation document id as the cleanup identity", async () => {
    const { app } = mkAdminFleetRouteApp({
      config: {},
      users: {},
      reservations: {
        "uid-orphan": { ...reservation, uid: "uid-from-malformed-payload" },
      },
    });

    const response = await request(app)
      .get("/operator-gateway-reservations")
      .expect(200);

    expect(response.body.reservations[0]).toMatchObject({
      uid: "uid-orphan",
      ownerExists: false,
      readyToFulfill: false,
      fulfillBlockedReason: "reservation uid mismatch",
    });
  });

  it("deletes a reservation only when its owner user is absent", async () => {
    const { app, state } = mkAdminFleetRouteApp({
      config: {},
      users: {},
      reservations: { "uid-orphan": reservation },
    });

    await request(app)
      .delete("/operator-gateway-reservations/uid-orphan")
      .expect(200, { status: "deleted", uid: "uid-orphan" });
    expect(state.reservations).toEqual({});
  });

  it("refuses to delete a reservation while its owner user exists", async () => {
    const { app, state } = mkAdminFleetRouteApp({
      config: {},
      users: { "uid-orphan": { username: "still-here" } },
      reservations: { "uid-orphan": reservation },
    });

    const response = await request(app)
      .delete("/operator-gateway-reservations/uid-orphan")
      .expect(409);
    expect(response.body.error).toMatch(/owner user still exists/i);
    expect(state.reservations).toHaveProperty("uid-orphan");
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
    computeClass: null,
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

describe("fleet gateway projection", () => {
  it("does not revive stale bare runtime state when an existing root is malformed", async () => {
    const { app } = mkAdminFleetRouteApp({
      config: { defaultGatewayId: "default", overrides: {} },
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
      config: { defaultGatewayId: "default", overrides: {} },
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
      config: { defaultGatewayId: "default", overrides: {} },
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
});

describe("onboarding placement (post-cohorts)", () => {
  it("returns the placement config with default-gateway warnings", async () => {
    const { app } = mkAdminFleetRouteApp({
      config: { defaultGatewayId: "gw-missing", overrides: {} },
      users: {},
      glmGateways: {
        "gw-shared": { gatewayClass: "shared", desiredStatus: "running" },
      },
    });

    const res = await request(app).get("/onboarding-placement").expect(200);

    expect(res.body.config).toEqual({ defaultGatewayId: "gw-missing", overrides: {} });
    expect(res.body.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "default-gateway-missing", gatewayId: "gw-missing" }),
      ]),
    );
    const shared = res.body.gateways.find(
      (g: { gatewayId: string }) => g.gatewayId === "gw-shared",
    );
    expect(shared).toMatchObject({ assignableAsDefault: true, defaultTarget: false });
  });

  it("surfaces the DURABLE roster state + epoch from the assignment doc", async () => {
    const { app } = mkAdminFleetRouteApp({
      config: { defaultGatewayId: "default", overrides: {} },
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
      config: { defaultGatewayId: "default", overrides: {} },
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

  it("PATCH accepts only a strict durable shared root, never a bare glm desired doc", async () => {
    const { app, state } = mkAdminFleetRouteApp({
      config: { defaultGatewayId: "gw-old", overrides: {} },
      users: {},
      glmGateways: {
        "gw-bare": { gatewayClass: "shared", desiredStatus: "running" },
      },
      gateways: {
        "gw-new": durableGatewayRoot("gw-new"),
        "gw-builder": durableGatewayRoot("gw-builder", {
          gatewayClass: "builder",
          ownerUid: "uid-builder",
          builderSlug: "builder",
        }),
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

    await request(app)
      .patch("/onboarding-placement")
      .send({ defaultGatewayId: "gw-new" })
      .expect(200);
    expect(state.config.defaultGatewayId).toBe("gw-new");
  });

  it("stores a per-uid gateway override after resolving the builder slug server-side", async () => {
    const { app, state } = mkAdminFleetRouteApp({
      config: { defaultGatewayId: "gw-default", overrides: {} },
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

    const res = await request(app)
      .put("/onboarding-placement/overrides/by-slug/alice")
      .send({ gatewayId: "gw-canary" })
      .expect(200);

    expect(state.config.overrides).toEqual({ "uid-alice": "gw-canary" });
    expect(res.body.config.overrides).toEqual({ "uid-alice": "gw-canary" });

    await request(app).delete("/onboarding-placement/overrides/uid-alice").expect(200);
    expect(state.config.overrides).toEqual({});
  });

  it("does not report pointer drift for an operator-owned dedicated gateway outside onboarding placement", async () => {
    const { app } = mkAdminFleetRouteApp({
      config: { defaultGatewayId: "default-blue", overrides: {} },
      users: {
        "uid-ceckert": {
          username: "ceckert",
          email: "ceckert@example.com",
          provisioning: {
            openclaw: {
              slug: "ceckert",
              gatewayId: "bender-blue",
              activationLease: {
                gatewayId: "bender-blue",
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
      policyTargetGatewayId: "default-blue",
      driftState: "healthy",
    });
    expect(customer.warnings).toEqual([]);
    expect(res.body.driftSummary).toMatchObject({
      healthy: 1,
      "pointer-drift": 0,
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

  it("atomically hides public projections and removes identifying social edges", async () => {
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

    expect(publicDocs["workspaces/acme"].ownerActive).toBe(false);
    expect(publicDocs["workspaces/acme/projects/project-one"].ownerActive).toBe(false);
    expect(publicDocs["posts/post-one"].ownerActive).toBe(false);
    expect(publicDocs).not.toHaveProperty("feed/feed-one");
    expect(publicDocs).not.toHaveProperty("stars/star-one");
    expect(publicDocs).not.toHaveProperty("follows/follow-one");
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
