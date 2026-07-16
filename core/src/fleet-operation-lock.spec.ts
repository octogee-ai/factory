import { describe, expect, it } from "vitest";

import {
  GatewayMigrationInFlightError,
  findActiveGatewayMigration,
  serialFleetOperationsConflict,
} from "./fleet-operation-lock.js";

describe("findActiveGatewayMigration", () => {
  it.each([
    ["pending input source", { status: "pending", input: { fromGatewayId: "source" } }],
    ["running input target", { status: "running", input: { toGatewayId: "source" } }],
    [
      "running durable assigned source",
      {
        status: "running",
        input: { toGatewayId: "target" },
        customerMigrationV2: {
          sourceGatewayId: "source",
          sourceAssignmentMode: "assigned",
        },
      },
    ],
    [
      "running durable unassigned-live source",
      {
        status: "running",
        input: { toGatewayId: "target" },
        customerMigrationV2: {
          sourceGatewayId: "source",
          sourceAssignmentMode: "unassigned-live",
        },
      },
    ],
    [
      "running durable target",
      {
        status: "running",
        input: { fromGatewayId: "other" },
        customerMigrationV2: { targetGatewayId: "source" },
      },
    ],
  ])("finds an active migration bound through its %s", (_name, operation) => {
    const match = findActiveGatewayMigration("source", [
      { id: "migration", kind: "migrate-customer", ...operation },
    ]);

    expect(match?.id).toBe("migration");
  });

  it.each(["succeeded", "failed", "rolled-back"])(
    "ignores a %s migration",
    (status) => {
      expect(findActiveGatewayMigration("source", [{
        id: "migration",
        kind: "migrate-customer",
        status,
        customerMigrationV2: { sourceGatewayId: "source" },
      }])).toBeNull();
    },
  );

  it("returns a typed conflict with the gateway and operation identities", () => {
    const error = new GatewayMigrationInFlightError("source", "migration");

    expect(error).toMatchObject({ gatewayId: "source", operationId: "migration" });
    expect(error.message).toContain("source");
  });
});

describe("serialFleetOperationsConflict", () => {
  it("does not make a rollout wait on the migration child it created", () => {
    const rollout = { id: "roll-1", kind: "rollout", input: { gatewayId: "default" } };
    const child = {
      id: "migration-1",
      kind: "migrate-customer",
      input: {
        fromGatewayId: "default",
        toGatewayId: "default-r2",
        rollOperationId: "roll-1",
      },
    };

    expect(serialFleetOperationsConflict(rollout, child)).toBe(false);
    expect(serialFleetOperationsConflict(child, rollout)).toBe(false);
  });

  it("keeps a rollout isolated from migration children owned by another rollout", () => {
    expect(serialFleetOperationsConflict(
      { id: "roll-2", kind: "rollout", input: { gatewayId: "default" } },
      {
        id: "migration-1",
        kind: "migrate-customer",
        input: {
          fromGatewayId: "default",
          toGatewayId: "default-r2",
          rollOperationId: "roll-1",
        },
      },
    )).toBe(true);
  });

  it("uses durable V2 source bindings across migration and rollout kinds", () => {
    expect(serialFleetOperationsConflict(
      { id: "roll", kind: "rollout", input: { gatewayId: "source" } },
      {
        id: "migration",
        kind: "migrate-customer",
        customerMigrationV2: { sourceGatewayId: "source" },
      },
    )).toBe(true);
  });

  it("keeps unrelated migrations and rollouts independent", () => {
    expect(serialFleetOperationsConflict(
      { id: "roll", kind: "rollout", input: { gatewayId: "green" } },
      {
        id: "migration",
        kind: "migrate-customer",
        input: { fromGatewayId: "blue", toGatewayId: "purple" },
      },
    )).toBe(false);
  });

  it("keeps rollout operations globally serial", () => {
    expect(serialFleetOperationsConflict(
      { id: "a", kind: "rollout", input: { gatewayId: "blue" } },
      { id: "b", kind: "rollout", input: { gatewayId: "green" } },
    )).toBe(true);
  });
});
