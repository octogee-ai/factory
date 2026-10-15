import { describe, expect, it } from "vitest";
import type { Firestore } from "firebase-admin/firestore";
import type { Operation } from "@octogee/shared/types/glm";
import { attemptNeverHeldSource, rearmOwnedLegacyMigration } from "./legacy-migration-recovery.js";

function fixture(migrationId: string) {
  const steps = [{ name: "keys-sync-state", status: "failed" as const, error: "request timed out" }];
  const operation = { id: "op-1", kind: "migrate-customer", status: "failed", attempts: 1, startedAt: 1_000,
    completedAt: 2_000, error: "reaped: controller restarted mid-op", input: { uid: "alice", fromGatewayId: "shared-a", toGatewayId: "shared-b" },
    steps, schedulerHandoff: { migrationId, uid: "alice", slug: "alice", fromGatewayId: "shared-a", toGatewayId: "shared-b" },
  } as Operation;
  const records: Record<string, unknown> = {
    "glmOperations/op-1": operation,
    "users/alice": { provisioning: { openclaw: { gatewayId: "shared-a", migration: { state: "preparing", phase: "preparing", startedAt: 1_000, operationId: "op-1" } } } },
    "gateways/shared-a/assignments/alice": { uid: "alice", gatewayId: "shared-a", state: "serving", epoch: 4 },
  };
  const ref = (path: string) => ({ id: path.split("/").at(-1), path, collection: (name: string) => ({ doc: (id: string) => ref(`${path}/${name}/${id}`) }) });
  let patch: Record<string, unknown> | undefined;
  const db = {
    collection: (name: string) => ({ doc: (id: string) => ref(`${name}/${id}`) }),
    runTransaction: async (body: (tx: unknown) => Promise<unknown>) => body({
      get: async (doc: { path: string }) => ({ exists: records[doc.path] !== undefined, data: () => records[doc.path] }),
      update: (_doc: unknown, update: Record<string, unknown>) => { patch = update; },
    }),
  } as unknown as Firestore;
  return { operation, db, ref: ref("glmOperations/op-1") as unknown as FirebaseFirestore.DocumentReference, patch: () => patch };
}

describe("claimed scheduler recovery evidence", () => {
  it.each(["mig-op-1:scheduler:1:claim:1000"])("recovers %s without inflating attempts or losing steps", async id => {
    const h = fixture(id);
    expect(attemptNeverHeldSource(h.operation)).toBe(true);
    expect(await rearmOwnedLegacyMigration({ db: h.db, ref: h.ref, now: 3_000, admitted: () => true })).toBe(true);
    expect(h.patch()).toMatchObject({ attempts: 1, schedulerHandoff: { migrationId: id, sourceRecovery: { steps: h.operation.steps } },
      attemptHistory: [{ attempt: 1, startedAt: 1_000, steps: h.operation.steps }] });
  });
  it.each([false, true])("rejects unqualified custody even with persisted source recovery=%s", async recovery => {
    const h = fixture("mig-op-1:scheduler:1");
    if (recovery) h.operation.schedulerHandoff!.sourceRecovery = { migrationId: h.operation.schedulerHandoff!.migrationId, sourceEpoch: 4, steps: h.operation.steps };
    expect(attemptNeverHeldSource(h.operation)).toBe(false);
    expect(await rearmOwnedLegacyMigration({ db: h.db, ref: h.ref, now: 3_000, admitted: () => true })).toBe(false);
    expect(h.patch()).toBeUndefined();
  });

  it("does not attribute current steps to a different claim of the same failure attempt", async () => {
    const h = fixture("mig-op-1:scheduler:1:claim:999");
    expect(attemptNeverHeldSource(h.operation)).toBe(false);
    expect(await rearmOwnedLegacyMigration({ db: h.db, ref: h.ref, now: 3_000, admitted: () => true })).toBe(false);
    expect(h.patch()).toBeUndefined();
  });
});
