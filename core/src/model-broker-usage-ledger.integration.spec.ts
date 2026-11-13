import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createPostgresModelBrokerUsageLedger,
  type ModelBrokerUsageLedger,
  type ModelBrokerUsageLedgerEntry,
} from "./model-broker-usage-ledger.js";
import { createHarness, dsn, type PlatformStateHarness } from "./platform-state/postgres/__tests__/fixtures/harness.js";

const WINDOW = 1_000_000;
const WEEK = 900_000;
const NEXT_WINDOW = WINDOW + 18_000_000;
const EXPIRES = 9_000_000_000;
const NO_SPEND = { requestCount: 0, totalTokens: 0, costUsd: 0, chargeUsd: 0 };

function entry(overrides: Partial<ModelBrokerUsageLedgerEntry> = {}): ModelBrokerUsageLedgerEntry {
  return {
    eventId: "event-1",
    ownerKey: "shared-1:uid-lin",
    createdAt: WINDOW + 5,
    expiresAt: EXPIRES,
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
    expect(await harness.query("SELECT event_id, expires_at::text AS expires_at, event ->> 'model' AS model FROM $schema.model_broker_usage_events ORDER BY event_id"))
      .toEqual([
        { event_id: "event-1", expires_at: String(EXPIRES), model: "deepseek/deepseek-v4-pro" },
        { event_id: "event-2", expires_at: String(EXPIRES), model: "deepseek/deepseek-v4-pro" },
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

    await expect(ledger.readSpend("shared-1:uid-lin", "window", WINDOW)).resolves.toEqual(NO_SPEND);
    expect(await harness.query("SELECT count(*)::int AS events FROM $schema.model_broker_usage_events"))
      .toEqual([{ events: 1 }]);
  });

  it("keeps owners and periods apart", async () => {
    await ledger.record(entry());
    await ledger.record(entry({ eventId: "event-2", ownerKey: "shared-1:uid-sam" }));

    await expect(ledger.readSpend("shared-1:uid-lin", "window", WINDOW)).resolves.toMatchObject({ requestCount: 1 });
    await expect(ledger.readSpend("shared-1:uid-sam", "window", WINDOW)).resolves.toMatchObject({ requestCount: 1 });
    await expect(ledger.readSpend("shared-1:uid-lin", "week", WEEK)).resolves.toMatchObject({ requestCount: 1 });
  });

  it("keeps one spend row per owner and period, starting over when a new period begins", async () => {
    await ledger.record(entry());
    await ledger.record(entry({ eventId: "event-2", spendPeriods: [{ period: "window", startMs: NEXT_WINDOW }, { period: "week", startMs: WEEK }] }));

    await expect(ledger.readSpend("shared-1:uid-lin", "window", NEXT_WINDOW))
      .resolves.toEqual({ requestCount: 1, totalTokens: 1_500, costUsd: 0.25, chargeUsd: 0.25 });
    await expect(ledger.readSpend("shared-1:uid-lin", "window", WINDOW)).resolves.toEqual(NO_SPEND);
    await expect(ledger.readSpend("shared-1:uid-lin", "week", WEEK)).resolves.toMatchObject({ requestCount: 2 });
    expect(await harness.query("SELECT count(*)::int AS rows FROM $schema.model_broker_spend_periods")).toEqual([{ rows: 2 }]);
  });

  it("keeps a late call from an ended period out of the current one", async () => {
    await ledger.record(entry({ spendPeriods: [{ period: "window", startMs: NEXT_WINDOW }] }));

    expect(await ledger.record(entry({ eventId: "event-late" }))).toBe(true);

    await expect(ledger.readSpend("shared-1:uid-lin", "window", NEXT_WINDOW)).resolves.toMatchObject({ requestCount: 1 });
    await expect(ledger.readSpend("shared-1:uid-lin", "week", WEEK)).resolves.toMatchObject({ requestCount: 1 });
  });

  it("reserves requests per rate window under concurrency in one row per key", async () => {
    const counts = await Promise.all(Array.from({ length: 8 }, () => ledger.reserveRequest("shared-1:uid-lin", 60_000)));

    expect([...counts].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    await expect(ledger.reserveRequest("shared-1:uid-lin", 120_000)).resolves.toBe(1);
    await expect(ledger.reserveRequest("shared-1:uid-lin", 60_000)).resolves.toBe(2);
    await expect(ledger.reserveRequest("shared-1:uid-lin:embedding", 60_000)).resolves.toBe(1);
    expect(await harness.query("SELECT owner_key, start_ms::text AS start_ms, request_count FROM $schema.model_broker_rate_windows ORDER BY owner_key"))
      .toEqual([
        { owner_key: "shared-1:uid-lin", start_ms: "120000", request_count: 2 },
        { owner_key: "shared-1:uid-lin:embedding", start_ms: "60000", request_count: 1 },
      ]);
  });

  it.each([
    ["a negative cost", { costUsd: -1 }],
    ["a fractional token count", { totalTokens: 1.5 }],
    ["an empty event id", { eventId: "" }],
    ["a negative expiry", { expiresAt: -1 }],
    ["an unknown spend period", { spendPeriods: [{ period: "month", startMs: WINDOW }] }],
  ])("refuses %s and writes nothing", async (_label, overrides) => {
    await expect(ledger.record(entry(overrides as Partial<ModelBrokerUsageLedgerEntry>))).rejects.toThrow(/model broker usage/);
    expect(await harness.query("SELECT count(*)::int AS events FROM $schema.model_broker_usage_events"))
      .toEqual([{ events: 0 }]);
  });
});
