import { describe, expect, it, vi } from "vitest";
import type { MigrationProgressRecord, Operation } from "@octogee/shared/types/glm";
import { compactProgress, journalHandoffProgress, journalOperationProgress, type ProgressJournalDeps } from "./migration-progress-journal.js";

const event: MigrationProgressRecord = {
  phase: "transfer-and-verify", status: "running", at: 5_000, elapsedMs: 0, migrationId: "mig-op-1", slug: "alice", source: "shared-0",
};

function claimed(startedAt: number | null = 4_000): Operation {
  return {
    id: "op-1", kind: "migrate-customer", status: "running", createdBy: "admin", createdAt: 1_000, startedAt, completedAt: null,
    input: { uid: "u1", toGatewayId: "shared-1" }, steps: [],
  };
}

function harness(stored: Record<string, Record<string, unknown>>) {
  const updates: Array<{ path: string; data: Record<string, unknown> }> = [];
  const ref = (path: string) => ({
    path,
    get: async () => ({ exists: stored[path] !== undefined, data: () => stored[path] }),
    update: async (data: Record<string, unknown>) => { updates.push({ path, data }); },
    set: async () => undefined,
    collection: (sub: string) => ({ doc: (id: string) => ref(`${path}/${sub}/${id}`) }),
  });
  const deps: ProgressJournalDeps = {
    db: {
      collection: (name: string) => ({ doc: (id: string) => ref(`${name}/${id}`) }),
      runTransaction: async (body) => body({
        get: async (target) => target.get(),
        update: (target, data) => { updates.push({ path: (target as unknown as { path: string }).path, data }); },
        set: () => undefined,
        delete: () => undefined,
      }),
    },
    log: vi.fn(),
    now: () => 9_000,
  };
  return { deps, updates };
}

describe("journalOperationProgress", () => {
  it("appends the event only while the claimed attempt still owns the operation", async () => {
    const earlier = { ...event, phase: "gate-source", status: "done" as const, at: 3_000 };
    const h = harness({ "glmOperations/op-1": { startedAt: 4_000, status: "running", progress: [earlier] } });
    await journalOperationProgress(h.deps, claimed(), event);
    expect(h.updates).toEqual([{ path: "glmOperations/op-1", data: { progress: [earlier, event], lastProgressAt: 9_000 } }]);
  });

  it("stays bounded by phase count when a waiting migration is requeued again and again", () => {
    let progress: MigrationProgressRecord[] = [];
    for (let round = 0; round < 50; round += 1) {
      progress = compactProgress(progress, { ...event, phase: "waiting-for-builder-idle", status: "pending", at: round * 2 });
      progress = compactProgress(progress, { ...event, phase: "waiting-for-builder-idle", status: "running", at: round * 2 + 1 });
    }
    expect(progress).toEqual([{ ...event, phase: "waiting-for-builder-idle", status: "running", at: 99 }]);
  });

  it("drops records from an earlier attempt or handoff when a new one reports", () => {
    const stale = [{ ...event, attempt: 1 }, { ...event, migrationId: "surge-old", phase: "gate-source" }];
    expect(compactProgress(stale, { ...event, attempt: 2 })).toEqual([{ ...event, attempt: 2 }]);
    expect(compactProgress(["junk", { ...event, phase: "gate-source", attempt: 2 }], { ...event, attempt: 2 }))
      .toEqual([{ ...event, phase: "gate-source", attempt: 2 }, { ...event, attempt: 2 }]);
  });

  it.each([
    ["re-claimed by a later attempt", { startedAt: 7_000, status: "running" }],
    ["reaped as failed with the same claim timestamp", { startedAt: 4_000, status: "failed" }],
    ["already completed", { startedAt: 4_000, status: "succeeded" }],
    ["deleted", undefined],
  ])("discards a late event once this attempt no longer owns a running operation: %s", async (_label, doc) => {
    const h = harness(doc ? { "glmOperations/op-1": doc } : {});
    await journalOperationProgress(h.deps, claimed(), event);
    expect(h.updates).toEqual([]);
    expect(h.deps.log).toHaveBeenCalledWith(expect.stringContaining("op=op-1 progress transfer-and-verify:running discarded"));
  });
});

describe("journalHandoffProgress", () => {
  const path = "gateways/shared-0/assignments/u1";
  const handoff = (migrationId: string, phase: string, at: number): MigrationProgressRecord =>
    ({ ...event, migrationId, phase, at });

  it("keeps one record per phase of the current handoff on the builder's assignment document", async () => {
    const first = handoff("surge-a", "gate-source", 1_000);
    const h = harness({ [path]: { state: "quiescing", handoffProgress: [first, handoff("surge-a", "transfer-and-verify", 1_500)] } });
    const next = handoff("surge-a", "transfer-and-verify", 2_000);
    await journalHandoffProgress(h.deps, { gatewayId: "shared-0", uid: "u1" }, next);
    expect(h.updates).toEqual([{ path, data: { handoffProgress: [first, next] } }]);
  });

  it("replaces the previous roll's journal when a new handoff starts", async () => {
    const h = harness({ [path]: { state: "quiescing", handoffProgress: [handoff("surge-a", "serving-handoff", 1_000), "junk"] } });
    const fresh = handoff("surge-b", "gate-source", 5_000);
    await journalHandoffProgress(h.deps, { gatewayId: "shared-0", uid: "u1" }, fresh);
    expect(h.updates).toEqual([{ path, data: { handoffProgress: [fresh] } }]);
  });

  it("discards progress for an assignment that no longer exists and says so", async () => {
    const h = harness({});
    await journalHandoffProgress(h.deps, { gatewayId: "shared-0", uid: "u1" }, event);
    expect(h.updates).toEqual([]);
    expect(h.deps.log).toHaveBeenCalledWith(expect.stringContaining("assignments/u1 is gone"));
  });
});
