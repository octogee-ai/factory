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

const builderGateway = doc("gw-builder", {
  ownerUid: "u-1",
  gatewayClass: "builder",
  desiredStatus: "running",
  builderSlug: "mira",
});

function plan(overrides: Partial<Parameters<typeof resolveBuilderActivationPlan>[0]> = {}) {
  return resolveBuilderActivationPlan({
    uid: "u-1",
    builderSlug: "mira",
    currentGatewayId: "gw-shared",
    glmGateways: [builderGateway],
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
        glmGateways: [
          doc("gw-other", {
            ownerUid: "u-1",
            gatewayClass: "builder",
            desiredStatus: "running",
            builderSlug: "other",
          }),
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

describe("requestBuilderActivationLease — heartbeat source (cutover step 2)", () => {
  function fakeDb(state: {
    users: Record<string, Record<string, unknown>>;
    glmGateways: Record<string, Record<string, unknown>>;
    gateways?: Record<string, Record<string, unknown>>;
  }) {
    const accessed = new Set<string>();
    const updates: Array<{ id: string; patch: Record<string, unknown> }> = [];
    const db = {
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

  it("sources readiness from glmGateways/{id}.heartbeat, never the flat gateways collection", async () => {
    const { db, accessed } = fakeDb({
      users: {
        "u-1": {
          approved: true,
          username: "mira",
          provisioning: { openclaw: { gatewayId: "gw-builder" } },
        },
      },
      glmGateways: {
        "gw-builder": {
          ownerUid: "u-1",
          gatewayClass: "builder",
          desiredStatus: "running",
          builderSlug: "mira",
          heartbeat: { status: "ready" },
        },
      },
      // A stale flat doc says "starting" — reading it would return "wake" (202).
      gateways: { "gw-builder": { status: "starting" } },
    });

    const result = await requestBuilderActivationLease({
      db: db as never,
      uid: "u-1",
      createdBy: "u-1",
      workspaceSlugsForUser: () => ["mira"],
      now: 1_000,
    });

    // glm heartbeat "ready" + current gateway == target ⇒ already-active (200).
    expect(result.statusCode).toBe(200);
    expect(result.body).toMatchObject({ alreadyActive: true, gatewayId: "gw-builder" });
    expect(accessed.has("gateways")).toBe(false);
  });
});
