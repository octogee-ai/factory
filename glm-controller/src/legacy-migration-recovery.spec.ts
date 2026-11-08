import { describe, expect, it } from "vitest";
import { createDocumentFixtureStore } from "@octogee/core/testing/journal-store";
import type { Operation } from "@octogee/shared/types/glm";
import { attemptNeverHeldSource, rearmOwnedLegacyMigration } from "./legacy-migration-recovery.js";

function fixture(migrationId: string, operationId = "op-1") {
  const steps = [{ name: "keys-sync-state", status: "failed" as const, error: "request timed out" }];
  const operation = { id: operationId, kind: "migrate-customer", status: "failed", attempts: 1, startedAt: 1_000,
    completedAt: 2_000, error: "reaped: controller restarted mid-op", input: { uid: "alice", fromGatewayId: "shared-a", toGatewayId: "shared-b" },
    steps, schedulerHandoff: { migrationId, uid: "alice", slug: "alice", fromGatewayId: "shared-a", toGatewayId: "shared-b" },
  } as Operation;
  const path = `glmOperations/${operationId}`;
  const records: Record<string, Record<string, unknown>> = {
    [path]: operation as unknown as Record<string, unknown>,
    "users/alice": { provisioning: { openclaw: { gatewayId: "shared-a", migration: { state: "preparing", phase: "preparing", startedAt: 1_000, operationId } } } },
    "gateways/shared-a/assignments/alice": { uid: "alice", slug: "alice", gatewayId: "shared-a", source: "migrate-customer", state: "serving", epoch: 4,
      createdAt: 500, updatedAt: 500, updatedByOperationId: null },
  };
  const store = createDocumentFixtureStore(records);
  const rearm = () => rearmOwnedLegacyMigration({ store, operationId, now: 3_000, admitted: () => true });
  return { operation, records, rearm, stored: () => records[path] === operation ? undefined : records[path] };
}

describe("claimed scheduler recovery evidence", () => {
  it.each(["mig-op-1:scheduler:1:claim:1000"])("recovers %s without inflating attempts or losing steps", async id => {
    const h = fixture(id);
    expect(attemptNeverHeldSource(h.operation)).toBe(true);
    expect(await h.rearm()).toBe(true);
    expect(h.stored()).toMatchObject({ attempts: 1, schedulerHandoff: { migrationId: id, sourceRecovery: { steps: h.operation.steps } },
      attemptHistory: [{ attempt: 1, startedAt: 1_000, steps: h.operation.steps }] });
  });
  it.each([false, true])("rejects unqualified custody even with persisted source recovery=%s", async recovery => {
    const h = fixture("mig-op-1:scheduler:1");
    if (recovery) h.operation.schedulerHandoff!.sourceRecovery = { migrationId: h.operation.schedulerHandoff!.migrationId, sourceEpoch: 4, steps: h.operation.steps };
    expect(attemptNeverHeldSource(h.operation)).toBe(false);
    expect(await h.rearm()).toBe(false);
    expect(h.stored()).toBeUndefined();
  });

  it("does not attribute current steps to a different claim of the same failure attempt", async () => {
    const h = fixture("mig-op-1:scheduler:1:claim:999");
    expect(attemptNeverHeldSource(h.operation)).toBe(false);
    expect(await h.rearm()).toBe(false);
    expect(h.stored()).toBeUndefined();
  });
});

describe("released forward-only Builder activation recovery admission", () => {
  it.each(["released", "history-evicted", "held", "committed", "source-moved", "epoch-changed", "shared-target", "wrong-generation"] as const)("admits only the released target while the source still owns the activation: %s", async scenario => {
    const target = "alice-s-12345678", id = `builder-activate-${target}-g1`;
    const h = fixture(`mig-${id}:scheduler:1:claim:1000`, id);
    Object.assign(h.operation.input, { source: "builder-activation-lease", builderSlug: "alice", toGatewayId: target });
    Object.assign(h.operation.schedulerHandoff!, { toGatewayId: target, stageAfterCutover: true,
      forwardRecovery: { schemaVersion: 1, phase: "source-flushed", sourceEpoch: scenario === "epoch-changed" ? 3 : 4,
        ...(scenario === "held" ? {} : { targetReleased: true }) } });
    h.operation.steps = [{ name: "final-sync-state", status: "failed", error: "released target" }];
    h.records["users/alice"] = { provisioning: { openclaw: { gatewayId: scenario === "source-moved" ? target : "shared-a",
      migration: { state: "moving", phase: "transferring", startedAt: 1_000, operationId: id }, activationLease: { leaseId: "lease-one", generation: 1, status: "activating",
        sourceGatewayId: "shared-a", sourceAssignmentEpoch: 4, targetGatewayId: target } } } };
    h.records[`gateways/${target}`] = { gatewayId: target, desiredRelease: 1, latestRelease: 1, desiredStatus: "running", gatewayClass: scenario === "shared-target" ? "shared" : "builder", ownerUid: "alice",
      allocation: { kind: "disposable-builder", leaseId: "lease-one", generation: scenario === "wrong-generation" ? 2 : 1, claimedByUid: "alice" } };
    if (scenario === "history-evicted") Object.assign(h.operation, { attempts: 50, startedAt: 8_000, attemptHistory: [] });
    if (scenario === "committed") h.operation.cutoverCommittedAt = 2_000;
    const admitted = await h.rearm();
    expect(admitted).toBe(scenario === "released" || scenario === "history-evicted");
    if (admitted) expect(h.stored()).toMatchObject({ status: "pending", input: { recoverSourceOnly: true },
      schedulerHandoff: { forwardRecovery: { targetReleased: true }, sourceRecovery: { sourceEpoch: 4, steps: h.operation.steps } } });
    else expect(h.stored()).toBeUndefined();
  });
});
