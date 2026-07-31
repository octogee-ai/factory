import { describe, expect, it } from "vitest";

import {
  MODEL_CATALOG,
  isModelCatalogProvider,
  isModelReasoningEffort,
  modelCatalogEntryFor,
  modelCatalogForProvider,
} from "./model-catalog";

describe("MODEL_CATALOG", () => {
  it("serves both broker providers — anthropic house pair + OpenRouter catalog", () => {
    expect(modelCatalogForProvider("anthropic").map((e) => e.id)).toEqual([
      "anthropic/claude-sonnet-4-6",
      "anthropic/claude-haiku-4-5",
    ]);
    expect(modelCatalogForProvider("openrouter").map((e) => e.id)).toEqual([
      "z-ai/glm-5.2",
      "minimax/minimax-m3",
      "deepseek/deepseek-v4-pro",
      "openai/gpt-5.6-luna",
    ]);
  });

  it("carries DeepSeek V4 Pro as a free-tier dial candidate", () => {
    const entry = modelCatalogEntryFor("openrouter", "deepseek/deepseek-v4-pro");
    expect(entry?.label).toBe("DeepSeek V4 Pro");
    expect(entry?.contextTokens).toBe(1_048_576);
    expect(entry?.reasoningEfforts).toEqual([]);
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

  it("carries GPT-5.4 Mini on the OpenAI platform provider", () => {
    expect(modelCatalogForProvider("openai").map((e) => e.id)).toEqual(["gpt-5.4-mini"]);
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
    expect(isModelCatalogProvider("google")).toBe(false);
    expect(isModelReasoningEffort("xhigh")).toBe(true);
    expect(isModelReasoningEffort("medium")).toBe(false);
  });
});
