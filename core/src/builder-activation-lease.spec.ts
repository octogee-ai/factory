import { describe, expect, it } from "vitest";

import {
  activationLeaseMissCanMintTicket,
  findPendingActivationOperation,
  requestBuilderActivationLease,
  resolveBuilderActivationPlan,
  type FirestoreDocLike,
} from "./builder-activation-lease.js";

function doc(id: string, data: Record<string, unknown>): FirestoreDocLike {
  return { id, data: () => data };
}

function durableGateway(
  id: string,
  overrides: Record<string, unknown> = {},
): FirestoreDocLike {
  return doc(id, {
    gatewayId: id,
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
    gatewayClass: "builder",
    imageProfile: "standard",
    sizingTier: null,
    computeClass: null,
    gcpProject: null,
    gatewayContainerSecurityContext: null,
    serviceAccountName: null,
    serviceAccount: null,
    operatorAccess: null,
    ownerUid: "u-1",
    coOwnerUids: [],
    builderSlug: "mira",
    openclawOverrides: null,
    modelBrokerLimits: null,
    preemption: null,
    ...overrides,
  });
}

const builderGateway = durableGateway("gw-builder");

function plan(overrides: Partial<Parameters<typeof resolveBuilderActivationPlan>[0]> = {}) {
  return resolveBuilderActivationPlan({
    uid: "u-1",
    builderSlug: "mira",
    currentGatewayId: "gw-shared",
    gateways: [builderGateway],
    gatewayHeartbeats: new Map([["gw-builder", { status: "ready" }]]),
    pendingOps: [],
    ...overrides,
  });
}

describe("findPendingActivationOperation", () => {
  it("matches only pending migration operations for the requested user, gateway, and source", () => {
    expect(
      findPendingActivationOperation(
        [
          doc("wrong-source", {
            kind: "migrate-customer",
            input: { uid: "u-1", toGatewayId: "gw-builder", source: "manual" },
          }),
          doc("op-1", {
            kind: "migrate-customer",
            input: {
              uid: "u-1",
              toGatewayId: "gw-builder",
              source: "builder-activation-lease",
            },
          }),
        ],
        "u-1",
        "gw-builder",
        "builder-activation-lease",
      ),
    ).toEqual({ id: "op-1", kind: "migrate-customer" });
  });
});

describe("resolveBuilderActivationPlan", () => {
  it("rejects users with no current assignment before inspecting candidate gateways", () => {
    expect(plan({ currentGatewayId: null })).toEqual({
      error: {
        status: 409,
        body: {
          code: "no-current-gateway-assignment",
          error: "user has no current gateway assignment; assign before activation",
          uid: "u-1",
        },
      },
    });
  });

  it("rejects owned gateways whose builder slug belongs to a different builder", () => {
    expect(
      plan({
        gateways: [
          durableGateway("gw-other", { builderSlug: "other" }),
        ],
      }),
    ).toEqual({
      error: {
        status: 409,
        body: {
          code: "owned-activation-gateway-slug-mismatch",
          error: "owned activation gateway builderSlug does not match user slug",
          uid: "u-1",
          builderSlug: "mira",
          gatewayIds: ["gw-other"],
        },
      },
    });
  });

  it("returns already-active when the current dedicated gateway is ready", () => {
    expect(plan({ currentGatewayId: "gw-builder" })).toEqual({
      ok: { action: "already-active", target: expect.objectContaining({ gatewayId: "gw-builder" }) },
    });
  });

  it("wakes the target instead of migrating when the dedicated gateway is not ready", () => {
    expect(
      plan({
        gatewayHeartbeats: new Map([["gw-builder", { status: "starting" }]]),
      }),
    ).toEqual({
      ok: {
        action: "wake",
        status: "starting",
        target: expect.objectContaining({ gatewayId: "gw-builder" }),
      },
    });
  });

  it("rejects duplicate activation when a matching migration operation is already pending", () => {
    expect(
      plan({
        pendingOps: [
          doc("op-existing", {
            kind: "migrate-customer",
            input: {
              uid: "u-1",
              toGatewayId: "gw-builder",
              source: "builder-activation-lease",
            },
          }),
        ],
      }),
    ).toEqual({
      error: {
        status: 409,
        body: {
          code: "builder-activation-already-running",
          error: "builder activation is already running",
          uid: "u-1",
          gatewayId: "gw-builder",
          operationId: "op-existing",
          kind: "migrate-customer",
        },
      },
    });
  });

  it("plans migration when a different current gateway is assigned and the dedicated target is ready", () => {
    expect(plan()).toEqual({
      ok: { action: "migrate", target: expect.objectContaining({ gatewayId: "gw-builder" }) },
    });
  });

  it("ignores a bare gateway-shaped doc even when it claims owned builder policy", () => {
    expect(
      plan({
        gateways: [
          doc("legacy", {
            gatewayId: "legacy",
            ownerUid: "u-1",
            gatewayClass: "builder",
            desiredStatus: "running",
            builderSlug: "mira",
          }),
        ],
      }),
    ).toEqual({
      error: {
        status: 404,
        body: expect.objectContaining({ code: "no-owned-dedicated-activation-gateway" }),
      },
    });
  });
});

