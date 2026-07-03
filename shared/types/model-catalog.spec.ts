import { describe, expect, it } from "vitest";

import {
  MODEL_CATALOG,
  isModelCatalogProvider,
  isModelReasoningEffort,
  modelCatalogEntryFor,
  modelCatalogForProvider,
} from "./model-catalog";

describe("MODEL_CATALOG", () => {
  it("serves both broker providers — anthropic house pair + openrouter pair", () => {
    expect(modelCatalogForProvider("anthropic").map((e) => e.id)).toEqual([
      "anthropic/claude-sonnet-4-6",
      "anthropic/claude-haiku-4-5",
    ]);
    expect(modelCatalogForProvider("openrouter").map((e) => e.id)).toEqual([
      "z-ai/glm-5.2",
      "minimax/minimax-m3",
    ]);
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
    expect(isModelCatalogProvider("openai")).toBe(false);
    expect(isModelReasoningEffort("xhigh")).toBe(true);
    expect(isModelReasoningEffort("medium")).toBe(false);
  });
});
