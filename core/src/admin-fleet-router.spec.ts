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
      if (name === GLM_GATEWAYS_COLLECTION) return mkCollection({});
      if (name === "gateways") return mkCollection({});
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

describe("onboarding cohort overrides by builder slug", () => {
  it("stores a UID override after resolving the builder slug server-side", async () => {
    const { app, state } = mkAdminFleetRouteApp({
      config: {
        defaultGatewayId: "gw-anthropic",
        currentOnboardingCohortId: "anthropic",
        previewOnboardingCohortId: "glm",
        onboardingCohorts: {
          anthropic: {
            gatewayId: "gw-anthropic",
            provider: "anthropic",
            model: "claude-sonnet-4-6",
            label: "Current: Sonnet 4.6",
          },
          glm: {
            gatewayId: "gw-glm",
            provider: "openrouter",
            model: "z-ai/glm-5.2",
            label: "Preview: GLM 5.2",
          },
        },
        cohortOverrides: {},
      },
      users: {
        "uid-alice": {
          username: "alice-old",
          email: "alice@example.com",
          provisioning: { openclaw: { slug: "alice" } },
        },
      },
    });

    const res = await request(app)
      .put("/onboarding-cohorts/glm/overrides/by-slug/alice")
      .expect(200);

    expect(state.config.cohortOverrides).toEqual({ "uid-alice": "glm" });
    expect(res.body.config.cohortOverrides).toEqual({ "uid-alice": "glm" });
  });
});
