import { describe, expect, it, vi } from "vitest";
import type { Firestore } from "firebase-admin/firestore";
import { releaseAbandonedSchedulerHandoffs } from "../scheduler-handoff-release.js";

describe("abandoned forward migration fences", () => {
  it.each(["legacy", "v2"])("never resumes the old writer or aborts the target for a failed %s upgrade", async kind => {
    const schedulerHandoff = {
      migrationId: "stable", fromGatewayId: "old-native", toGatewayId: "new-shared", uid: "alice", slug: "alice",
      ...(kind === "legacy" ? { forwardRecovery: { schemaVersion: 1, phase: "source-flushed", sourceEpoch: 4 } } : {}),
    };
    const operation = {
      kind: "migrate-customer", status: "failed", schedulerHandoff, schedulerHandoffReleased: false,
      input: { uid: "alice", fromGatewayId: "old-native", toGatewayId: "new-shared" },
      ...(kind === "v2" ? { customerMigrationV2: { phase: "sourceQuiesced" } } : {}),
      steps: [{ name: "quiesce-source", status: "done" }, { name: "final-sync-state", status: "failed" }],
    };
    const query = { where: vi.fn(() => query), get: vi.fn(async () => ({ docs: [{ id: "upgrade", data: () => operation }] })) };
    const scheduler = vi.fn();
    const runTransaction = vi.fn();
    expect(await releaseAbandonedSchedulerHandoffs({
      db: { collection: () => query, runTransaction } as unknown as Firestore,
      gatewayExists: vi.fn(async () => true), scheduler, log: vi.fn(), now: () => 1000,
    })).toEqual({ released: 0 });
    expect(scheduler).not.toHaveBeenCalled();
    expect(runTransaction).not.toHaveBeenCalled();
  });
});
