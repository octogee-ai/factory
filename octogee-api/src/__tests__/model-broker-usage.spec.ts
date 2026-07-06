import { describe, expect, it } from "vitest";

import { MODEL_BROKER_WEEK_WINDOW_MS } from "@octogee/shared/types/model-broker-usage";
import {
  InMemoryModelBrokerUsageStore,
  estimateAnthropicCost,
  estimateModelBrokerCost,
  isUnknownOpenRouterPricingModel,
  mergeAnthropicUsage,
  modelRollupKey,
  normalizeAnthropicUsage,
  usageWindowStartMs,
  windowOwnerKey,
} from "../lib/model-broker-usage.js";

const baseRecord = {
  requestId: "req",
  provider: "anthropic" as const,
  gatewayId: "shared-blue",
  model: "claude-sonnet-4-6",
  usage: {
    inputTokens: 100,
    outputTokens: 50,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
  },
  method: "POST",
  path: "/v1/messages",
  upstreamStatus: 200,
  now: 10_000,
};

describe("model broker usage helpers", () => {
  it("normalizes Anthropic usage and merges streaming cumulative counters", () => {
    const start = normalizeAnthropicUsage({
      input_tokens: 10,
      output_tokens: 1,
      cache_creation_input_tokens: 2,
      cache_read_input_tokens: 3,
    });
    const delta = normalizeAnthropicUsage({ output_tokens: 8 });

    expect(mergeAnthropicUsage(start, delta)).toEqual({
      inputTokens: 10,
      outputTokens: 8,
      cacheCreationInputTokens: 2,
      cacheReadInputTokens: 3,
    });
  });

  it("estimates current Anthropic per-model costs with cache pricing", () => {
    const cost = estimateAnthropicCost(
      "anthropic/claude-sonnet-4-6",
      {
        inputTokens: 1_000_000,
        outputTokens: 1_000_000,
        cacheCreationInputTokens: 1_000_000,
        cacheReadInputTokens: 1_000_000,
      },
      "1h",
    );

    expect(cost.input).toBe(3);
    expect(cost.output).toBe(15);
    expect(cost.cacheWrite).toBe(6);
    expect(cost.cacheRead).toBeCloseTo(0.3);
    expect(cost.pricingModel).toBe("sonnet");
    expect(cost.cacheWriteTtl).toBe("1h");
    expect(cost.total).toBeCloseTo(24.3);
  });

  it.each([
    ["claude-fable-5-20260618", "fable", 10, 50],
    ["claude-mythos-5-20260618", "mythos", 10, 50],
    ["claude-opus-4-1-20250805", "opus-legacy", 15, 75],
    ["claude-opus-4-5-20260618", "opus-latest", 5, 25],
    ["claude-sonnet-4-6-20260618", "sonnet", 3, 15],
    ["claude-haiku-4-5-20260618", "haiku-4.5", 1, 5],
    ["claude-3-5-haiku-20241022", "haiku-3.5", 0.8, 4],
  ])("routes %s to %s pricing", (model, pricingModel, inputUsd, outputUsd) => {
    const cost = estimateAnthropicCost(model, {
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
    });

    expect(cost.pricingModel).toBe(pricingModel);
    expect(cost.input).toBe(inputUsd);
    expect(cost.output).toBe(outputUsd);
  });

  it("prices unknown models at a high fallback rate so caps fail closed", () => {
    const cost = estimateAnthropicCost("not-a-real-model", {
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
    });

    expect(cost).toMatchObject({
      input: 10,
      output: 50,
      total: 60,
      pricingModel: "unknown-fable-fallback",
    });
  });

  it("prices dated OpenRouter GLM 5.2 responses as the canonical GLM model", () => {
    const cost = estimateModelBrokerCost("openrouter", "z-ai/glm-5.2-20260616", {
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
    });

    expect(cost.pricingModel).toBe("openrouter:z-ai/glm-5.2");
    expect(isUnknownOpenRouterPricingModel(cost.pricingModel)).toBe(false);
    expect(cost.input).toBe(0.94);
    expect(cost.output).toBe(3);
  });

  it("keeps rollup keys and usage windows stable", () => {
    expect(modelRollupKey("anthropic/claude.sonnet 4.6")).toBe(
      "anthropic_claude_sonnet_4_6",
    );
    expect(usageWindowStartMs(4 * 60 * 60 * 1000 + 123)).toBe(4 * 60 * 60 * 1000);
  });

  it("keys the spend counter on the owner, falling back to the gateway", () => {
    expect(windowOwnerKey({ ownerUid: "uid-a", gatewayId: "shared-blue" })).toBe("uid-a");
    expect(windowOwnerKey({ ownerUid: null, gatewayId: "builder-7" })).toBe("builder-7");
  });
});

