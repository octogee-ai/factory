import { describe, expect, it } from "vitest";
import type { ScheduleTransferDoc } from "@octogee/shared/types/fleet-controller";
import type { PlacementReceipt } from "@octogee/shared/types/placement-receipts";
import type { AgentStoreRecord } from "../../builders.js";
import { AlreadyExistsError, MalformedRecordError, MissingRecordError } from "../../errors.js";
import { NOW, REVISION, useBuilderFixture } from "./fixtures/builders.js";
import { dsn } from "./fixtures/harness.js";

const STORE_ID = "0f8fad5b-d9cb-469f-a165-70867728950e";
const OTHER_STORE_ID = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
const AGENT_STORE = "agent_store";
const MISSING_ALICE = { constructor: MissingRecordError, record: { aggregate: "builder", key: "alice" } };

function receipt(overrides: Partial<PlacementReceipt> = {}): PlacementReceipt {
  return {
    schemaVersion: 1,
    kind: "activated",
    at: NOW,
    builderSlug: "alice",
    leaseId: "lease-1",
    generation: 1,
    cause: "chat",
    sizingTier: "pro",
    entitlementTier: "pro",
    gatewayId: "alice-s-1",
    sharedGatewayId: "shared-a",
    requestedAt: NOW - 30_000,
    wakeDurationMs: 30_000,
    activeDurationMs: null,
    operationId: null,
    retirementOperationId: null,
    operatorTerminated: false,
    error: null,
    ...overrides,
  };
}

function transfer(overrides: Partial<ScheduleTransferDoc> = {}): ScheduleTransferDoc {
  return {
    migrationId: "mig-1",
    slug: "alice",
    sourceGatewayId: "alice-s-1",
    targetGatewayId: "shared-a",
    records: [
      { sourceJobId: "job-1", scratch: null, agentId: "octogee-alice-coach", job: { name: "daily", schedule: { kind: "cron", expr: "0 9 * * *" } } },
    ] as never,
    skipped: [{ jobId: "job-2", name: "orphan", reason: "agent-missing" }] as never,
    snapshotAt: NOW,
    ...overrides,
  };
}

describe.skipIf(!dsn)("PostgreSQL Builder placement receipts", () => {
  const fixture = useBuilderFixture();

  it("reads receipts back and lists them newest first with a receipt-id cursor", async () => {
    const { records, builders } = fixture();
    await records.create({ uid: "alice", createdAt: NOW });
    const receipts = builders.placementReceipts;
    await receipts.create("alice", receipt());
    await receipts.create("alice", receipt({ kind: "returned", at: NOW + 60_000, activeDurationMs: 60_000, wakeDurationMs: null }));
    await receipts.create("alice", receipt({ kind: "activation-failed", leaseId: "lease-2", generation: 2, at: NOW + 120_000, error: "boot timeout" }));

    expect(await receipts.get("alice", "lease-1", 1, "activated")).toEqual(receipt());
    expect(await receipts.get("alice", "lease-1", 1, "activation-failed")).toBeNull();
    expect(await receipts.get("bob", "lease-1", 1, "activated")).toBeNull();

    const first = await receipts.list("alice", { limit: 2 });
    expect(first.items.map((item) => item.kind)).toEqual(["activation-failed", "returned"]);
    expect(first.next).toBe("lease-1-1-returned");
    const second = await receipts.list("alice", { limit: 2, after: first.next! });
    expect(second).toEqual({ items: [receipt()], next: null });
    await expect(receipts.list("alice", { limit: 2, after: "lease-9-9-returned" })).rejects.toMatchObject({
      constructor: MissingRecordError,
      record: { aggregate: "placement-receipt", key: "alice/lease-9-9-returned" },
    });
    expect(await receipts.list("bob", { limit: 2 })).toEqual({ items: [], next: null });
  });

  it("breaks a tie on time by receipt id, newest id first", async () => {
    const { records, builders } = fixture();
    await records.create({ uid: "alice", createdAt: NOW });
    for (const leaseId of ["lease-a", "lease-c", "lease-b"]) await builders.placementReceipts.create("alice", receipt({ leaseId }));

    const page = await builders.placementReceipts.list("alice", { limit: 1, after: "lease-c-1-activated" });
    expect(page.items.map((item) => item.leaseId)).toEqual(["lease-b"]);
    expect(page.next).toBe("lease-b-1-activated");
  });

  it("creates a receipt once and refuses one for a missing Builder", async () => {
    const { records, builders } = fixture();
    await expect(builders.placementReceipts.create("alice", receipt())).rejects.toMatchObject(MISSING_ALICE);
    await records.create({ uid: "alice", createdAt: NOW });

    await builders.placementReceipts.create("alice", receipt());
    await expect(builders.placementReceipts.create("alice", receipt({ at: NOW + 1 }))).rejects.toMatchObject({
      constructor: AlreadyExistsError,
      record: { aggregate: "placement-receipt", key: "alice/lease-1-1-activated" },
    });
    expect(await builders.placementReceipts.get("alice", "lease-1", 1, "activated")).toEqual(receipt());
    await expect(builders.placementReceipts.create("alice", receipt({ leaseId: "" }))).rejects.toThrow("placement receipt requires a lease id");
  });
});

