import { describe, expect, it } from "vitest";

import {
  InMemoryModelBrokerUsageStore,
  estimateAnthropicCost,
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
