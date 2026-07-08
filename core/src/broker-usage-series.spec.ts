import { describe, it, expect } from "vitest";
import { readOwnerBrokerUsageSeries } from "./broker-usage-series.js";

interface EventDoc {
  createdAt: number;
  model: string;
  totalTokens: number;
  costUsd: number;
}

function fakeDb(events: EventDoc[], capture?: { where: Array<[string, string, unknown]> }) {
  const query = {
    where(field: string, op: string, value: unknown) {
      capture?.where.push([field, op, value]);
      return query;
    },
    orderBy() {
      return query;
    },
    select() {
      return query;
    },
    limit() {
      return query;
    },
    async get() {
      return { docs: events.map((e) => ({ data: () => e })) };
    },
  };
  return { collection: () => query } as unknown as Parameters<typeof readOwnerBrokerUsageSeries>[0];
}

const D = (iso: string) => new Date(iso).getTime();

describe("readOwnerBrokerUsageSeries", () => {
  it("aggregates broker cost per model — the truth openclaw's $0 self-report misses", async () => {
    const db = fakeDb([
      { createdAt: D("2026-07-06T10:00:00Z"), model: "z-ai/glm-5.2", totalTokens: 1_000_000, costUsd: 0.42 },
      { createdAt: D("2026-07-06T11:00:00Z"), model: "z-ai/glm-5.2", totalTokens: 700_000, costUsd: 0.30 },
      { createdAt: D("2026-07-05T09:00:00Z"), model: "anthropic/claude-sonnet-4-6", totalTokens: 50_000, costUsd: 0.15 },
    ]);
    const series = await readOwnerBrokerUsageSeries(db, "uid-1", D("2026-06-06T00:00:00Z"));

    expect(series.models).toEqual([
      { model: "z-ai/glm-5.2", tokens: 1_700_000, costUsd: 0.72, calls: 2, lastUsedAt: D("2026-07-06T11:00:00Z") },
      { model: "anthropic/claude-sonnet-4-6", tokens: 50_000, costUsd: 0.15, calls: 1, lastUsedAt: D("2026-07-05T09:00:00Z") },
    ]);
    expect(series.totalCostUsd).toBeCloseTo(0.87, 6);
    expect(series.totalTokens).toBe(1_750_000);
    expect(series.totalCalls).toBe(3);
  });

  it("rolls up per date, newest first", async () => {
    const db = fakeDb([
      { createdAt: D("2026-07-06T10:00:00Z"), model: "z-ai/glm-5.2", totalTokens: 100, costUsd: 0.5 },
      { createdAt: D("2026-07-06T23:00:00Z"), model: "z-ai/glm-5.2", totalTokens: 200, costUsd: 0.25 },
      { createdAt: D("2026-07-05T09:00:00Z"), model: "z-ai/glm-5.2", totalTokens: 300, costUsd: 0.10 },
    ]);
    const series = await readOwnerBrokerUsageSeries(db, "uid-1", 0);
    expect(series.sessions).toEqual([
      { date: "2026-07-06", tokens: 300, costUsd: 0.75, calls: 2 },
      { date: "2026-07-05", tokens: 300, costUsd: 0.10, calls: 1 },
    ]);
  });

  it("queries the owner's events over the date window on the composite index", async () => {
    const capture = { where: [] as Array<[string, string, unknown]> };
    await readOwnerBrokerUsageSeries(fakeDb([], capture), "uid-9", 1_700_000_000_000);
    expect(capture.where).toEqual([
      ["ownerUid", "==", "uid-9"],
      ["createdAt", ">=", 1_700_000_000_000],
    ]);
  });

  it("empty for an owner with no platform (broker) traffic — e.g. pure BYOSUB", async () => {
    const series = await readOwnerBrokerUsageSeries(fakeDb([]), "uid-byosub", 0);
    expect(series).toMatchObject({ models: [], sessions: [], totalCostUsd: 0, totalTokens: 0, totalCalls: 0 });
  });

  it("skips events with a missing/invalid createdAt (never groups under 1970 or poisons lastUsedAt)", async () => {
    const db = fakeDb([
      { createdAt: 0, model: "z-ai/glm-5.2", totalTokens: 500, costUsd: 0.9 },
      { createdAt: D("2026-07-06T10:00:00Z"), model: "z-ai/glm-5.2", totalTokens: 100, costUsd: 0.1 },
    ]);
    const series = await readOwnerBrokerUsageSeries(db, "uid-1", 0);
    expect(series.sessions.map((s) => s.date)).toEqual(["2026-07-06"]);
    expect(series.models[0]).toMatchObject({ tokens: 100, lastUsedAt: D("2026-07-06T10:00:00Z") });
    expect(series.totalTokens).toBe(100);
  });
});
