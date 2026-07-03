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
    })),
  });
  return query();
}

function mkAdminFleetRouteApp(opts: {
  config: Record<string, unknown>;
  users: Record<string, Record<string, unknown>>;
  glmGateways?: Record<string, Record<string, unknown>>;
  gateways?: Record<string, Record<string, unknown>>;
}) {
  const state = {
    config: { ...opts.config },
    users: { ...opts.users },
  };
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
      return mkCollection({});
    }),
  } as unknown as Firestore;

  const app = express();
  app.use(express.json());
  addAdminFleetRoutes(app, {
    db,
    logger: { info: vi.fn(), warn: vi.fn() },
    workspaceSlugsForUser: (data) => data.username ? [data.username] : [],
    provisionGatewayAuthSecret: vi.fn(async () => ({})),
    listGatewayBuilds: vi.fn(async () => []),
    deleteAuthUserTolerantOfMissing: vi.fn(async () => undefined),
  });
  return { app, state };
}

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

  it("PATCH validates the default gateway is a live shared gateway", async () => {
    const { app, state } = mkAdminFleetRouteApp({
      config: { defaultGatewayId: "gw-old", overrides: {} },
      users: {},
      glmGateways: {
        "gw-new": { gatewayClass: "shared", desiredStatus: "running" },
        "gw-builder": { gatewayClass: "builder", desiredStatus: "running" },
      },
    });

    const rejected = await request(app)
      .patch("/onboarding-placement")
      .send({ defaultGatewayId: "gw-builder" })
      .expect(400);
    expect(rejected.body.error).toContain("shared gateway");

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
      glmGateways: {
        "gw-default": { gatewayClass: "shared", desiredStatus: "running" },
        "gw-canary": { gatewayClass: "shared", desiredStatus: "running" },
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
          approved: true,
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
        },
      },
      gateways: {
        "bender-blue": {
          gatewayId: "bender-blue",
          status: "ready",
          mountedCustomers: ["ceckert"],
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