describe("OpenRouter cost estimation", () => {
  const MILLION_EACH = {
    inputTokens: 1_000_000,
    outputTokens: 1_000_000,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 1_000_000,
  };

  it("bills OpenRouter cache reads at the discounted rate, not full input price", () => {
    const cost = estimateModelBrokerCost("openrouter", "z-ai/glm-5.2", MILLION_EACH);
    expect(cost.input).toBeCloseTo(0.94);
    expect(cost.output).toBeCloseTo(3);
    expect(cost.cacheRead).toBeCloseTo(0.094);
    expect(cost.total).toBeCloseTo(4.034);
    expect(cost.pricingModel).toBe("openrouter:z-ai/glm-5.2");
  });

  it("prices unknown OpenRouter models at the fallback rate", () => {
    const cost = estimateModelBrokerCost("openrouter", "acme/unknown-1", MILLION_EACH);
    expect(cost.pricingModel).toBe("openrouter:unknown-fallback");
    expect(cost.input).toBe(1);
    expect(cost.output).toBe(5);
    expect(cost.cacheRead).toBeCloseTo(0.1);
  });
});

describe("reported upstream cost", () => {
  const openRouterRecord = {
    ...baseRecord,
    provider: "openrouter" as const,
    model: "z-ai/glm-5.2-20260616",
    path: "/v1/chat/completions",
  };

  it("meters the upstream-reported cost, not the table estimate, when present", async () => {
    const store = new InMemoryModelBrokerUsageStore();
    await store.recordUsage({
      ...openRouterRecord,
      eventId: "r1",
      ownerUid: "uid-a",
      reportedCostUsd: 0.0123,
    });
    const window = await store.readWindowUsage({
      gatewayId: "shared-blue",
      ownerUid: "uid-a",
      now: 10_000,
    });
    expect(window.costUsd).toBeCloseTo(0.0123, 8);
    const event = store.events[0];
    expect(event.costUsd).toBeCloseTo(0.0123, 8);
    expect((event.pricing as Record<string, unknown>).source).toBe("openrouter_reported");
  });

  it("scales the cost breakdown so it still sums to the reported total", async () => {
    const store = new InMemoryModelBrokerUsageStore();
    await store.recordUsage({
      ...openRouterRecord,
      eventId: "r2",
      ownerUid: "uid-a",
      reportedCostUsd: 0.01,
    });
    const breakdown = store.events[0].costBreakdown as Record<string, number>;
    const sum = breakdown.input + breakdown.output + breakdown.cacheRead + breakdown.cacheWrite;
    expect(sum).toBeCloseTo(0.01, 8);
  });

  it("falls back to the table estimate without a reported cost and marks the source", async () => {
    const store = new InMemoryModelBrokerUsageStore();
    await store.recordUsage({ ...openRouterRecord, eventId: "r3", ownerUid: "uid-a" });
    const event = store.events[0];
    expect((event.pricing as Record<string, unknown>).source).toBe("estimated");
    expect(event.costUsd).toBeGreaterThan(0);
  });
});

describe("weekly spend ledger", () => {
  it("meters countable traffic into the epoch-aligned week window", async () => {
    const store = new InMemoryModelBrokerUsageStore();
    await store.recordUsage({ ...baseRecord, eventId: "w1", ownerUid: "uid-a" });
    await store.recordUsage({ ...baseRecord, eventId: "w2", ownerUid: "uid-a" });
    const week = await store.readWeekUsage({
      gatewayId: "shared-blue",
      ownerUid: "uid-a",
      now: 10_000,
    });
    expect(week.weekStartMs).toBe(0);
    expect(week.requestCount).toBe(2);
    expect(week.totalTokens).toBe(300);
    expect(week.costUsd).toBeGreaterThan(0);
  });

  it("starts a fresh ledger at the next epoch week", async () => {
    const store = new InMemoryModelBrokerUsageStore();
    await store.recordUsage({ ...baseRecord, eventId: "w3", ownerUid: "uid-a" });
    const nextWeek = await store.readWeekUsage({
      gatewayId: "shared-blue",
      ownerUid: "uid-a",
      now: MODEL_BROKER_WEEK_WINDOW_MS + 5,
    });
    expect(nextWeek.weekStartMs).toBe(MODEL_BROKER_WEEK_WINDOW_MS);
    expect(nextWeek.requestCount).toBe(0);
    expect(nextWeek.costUsd).toBe(0);
  });

  it("keeps house/free traffic and other owners out of the weekly ledger", async () => {
    const store = new InMemoryModelBrokerUsageStore();
    await store.recordUsage({
      ...baseRecord,
      eventId: "w4",
      ownerUid: "uid-free",
      degraded: true,
      countsTowardSpendWindow: false,
    });
    await store.recordUsage({ ...baseRecord, eventId: "w5", ownerUid: "uid-b" });
    const free = await store.readWeekUsage({
      gatewayId: "shared-blue",
      ownerUid: "uid-free",
      now: 10_000,
    });
    const b = await store.readWeekUsage({
      gatewayId: "shared-blue",
      ownerUid: "uid-b",
      now: 10_000,
    });
    expect(free.requestCount).toBe(0);
    expect(b.requestCount).toBe(1);
  });
});

