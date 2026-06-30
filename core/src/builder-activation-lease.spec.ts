import { describe, expect, it } from "vitest";

import {
  activationLeaseMissCanMintTicket,
  findPendingActivationOperation,
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
