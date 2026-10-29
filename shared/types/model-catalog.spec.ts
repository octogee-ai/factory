import { describe, expect, it } from "vitest";

import {
  MODEL_CATALOG,
  VERTEX_MODEL_CATALOG,
  isModelCatalogProvider,
  isModelReasoningEffort,
  modelCatalogEntryFor,
  modelCatalogForProvider,
} from "./model-catalog";

describe("MODEL_CATALOG", () => {
  it("serves direct providers and the broad OpenRouter catalog", () => {
    expect(modelCatalogForProvider("anthropic").map((e) => e.id)).toEqual(expect.arrayContaining([
      "anthropic/claude-opus-5",
      "anthropic/claude-sonnet-5",
      "anthropic/claude-fable-5-1",
      "anthropic/claude-sonnet-4-6",
      "anthropic/claude-haiku-4-5",
    ]));
    expect(modelCatalogForProvider("openrouter").map((e) => e.id)).toEqual(expect.arrayContaining([
      "z-ai/glm-5.2",
      "minimax/minimax-m3",
      "deepseek/deepseek-v4-pro",
      "openai/gpt-5.6-luna",
      "openai/gpt-6-astra",
      "anthropic/claude-opus-5",
      "x-ai/grok-4.6",
      "google/gemini-3.8-flash",
    ]));
  });

  it("carries DeepSeek V4 Pro as a free-tier dial candidate", () => {
    const entry = modelCatalogEntryFor("openrouter", "deepseek/deepseek-v4-pro");
    expect(entry?.label).toContain("DeepSeek V4 Pro");
    expect(entry?.contextTokens).toBe(1_048_576);
    expect(entry?.reasoningEfforts).toEqual(["high", "xhigh"]);
  });

  it("offers canonical Flash Lite without its retired preview alias", () => {
    const ids = modelCatalogForProvider("openrouter").map((entry) => entry.id);
    expect(ids).toContain("google/gemini-3.1-flash-lite");
    expect(ids).not.toContain("google/gemini-3.1-flash-lite-preview");
    expect(modelCatalogEntryFor("openrouter", "google/gemini-3.1-flash-lite-preview")).toBeNull();
  });

  it("carries GPT-5.6 Luna through OpenRouter with its full context window", () => {
    const entry = modelCatalogEntryFor("openrouter", "openai/gpt-5.6-luna");
    expect(entry).toMatchObject({
      label: "GPT-5.6 Luna",
      source: "openrouter",
      contextTokens: 1_050_000,
      reasoningEfforts: ["high", "xhigh"],
    });
  });

  it.each(["luna", "sol", "astra"].flatMap((model) => [model, `${model}-pro`]))(
    "exposes GPT-6 %s through OpenRouter with reasoning, images, and long-context pricing",
    (model) => {
      const entry = modelCatalogEntryFor("openrouter", `openai/gpt-6-${model}`);
      expect(entry).toMatchObject({
        provider: "openrouter",
        source: "openrouter",
        contextTokens: 1_050_000,
        maxOutputTokens: 128_000,
        input: ["text", "image"],
        reasoning: true,
        reasoningEfforts: ["high", "xhigh"],
      });
      expect(entry?.pricing?.inputPerMTok).toBeGreaterThan(0);
      expect(entry?.pricing?.outputPerMTok).toBeGreaterThan(0);
      expect(entry?.pricingOverrides).toEqual([
        expect.objectContaining({ aboveInputTokens: 272_000 }),
      ]);
    },
  );

  it("marks the GPT models as image-capable and leaves the others text-only", () => {
    expect(modelCatalogEntryFor("openrouter", "openai/gpt-5.6-luna")?.input).toEqual(["text", "image"]);
    expect(modelCatalogEntryFor("openai", "gpt-5.4-mini")?.input).toEqual(["text", "image"]);
    expect(modelCatalogEntryFor("openrouter", "z-ai/glm-5.2")?.input).toEqual(["text"]);
  });

  it.each([
    ["gpt-6-luna", "GPT-6 Luna", { inputPerMTok: 0.1, cacheReadPerMTok: 0.01, outputPerMTok: 0.5 }],
    ["gpt-6.1-terra", "GPT-6.1 Terra", { inputPerMTok: 1, cacheReadPerMTok: 0.05, outputPerMTok: 5 }],
    ["gpt-6.1-sol", "GPT-6.1 Sol", { inputPerMTok: 2, cacheReadPerMTok: 0.1, outputPerMTok: 10 }],
  ])("carries %s on the OpenAI platform provider at its standard-tier list price", (id, label, pricing) => {
    const entry = modelCatalogEntryFor("openai", id);
    expect(entry).toMatchObject({ provider: "openai", label, source: "openai", reasoning: true, input: ["text", "image"] });
    expect(entry?.pricing).toMatchObject(pricing);
  });

  it("carries GPT-5.4 Mini on the OpenAI platform provider", () => {
    expect(modelCatalogForProvider("openai").map((e) => e.id)).toEqual(expect.arrayContaining(["gpt-6-astra", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.4-mini"]));
    const entry = modelCatalogEntryFor("openai", "gpt-5.4-mini");
    expect(entry?.label).toBe("GPT-5.4 Mini");
    expect(entry?.contextTokens).toBe(400_000);
    expect(entry?.reasoningEfforts).toEqual([]);
  });

  it("every entry carries the fields the gateway materializer and PWA picker need", () => {
    for (const entry of MODEL_CATALOG) {
      expect(entry.label.length).toBeGreaterThan(0);
      expect(isModelCatalogProvider(entry.provider)).toBe(true);
    }
    // openrouter entries must size the provider config's context window
    for (const entry of modelCatalogForProvider("openrouter")) {
      expect(entry.contextTokens).toBeGreaterThan(0);
    }
  });

  it("resolves entries by id and by alias, null for strangers", () => {
    expect(modelCatalogEntryFor("anthropic", "anthropic/claude-haiku-4-5")?.label).toBe(
      "Claude Haiku 4.5",
    );
    expect(modelCatalogEntryFor("anthropic", "claude-haiku-4-5")?.id).toBe(
      "anthropic/claude-haiku-4-5",
    );
    expect(modelCatalogEntryFor("openrouter", "z-ai/glm-5.2")?.defaultReasoningEffort).toBe(
      "xhigh",
    );
    expect(modelCatalogEntryFor("openrouter", "gpt-nonexistent")).toBeNull();
  });

  it("guards provider and reasoning-effort strings", () => {
    expect(isModelCatalogProvider("openrouter")).toBe(true);
    expect(isModelCatalogProvider("openai")).toBe(true);
    expect(isModelCatalogProvider("vertex")).toBe(true);
    expect(isModelCatalogProvider("google")).toBe(false);
    expect(isModelReasoningEffort("xhigh")).toBe(true);
    expect(isModelReasoningEffort("medium")).toBe(false);
  });

  describe("Vertex rail", () => {
    it("maps every Claude catalog model to the id Vertex serves, with the direct-rail alias", () => {
      expect(VERTEX_MODEL_CATALOG.map((e) => [e.id, e.upstreamId])).toEqual([
        ["vertex/claude-fable-5-1", "claude-fable-5-1"],
        ["vertex/claude-opus-5", "claude-opus-5"],
        ["vertex/claude-sonnet-5", "claude-sonnet-5"],
        ["vertex/claude-opus-4-8", "claude-opus-4-8"],
        ["vertex/claude-sonnet-4-6", "claude-sonnet-4-6"],
        ["vertex/claude-haiku-4-5", "claude-haiku-4-5@20251001"],
      ]);
      for (const entry of VERTEX_MODEL_CATALOG) {
        expect(entry.provider).toBe("vertex");
        expect(entry.source).toBe("vertex");
        const direct = modelCatalogEntryFor("anthropic", entry.id.replace(/^vertex\//, "anthropic/"));
        expect(direct?.label).toBe(entry.label);
        expect(entry.aliases).toContain(entry.id.replace(/^vertex\//, ""));
      }
    });

    it("resolves Vertex entries by catalog id, bare alias, or upstream id", () => {
      expect(modelCatalogEntryFor("vertex", "vertex/claude-haiku-4-5")?.upstreamId).toBe(
        "claude-haiku-4-5@20251001",
      );
      expect(modelCatalogEntryFor("vertex", "claude-haiku-4-5")?.id).toBe("vertex/claude-haiku-4-5");
      expect(modelCatalogEntryFor("vertex", "claude-haiku-4-5@20251001")?.id).toBe(
        "vertex/claude-haiku-4-5",
      );
      expect(modelCatalogEntryFor("anthropic", "claude-haiku-4-5@20251001")).toBeNull();
      expect(modelCatalogForProvider("vertex")).toEqual(VERTEX_MODEL_CATALOG);
    });

    it("keeps the Vertex rail out of the customer-selectable catalog", () => {
      expect(MODEL_CATALOG.some((entry) => entry.provider === "vertex")).toBe(false);
    });
  });
});
