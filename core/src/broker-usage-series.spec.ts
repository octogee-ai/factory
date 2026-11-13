import { describe, it, expect } from "vitest";
import { BROKER_USAGE_SERIES_READ_LIMIT, brokerUsageSeries } from "./broker-usage-series.js";

const D = (iso: string) => new Date(iso).getTime();

describe("brokerUsageSeries", () => {
  it("aggregates broker cost per model — the truth openclaw's $0 self-report misses", () => {
    const series = brokerUsageSeries([
      { createdAt: D("2026-07-06T10:00:00Z"), model: "z-ai/glm-5.2", totalTokens: 1_000_000, costUsd: 0.42 },
      { createdAt: D("2026-07-06T11:00:00Z"), model: "z-ai/glm-5.2", totalTokens: 700_000, costUsd: 0.30 },
      { createdAt: D("2026-07-05T09:00:00Z"), model: "anthropic/claude-sonnet-4-6", totalTokens: 50_000, costUsd: 0.15 },
    ]);

    expect(series.models).toEqual([
      { model: "z-ai/glm-5.2", tokens: 1_700_000, costUsd: 0.72, calls: 2, lastUsedAt: D("2026-07-06T11:00:00Z") },
      { model: "anthropic/claude-sonnet-4-6", tokens: 50_000, costUsd: 0.15, calls: 1, lastUsedAt: D("2026-07-05T09:00:00Z") },
    ]);
    expect(series.totalCostUsd).toBeCloseTo(0.87, 6);
    expect(series.totalTokens).toBe(1_750_000);
    expect(series.totalCalls).toBe(3);
  });

  it("rolls up per date, newest first", () => {
    const series = brokerUsageSeries([
      { createdAt: D("2026-07-06T10:00:00Z"), model: "z-ai/glm-5.2", totalTokens: 100, costUsd: 0.5 },
      { createdAt: D("2026-07-06T23:00:00Z"), model: "z-ai/glm-5.2", totalTokens: 200, costUsd: 0.25 },
      { createdAt: D("2026-07-05T09:00:00Z"), model: "z-ai/glm-5.2", totalTokens: 300, costUsd: 0.10 },
    ]);
    expect(series.sessions).toEqual([
      { date: "2026-07-06", tokens: 300, costUsd: 0.75, calls: 2 },
      { date: "2026-07-05", tokens: 300, costUsd: 0.10, calls: 1 },
    ]);
  });

  it("empty for an owner with no platform (broker) traffic — e.g. pure BYOSUB", () => {
    expect(brokerUsageSeries([])).toMatchObject({
      models: [], sessions: [], totalCostUsd: 0, totalTokens: 0, totalCalls: 0, truncated: false,
    });
  });

  it("skips events with a missing/invalid createdAt (never groups under 1970 or poisons lastUsedAt)", () => {
    const series = brokerUsageSeries([
      { createdAt: 0, model: "z-ai/glm-5.2", totalTokens: 500, costUsd: 0.9 },
      { createdAt: D("2026-07-06T10:00:00Z"), model: "z-ai/glm-5.2", totalTokens: 100, costUsd: 0.1 },
    ]);
    expect(series.sessions.map((s) => s.date)).toEqual(["2026-07-06"]);
    expect(series.models[0]).toMatchObject({ tokens: 100, lastUsedAt: D("2026-07-06T10:00:00Z") });
    expect(series.totalTokens).toBe(100);
  });

  it("reports truncation once the events reach the read limit", () => {
    const event = { createdAt: D("2026-07-06T10:00:00Z"), model: "z-ai/glm-5.2", totalTokens: 1, costUsd: 0 };
    expect(brokerUsageSeries(Array.from({ length: BROKER_USAGE_SERIES_READ_LIMIT }, () => event)).truncated).toBe(true);
    expect(brokerUsageSeries(Array.from({ length: BROKER_USAGE_SERIES_READ_LIMIT - 1 }, () => event)).truncated).toBe(false);
  });
});