describe.skipIf(!dsn)("PostgreSQL Builder schedule transfers", () => {
  const fixture = useBuilderFixture();

  it("reads the saved snapshot and records restore progress as field updates", async () => {
    const { records, builders } = fixture();
    await records.create({ uid: "alice", createdAt: NOW });
    const transfers = builders.scheduleTransfers;
    await transfers.put("alice", transfer());

    expect(await transfers.get("alice", "mig-1")).toEqual({ ...transfer(), revision: expect.stringMatching(REVISION) });
    expect(await transfers.get("alice", "mig-2")).toBeNull();

    await transfers.patch("alice", "mig-1", { restoreAttemptedTo: "shared-a", restoreAttemptedAt: NOW + 5 });
    await transfers.patch("alice", "mig-1", { restoredTo: "shared-a", restoredAt: NOW + 6, restoreFailures: [] });
    expect(await transfers.get("alice", "mig-1")).toEqual({
      ...transfer(),
      restoreAttemptedTo: "shared-a",
      restoreAttemptedAt: NOW + 5,
      restoredTo: "shared-a",
      restoredAt: NOW + 6,
      restoreFailures: [],
      revision: expect.stringMatching(REVISION),
    });
    await transfers.patch("alice", "mig-1", { restoreAttemptedTo: { clear: true }, restoreAttemptedAt: { clear: true } });
    expect(await transfers.get("alice", "mig-1")).not.toHaveProperty("restoreAttemptedTo");
    await expect(transfers.patch("alice", "mig-2", { restoredTo: "shared-a" })).rejects.toMatchObject({
      constructor: MissingRecordError,
      record: { aggregate: "schedule-transfer", key: "alice/mig-2" },
    });
  });

  it("replaces the whole snapshot on put, ignores the revision it was read with, and moves the revision", async () => {
    const { records, builders } = fixture();
    await records.create({ uid: "alice", createdAt: NOW });
    const transfers = builders.scheduleTransfers;
    await transfers.put("alice", transfer({ restoredTo: "shared-a", restoredAt: NOW }));
    const stored = (await transfers.get("alice", "mig-1"))!;

    await transfers.put("alice", { ...stored, records: [], restoredTo: undefined, restoredAt: undefined });

    const replaced = (await transfers.get("alice", "mig-1"))!;
    expect(replaced).toEqual({ ...transfer(), records: [], revision: expect.stringMatching(REVISION) });
    expect(replaced.revision).not.toBe(stored.revision);
  });

  it("refuses a snapshot for a missing Builder and a patch that renames the migration", async () => {
    const { records, builders } = fixture();
    await expect(builders.scheduleTransfers.put("alice", transfer())).rejects.toMatchObject(MISSING_ALICE);
    await records.create({ uid: "alice", createdAt: NOW });
    await builders.scheduleTransfers.put("alice", transfer());
    await expect(builders.scheduleTransfers.patch("alice", "mig-1", { migrationId: "mig-9" } as never)).rejects.toThrow(TypeError);
  });
});

