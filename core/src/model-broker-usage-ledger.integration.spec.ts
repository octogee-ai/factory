import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createPostgresModelBrokerUsageLedger,
  type ModelBrokerUsageLedger,
  type ModelBrokerUsageLedgerEntry,
} from "./model-broker-usage-ledger.js";
import { createHarness, dsn, type PlatformStateHarness } from "./platform-state/postgres/__tests__/fixtures/harness.js";

const WINDOW = 1_000_000;
const WEEK = 900_000;

function entry(overrides: Partial<ModelBrokerUsageLedgerEntry> = {}): ModelBrokerUsageLedgerEntry {
  return {
    eventId: "event-1",
    ownerKey: "shared-1:uid-lin",
    createdAt: WINDOW + 5,
    event: { provider: "openrouter", model: "deepseek/deepseek-v4-pro", gatewayId: "shared-1", ownerUid: "uid-lin" },
    totalTokens: 1_500,
    costUsd: 0.25,
    chargeUsd: 0.25,
    spendPeriods: [{ period: "window", startMs: WINDOW }, { period: "week", startMs: WEEK }],
    ...overrides,
  };
}

describe.skipIf(!dsn)("PostgreSQL model broker usage ledger", () => {
  let harness: PlatformStateHarness;
  let ledger: ModelBrokerUsageLedger;

  beforeEach(async () => {
    harness = await createHarness();
    ledger = createPostgresModelBrokerUsageLedger(harness.pool, harness.schema);
  });

  afterEach(async () => {
    await harness?.dispose();
  });

  it("keeps each call and adds it to the owner's spend window and week", async () => {
    expect(await ledger.record(entry())).toBe(true);
    expect(await ledger.record(entry({ eventId: "event-2", totalTokens: 500, costUsd: 0.5, chargeUsd: 0.75 }))).toBe(true);

    await expect(ledger.readSpend("shared-1:uid-lin", "window", WINDOW))
      .resolves.toEqual({ requestCount: 2, totalTokens: 2_000, costUsd: 0.75, chargeUsd: 1 });
    await expect(ledger.readSpend("shared-1:uid-lin", "week", WEEK))
      .resolves.toEqual({ requestCount: 2, totalTokens: 2_000, costUsd: 0.75, chargeUsd: 1 });
    expect(await harness.query("SELECT event_id, event ->> 'model' AS model FROM $schema.model_broker_usage_events ORDER BY event_id"))
      .toEqual([
        { event_id: "event-1", model: "deepseek/deepseek-v4-pro" },
        { event_id: "event-2", model: "deepseek/deepseek-v4-pro" },
      ]);
  });

  it("counts a repeated event once", async () => {
    expect(await ledger.record(entry())).toBe(true);
    expect(await ledger.record(entry())).toBe(false);
    await Promise.all([ledger.record(entry({ eventId: "event-2" })), ledger.record(entry({ eventId: "event-2" }))]);

    await expect(ledger.readSpend("shared-1:uid-lin", "window", WINDOW))
      .resolves.toMatchObject({ requestCount: 2, totalTokens: 3_000 });
  });

  it("records a call that does not count toward spend without moving the spend periods", async () => {
    await ledger.record(entry({ spendPeriods: [] }));

    await expect(ledger.readSpend("shared-1:uid-lin", "window", WINDOW))
      .resolves.toEqual({ requestCount: 0, totalTokens: 0, costUsd: 0, chargeUsd: 0 });
    expect(await harness.query("SELECT count(*)::int AS events FROM $schema.model_broker_usage_events"))
      .toEqual([{ events: 1 }]);
  });

  it("keeps owners and periods apart", async () => {
    await ledger.record(entry());
    await ledger.record(entry({ eventId: "event-2", ownerKey: "shared-1:uid-sam" }));
    await ledger.record(entry({ eventId: "event-3", spendPeriods: [{ period: "window", startMs: WINDOW + 18_000_000 }] }));

    await expect(ledger.readSpend("shared-1:uid-lin", "window", WINDOW)).resolves.toMatchObject({ requestCount: 1 });
    await expect(ledger.readSpend("shared-1:uid-sam", "window", WINDOW)).resolves.toMatchObject({ requestCount: 1 });
    await expect(ledger.readSpend("shared-1:uid-lin", "window", WINDOW + 18_000_000)).resolves.toMatchObject({ requestCount: 1 });
    await expect(ledger.readSpend("shared-1:uid-lin", "week", WEEK)).resolves.toMatchObject({ requestCount: 1 });
  });

  it("reserves requests per rate window under concurrency", async () => {
    const counts = await Promise.all(Array.from({ length: 8 }, () => ledger.reserveRequest("shared-1:uid-lin", 60_000)));

    expect([...counts].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    await expect(ledger.reserveRequest("shared-1:uid-lin", 120_000)).resolves.toBe(1);
    await expect(ledger.reserveRequest("shared-1:uid-lin:embedding", 60_000)).resolves.toBe(1);
  });

  it.each([
    ["a negative cost", { costUsd: -1 }],
    ["a fractional token count", { totalTokens: 1.5 }],
    ["an empty event id", { eventId: "" }],
    ["an unknown spend period", { spendPeriods: [{ period: "month", startMs: WINDOW }] }],
  ])("refuses %s and writes nothing", async (_label, overrides) => {
    await expect(ledger.record(entry(overrides as Partial<ModelBrokerUsageLedgerEntry>))).rejects.toThrow(/model broker usage/);
    expect(await harness.query("SELECT count(*)::int AS events FROM $schema.model_broker_usage_events"))
      .toEqual([{ events: 0 }]);
  });
});