describe("activationLeaseMissCanMintTicket", () => {
  it.each([
    "no-current-gateway-assignment",
    "no-owned-dedicated-activation-gateway",
    "multiple-owned-activation-gateways",
    "user-not-approved",
    "no-resolvable-builder-slug",
  ])("allows ticket minting for %s", (code) => {
    expect(activationLeaseMissCanMintTicket({ statusCode: 409, body: { code } })).toBe(true);
  });

  it("keeps runtime activation conflicts from minting a ticket", () => {
    expect(
      activationLeaseMissCanMintTicket({
        statusCode: 409,
        body: { code: "builder-activation-already-running" },
      }),
    ).toBe(false);
  });
});

describe("requestBuilderActivationLease — durable root policy + revision telemetry", () => {
  function fakeDb(state: {
    users: Record<string, Record<string, unknown>>;
    glmGateways: Record<string, Record<string, unknown>>;
    gateways?: Record<string, Record<string, unknown>>;
  }) {
    const accessed = new Set<string>();
    const updates: Array<{ id: string; patch: Record<string, unknown> }> = [];
    const db = {
      doc(path: string) {
        const [name, id] = path.split("/");
        const data = (state as Record<string, Record<string, Record<string, unknown>>>)[name]?.[id];
        return {
          get: async () => ({ exists: data !== undefined, data: () => data }),
        };
      },
      collection(name: string) {
        accessed.add(name);
        return {
          doc: (id?: string) => ({
            id: id ?? "op-1",
            get: async () => ({
              exists: !!(state as Record<string, Record<string, unknown>>)[name]?.[id ?? ""],
              data: () => (state as Record<string, Record<string, unknown>>)[name]?.[id ?? ""],
            }),
            update: async (patch: Record<string, unknown>) => {
              updates.push({ id: id ?? "", patch });
            },
          }),
          get: async () => ({
            docs: Object.entries(
              (state as Record<string, Record<string, Record<string, unknown>>>)[name] ?? {},
            ).map(([id, data]) => ({ id, data: () => data })),
          }),
          where: () => ({ get: async () => ({ docs: [] }) }),
        };
      },
    };
    return { db, accessed, updates };
  }

  it("uses durable root ownership/class and the live revision heartbeat", async () => {
    const { db, accessed } = fakeDb({
      users: {
        "u-1": {
          approved: true,
          username: "mira",
          provisioning: { openclaw: { gatewayId: "gw-builder" } },
        },
      },
      gateways: {
        "gw-builder": {
          gatewayId: "gw-builder",
          createdAt: 1,
          createdBy: "test",
          updatedAt: 1,
          updatedBy: "test",
          latestRelease: 2,
          desiredRelease: 2,
          ownerUid: "u-1",
          gatewayClass: "builder",
          configSchemaVersion: 1,
          profile: null,
          imageProfile: "standard",
          sizingTier: null,
          computeClass: null,
          gcpProject: null,
          gatewayContainerSecurityContext: null,
          serviceAccountName: null,
          serviceAccount: null,
          operatorAccess: null,
          coOwnerUids: [],
          desiredStatus: "running",
          builderSlug: "mira",
          liveRevisionId: "gw-builder-r2",
          liveRelease: 2,
          trafficRevisionId: "gw-builder-r2",
          roll: null,
          openclawOverrides: null,
          modelBrokerLimits: null,
          preemption: null,
        },
      },
      glmGateways: {
        "gw-builder-r2": {
          docKind: "revision",
          revisionId: "gw-builder-r2",
          gateway: "gw-builder",
          release: 2,
          lifecycle: "serving",
          heartbeat: { status: "ready" },
        },
      },
    });

    const result = await requestBuilderActivationLease({
      db: db as never,
      uid: "u-1",
      createdBy: "u-1",
      workspaceSlugsForUser: () => ["mira"],
      now: 1_000,
    });

    // Root config + live revision heartbeat "ready" + current gateway == target ⇒ already-active (200).
    expect(result.statusCode).toBe(200);
    expect(result.body).toMatchObject({ alreadyActive: true, gatewayId: "gw-builder" });
    expect(accessed.has("gateways")).toBe(true);
  });

  it("fails closed when only a legacy gateway doc claims an owned ready target", async () => {
    const { db } = fakeDb({
      users: {
        "u-1": {
          approved: true,
          username: "mira",
          provisioning: { openclaw: { gatewayId: "gw-shared" } },
        },
      },
      gateways: {
        legacy: {
          gatewayId: "legacy",
          ownerUid: "u-1",
          gatewayClass: "builder",
          desiredStatus: "running",
          builderSlug: "mira",
          liveRevisionId: "legacy-r1",
          liveRelease: 1,
        },
      },
      glmGateways: {
        "legacy-r1": {
          docKind: "revision",
          revisionId: "legacy-r1",
          gateway: "legacy",
          release: 1,
          heartbeat: { status: "ready" },
        },
      },
    });

    const result = await requestBuilderActivationLease({
      db: db as never,
      uid: "u-1",
      createdBy: "u-1",
      workspaceSlugsForUser: () => ["mira"],
      now: 1_000,
    });

    expect(result).toMatchObject({
      statusCode: 404,
      body: { code: "no-owned-dedicated-activation-gateway" },
    });
  });
});