describe.skipIf(!dsn)("PostgreSQL Builder agent stores", () => {
  const fixture = useBuilderFixture();
  const coach: Extract<AgentStoreRecord, { kind: "agent" }> = {
    kind: "agent", agentId: "octogee-alice-coach", storeId: STORE_ID, schema: AGENT_STORE, gatewayId: "alice-s-1", generation: 3, assignmentEpoch: null, recordedAt: NOW,
  };
  const anchors: AgentStoreRecord[] = [
    coach,
    { kind: "agent", agentId: "octogee-alice-site", storeId: OTHER_STORE_ID, schema: AGENT_STORE, gatewayId: "shared-a", generation: null, assignmentEpoch: 7, recordedAt: NOW + 1 },
    { kind: "auxiliary", family: "team-reports", storeId: STORE_ID, schema: "team_reports", gatewayId: "alice-s-1", generation: 3, assignmentEpoch: null, recordedAt: NOW },
    { kind: "gateway-state", storeId: OTHER_STORE_ID, schema: "gateway_state", gatewayId: null, generation: 3, assignmentEpoch: null, recordedAt: NOW },
  ];

  it("writes each anchor shape under its store key and lists them back", async () => {
    const { records, builders, harness } = fixture();
    await records.create({ uid: "alice", createdAt: NOW });
    for (const anchor of anchors) await builders.agentStores.put("alice", anchor);

    const listed = await builders.agentStores.list("alice");
    expect(listed.map(({ revision: _revision, ...record }) => record)).toEqual([anchors[3], anchors[2], anchors[0], anchors[1]]);
    expect(listed.every((record) => REVISION.test(record.revision))).toBe(true);
    const keys = await harness.query("SELECT store_key, store_kind FROM $schema.agent_stores WHERE uid = 'alice' ORDER BY store_key");
    expect(keys).toEqual([
      { store_key: "_gateway-state", store_kind: "gateway-state" },
      { store_key: "_gateway-team-reports", store_kind: "auxiliary" },
      { store_key: "octogee-alice-coach", store_kind: "agent" },
      { store_key: "octogee-alice-site", store_kind: "agent" },
    ]);
    expect(await builders.agentStores.list("bob")).toEqual([]);
  });

  it("replaces an anchor on put and deletes anchors by store key", async () => {
    const { records, builders } = fixture();
    await records.create({ uid: "alice", createdAt: NOW });
    for (const anchor of anchors) await builders.agentStores.put("alice", anchor);
    const replaced: AgentStoreRecord = { ...anchors[0], gatewayId: null, generation: null, assignmentEpoch: 2, recordedAt: NOW + 9 };

    await builders.agentStores.put("alice", replaced);
    await builders.agentStores.delete("alice", "_gateway-team-reports");
    await builders.agentStores.delete("alice", "octogee-alice-site");
    await builders.agentStores.delete("alice", "octogee-alice-gone");

    expect((await builders.agentStores.list("alice")).map(({ revision: _revision, ...record }) => record)).toEqual([anchors[3], replaced]);
  });

  it("refuses an agent id that would land on a reserved store key, and an anchor for a missing Builder", async () => {
    const { records, builders } = fixture();
    await expect(builders.agentStores.put("alice", anchors[0])).rejects.toMatchObject(MISSING_ALICE);
    await records.create({ uid: "alice", createdAt: NOW });
    await expect(builders.agentStores.put("alice", { ...coach, agentId: "_gateway-state" })).rejects.toThrow(TypeError);
    await expect(builders.agentStores.put("alice", { ...coach, agentId: "_private" })).rejects.toThrow(TypeError);
    expect(await builders.agentStores.list("alice")).toEqual([]);
  });

  it("rejects an auxiliary anchor whose family does not name its store key", async () => {
    const { records, harness, builders } = fixture();
    await records.create({ uid: "alice", createdAt: NOW });
    await harness.query(
      `INSERT INTO $schema.agent_stores (uid, store_key, store_id, family, schema, recorded_at)
       VALUES ('alice', '_gateway-logbook', $1::text, 'workboard', 'workboard', $2::bigint)`,
      [STORE_ID, NOW],
    );

    await expect(builders.agentStores.list("alice")).rejects.toMatchObject({
      constructor: MalformedRecordError,
      record: { aggregate: "agent-store", key: "alice/_gateway-logbook" },
      detail: "family workboard does not name the _gateway-logbook auxiliary store",
    });
  });
});
