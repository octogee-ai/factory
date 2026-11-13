import { describe, expect, it } from "vitest";
import { parseOpenRouterCatalog } from "./openrouter-catalog";

const model = (overrides: Record<string, unknown> = {}) => ({
  id: "new-provider/new-agent",
  name: "New Provider: New Agent",
  context_length: 128_000,
  architecture: { input_modalities: ["text", "image", "file"], output_modalities: ["text"] },
  supported_parameters: ["tools", "reasoning"],
  top_provider: { max_completion_tokens: 16_000 },
  pricing: { prompt: "0.000002", completion: "0.00001", input_cache_read: "0.0000002" },
  ...overrides,
});

describe("parseOpenRouterCatalog", () => {
  it("admits new providers without a hand-maintained model allowlist", () => {
    expect(parseOpenRouterCatalog({ data: [model()] })).toEqual([
      expect.objectContaining({
        provider: "openrouter", id: "new-provider/new-agent", label: "New Agent",
        contextTokens: 128_000, input: ["text", "image"], maxOutputTokens: 16_000,
        reasoning: true,
        pricing: expect.objectContaining({ inputPerMTok: 2, outputPerMTok: 10, cacheReadPerMTok: expect.closeTo(0.2) }),
      }),
    ]);
  });

  it("excludes incompatible, expired, and batch-only models", () => {
    const excluded = [
      model({ supported_parameters: [] }),
      model({ architecture: { input_modalities: ["text"], output_modalities: ["image", "text"] } }),
      model({ id: "new-provider/new-agent:batch" }),
      model({ expiration_date: "2026-01-01" }),
      model({ context_length: 0 }),
      model({ id: "https://evil.example/model" }),
    ];
    expect(parseOpenRouterCatalog({ data: [...excluded, model()] }, "2026-09-15")).toHaveLength(1);
  });

  it("rejects an unusable response rather than replacing the catalog with nothing", () => {
    expect(() => parseOpenRouterCatalog({ error: "unavailable" })).toThrow();
    expect(() => parseOpenRouterCatalog({ data: [] })).toThrow();
    expect(() => parseOpenRouterCatalog({ data: [model(), model()] })).toThrow(/duplicate/i);
  });

  it("preserves every supported token-price tier", () => {
    const entries = parseOpenRouterCatalog({ data: [model({ pricing: {
      prompt: "0.000002", completion: "0.00001",
      overrides: [
        { min_prompt_tokens: 32_000, prompt: "0.000004" },
        { min_prompt_tokens: 256_000, prompt: "0.000008" },
        { utc_start: 1200, prompt: "0.000001" },
      ],
    } })] });
    expect(entries[0].pricingOverrides).toEqual([
      { aboveInputTokens: 32_000, inputPerMTok: 4 },
      { aboveInputTokens: 256_000, inputPerMTok: 8 },
    ]);
  });
});
