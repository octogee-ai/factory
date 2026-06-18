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

  it("fails closed to zero-cost unknown pricing instead of inventing a rate", () => {
    const cost = estimateAnthropicCost("not-a-real-model", {
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
    });

    expect(cost).toMatchObject({ total: 0, pricingModel: "unknown" });
  });

  it("keeps rollup keys and usage windows stable", () => {
    expect(modelRollupKey("anthropic/claude.sonnet 4.6")).toBe(
      "anthropic_claude_sonnet_4_6",
    );
    expect(usageWindowStartMs(4 * 60 * 60 * 1000 + 123)).toBe(4 * 60 * 60 * 1000);
  });
});
