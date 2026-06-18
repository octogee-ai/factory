import { describe, expect, it } from "vitest";

import {
  estimateAnthropicCost,
  mergeAnthropicUsage,
  modelRollupKey,
  normalizeAnthropicUsage,
  usageWindowStartMs,
} from "../lib/model-broker-usage.js";

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
});