describe("InMemoryModelBrokerUsageStore owner isolation", () => {
  it("never lets one builder's spend bleed into another's window on a shared gateway", async () => {
    const store = new InMemoryModelBrokerUsageStore();
    await store.recordUsage({ ...baseRecord, eventId: "a", ownerUid: "uid-a" });
    await store.recordUsage({ ...baseRecord, eventId: "b1", ownerUid: "uid-b" });
    await store.recordUsage({ ...baseRecord, eventId: "b2", ownerUid: "uid-b" });

    const a = await store.readWindowUsage({ gatewayId: "shared-blue", ownerUid: "uid-a", now: 10_000 });
    const b = await store.readWindowUsage({ gatewayId: "shared-blue", ownerUid: "uid-b", now: 10_000 });
    expect(a.requestCount).toBe(1);
    expect(b.requestCount).toBe(2);
    expect(b.costUsd).toBeGreaterThan(a.costUsd);
  });

  it("does not count house/free traffic toward the spend window", async () => {
    const store = new InMemoryModelBrokerUsageStore();
    await store.recordUsage({
      ...baseRecord,
      eventId: "free",
      ownerUid: "uid-free",
      countsTowardSpendWindow: false,
    });
    const w = await store.readWindowUsage({ gatewayId: "shared-blue", ownerUid: "uid-free", now: 10_000 });
    expect(w.costUsd).toBe(0);
    expect(w.requestCount).toBe(0);
  });
});

describe("prepaid credit debits", () => {
  it("debits the owner's credit balance atomically with the metering write", async () => {
    const store = new InMemoryModelBrokerUsageStore();
    store.creditBalances.set("uid-builder", 10);
    await store.recordUsage({
      ...baseRecord,
      eventId: "c1",
      ownerUid: "uid-builder",
      debitsCreditBalance: true,
      countsTowardSpendWindow: false,
    });
    const cost = estimateAnthropicCost("claude-sonnet-4-6", baseRecord.usage).total;
    expect(await store.readCreditBalance("uid-builder")).toBeCloseTo(10 - cost, 8);
    // still fully metered for the ledger
    expect(store.rollups.get("uid-builder")?.requestCount).toBe(1);
  });

  it("never debits subscription-rail traffic and defaults unknown owners to zero balance", async () => {
    const store = new InMemoryModelBrokerUsageStore();
    store.creditBalances.set("uid-a", 5);
    await store.recordUsage({ ...baseRecord, eventId: "s1", ownerUid: "uid-a" });
    expect(await store.readCreditBalance("uid-a")).toBe(5);
    expect(await store.readCreditBalance("uid-nobody")).toBe(0);
  });

  it("allows the final call to overshoot slightly negative — the gate blocks the next one", async () => {
    const store = new InMemoryModelBrokerUsageStore();
    store.creditBalances.set("uid-builder", 0.0001);
    await store.recordUsage({
      ...baseRecord,
      eventId: "c2",
      ownerUid: "uid-builder",
      debitsCreditBalance: true,
      countsTowardSpendWindow: false,
    });
    expect(await store.readCreditBalance("uid-builder")).toBeLessThan(0);
  });
});

describe("house daily allowance metering", () => {
  it("meters degraded house traffic against the owner's UTC-day allowance", async () => {
    const store = new InMemoryModelBrokerUsageStore();
    await store.recordUsage({
      ...baseRecord,
      eventId: "h1",
      ownerUid: "uid-free",
      degraded: true,
      countsTowardSpendWindow: false,
    });
    await store.recordUsage({
      ...baseRecord,
      eventId: "h2",
      ownerUid: "uid-free",
      degraded: true,
      countsTowardSpendWindow: false,
    });
    const day = await store.readHouseDayUsage({
      gatewayId: "shared-blue",
      ownerUid: "uid-free",
      now: 10_000,
    });
    expect(day.totalTokens).toBe(300); // 2 × (100 in + 50 out)
    expect(day.requestCount).toBe(2);
  });

  it("does not meter paid (non-degraded) traffic against the house allowance", async () => {
    const store = new InMemoryModelBrokerUsageStore();
    await store.recordUsage({ ...baseRecord, eventId: "paid", ownerUid: "uid-a" });
    const day = await store.readHouseDayUsage({
      gatewayId: "shared-blue",
      ownerUid: "uid-a",
      now: 10_000,
    });
    expect(day.totalTokens).toBe(0);
    expect(day.requestCount).toBe(0);
  });

  it("keeps house-day counters isolated per owner", async () => {
    const store = new InMemoryModelBrokerUsageStore();
    await store.recordUsage({
      ...baseRecord,
      eventId: "fa",
      ownerUid: "uid-a",
      degraded: true,
      countsTowardSpendWindow: false,
    });
    const other = await store.readHouseDayUsage({
      gatewayId: "shared-blue",
      ownerUid: "uid-b",
      now: 10_000,
    });
    expect(other.totalTokens).toBe(0);
  });
});
