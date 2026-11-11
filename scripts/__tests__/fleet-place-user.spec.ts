import { describe, expect, it } from "vitest";
import { createDocumentFixtureStore } from "@octogee/core/testing/journal-store";
import { addUserAssignmentRefusal, commitAddUserPlacement } from "../lib/fleet-place-user.js";

describe("fleet add-customer assignment guard", () => {
  it("allows placing a user that has no assignment", () => {
    expect(addUserAssignmentRefusal({ targetGatewayId: "shared-b", currentGatewayId: null, assignmentGatewayIds: [] })).toBeNull();
  });

  it("allows repairing a user whose assignment is already on the target", () => {
    expect(addUserAssignmentRefusal({ targetGatewayId: "shared-b", currentGatewayId: "shared-a", assignmentGatewayIds: ["shared-b"] })).toBeNull();
  });

  it("refuses to move a user whose assignment lives on another gateway", () => {
    expect(addUserAssignmentRefusal({ targetGatewayId: "shared-b", currentGatewayId: "shared-b", assignmentGatewayIds: ["shared-a"] }))
      .toMatch(/assignment on shared-a.*migrate-customer/);
  });

  it("refuses to move a user served from another gateway without an assignment record", () => {
    expect(addUserAssignmentRefusal({ targetGatewayId: "shared-b", currentGatewayId: "shared-a", assignmentGatewayIds: [] }))
      .toMatch(/placed on shared-a.*migrate-customer/);
  });
});

function root(gatewayId: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { gatewayId, gatewayClass: "shared", desiredStatus: "running", latestRelease: 1, desiredRelease: 1, liveRelease: 1, ...overrides };
}

function placementStore(docs: Record<string, Record<string, unknown>>) {
  const records = new Map(Object.entries(docs));
  return { store: createDocumentFixtureStore(records), records };
}

const placement = { uid: "u1", gatewayId: "shared-b", gatewayProfile: "standard" as const, now: 5_000 };

describe("fleet add-customer placement", () => {
  it("writes the serving assignment in the same transaction as the user mirror", async () => {
    const { store, records } = placementStore({
      "users/u1": { username: "alice", provisioning: { openclaw: { slug: "alice" } } },
      "gateways/shared-b": root("shared-b"),
    });

    await expect(commitAddUserPlacement(store, placement)).resolves.toBe("placed");

    expect(records.get("users/u1")).toMatchObject({
      provisioning: { openclaw: { gatewayId: "shared-b", gatewayProfile: "standard", controlUiEnabled: false } },
    });
    expect(records.get("gateways/shared-b/assignments/u1")).toEqual({
      uid: "u1", slug: "alice", gatewayId: "shared-b", source: "repair", state: "serving", epoch: 0,
      createdAt: 5_000, updatedAt: 5_000, updatedByOperationId: null,
    });
  });

  it("creates the missing assignment behind a mirror-only placement", async () => {
    const { store, records } = placementStore({
      "users/u1": { username: "alice", provisioning: { openclaw: { slug: "alice", gatewayId: "shared-b", gatewayProfile: "standard" } } },
      "gateways/shared-b": root("shared-b"),
    });

    await expect(commitAddUserPlacement(store, placement)).resolves.toBe("placed");

    expect(records.get("gateways/shared-b/assignments/u1")).toMatchObject({ uid: "u1", slug: "alice", state: "serving" });
  });

  it("repairs the mirrored profile without rewriting the existing assignment", async () => {
    const assignment = { uid: "u1", slug: "alice", gatewayId: "shared-b", source: "onboarding", state: "serving", epoch: 3, createdAt: 1, updatedAt: 2, updatedByOperationId: null };
    const { store, records } = placementStore({
      "users/u1": { username: "alice", provisioning: { openclaw: { slug: "alice", gatewayId: "shared-b", gatewayProfile: "builder" } } },
      "gateways/shared-b": root("shared-b"),
      "gateways/shared-b/assignments/u1": assignment,
    });

    await expect(commitAddUserPlacement(store, placement)).resolves.toBe("repaired");

    expect(records.get("users/u1")).toMatchObject({ provisioning: { openclaw: { gatewayProfile: "standard", controlUiEnabled: false } } });
    expect(records.get("gateways/shared-b/assignments/u1")).toEqual(assignment);
  });

  it("reports an already-assigned user as unchanged without writing", async () => {
    const docs = {
      "users/u1": { username: "alice", provisioning: { openclaw: { slug: "alice", gatewayId: "shared-b", gatewayProfile: "standard" } } },
      "gateways/shared-b": root("shared-b"),
      "gateways/shared-b/assignments/u1": { uid: "u1", slug: "alice", gatewayId: "shared-b", source: "onboarding", state: "serving", epoch: 3, createdAt: 1, updatedAt: 2, updatedByOperationId: null },
    };
    const { store, records } = placementStore(structuredClone(docs));

    await expect(commitAddUserPlacement(store, placement)).resolves.toBe("unchanged");

    expect(Object.fromEntries(records)).toEqual(docs);
  });

  it("fails loudly instead of writing a mirror for a gateway without a durable root", async () => {
    const docs = { "users/u1": { username: "alice", provisioning: { openclaw: { slug: "alice" } } } };
    const { store, records } = placementStore(structuredClone(docs));

    await expect(commitAddUserPlacement(store, placement)).rejects.toThrow("has no durable root");

    expect(Object.fromEntries(records)).toEqual(docs);
  });

  it("refuses inside the transaction when the user is served elsewhere", async () => {
    const docs = {
      "users/u1": { username: "alice", provisioning: { openclaw: { slug: "alice", gatewayId: "shared-a" } } },
      "gateways/shared-a": root("shared-a"),
      "gateways/shared-b": root("shared-b"),
      "gateways/shared-a/assignments/u1": { uid: "u1", slug: "alice", gatewayId: "shared-a", source: "onboarding", state: "serving", epoch: 1, createdAt: 1, updatedAt: 1, updatedByOperationId: null },
    };
    const { store, records } = placementStore(structuredClone(docs));

    await expect(commitAddUserPlacement(store, placement)).rejects.toThrow(/assignment on shared-a.*migrate-customer/);

    expect(Object.fromEntries(records)).toEqual(docs);
  });

  it("refuses a gateway that is no longer running", async () => {
    const { store } = placementStore({
      "users/u1": { username: "alice", provisioning: { openclaw: { slug: "alice" } } },
      "gateways/shared-b": root("shared-b", { desiredStatus: "draining" }),
    });

    await expect(commitAddUserPlacement(store, placement)).rejects.toThrow("is draining, not running");
  });
});
