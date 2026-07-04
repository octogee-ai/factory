import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  catalogEntryForModelRef,
  modelRefForCatalogEntry,
} from "@octogee/shared/types/agent-models";

const repoRoot = path.resolve(__dirname, "../..");
const DEFAULT_MODEL_REF = "platform-openrouter/z-ai/glm-5.2";

function readTemplate() {
  return JSON.parse(
    readFileSync(path.join(repoRoot, "infra/gateway/openclaw.template.json"), "utf8"),
  );
}

describe("infra/gateway/openclaw.template.json — platform default model", () => {
  it("defaults agents and subagents to GLM 5.2 via the platform OpenRouter provider", () => {
    const template = readTemplate();

    expect(template.agents.defaults.model.primary).toBe(DEFAULT_MODEL_REF);
    expect(template.agents.defaults.subagents.model).toBe(DEFAULT_MODEL_REF);
    for (const agent of template.agents.list) {
      expect(agent.model).toBe(DEFAULT_MODEL_REF);
    }
  });

  it("keys the default off the shared model catalog", () => {
    const entry = catalogEntryForModelRef(DEFAULT_MODEL_REF);

    expect(entry).not.toBeNull();
    expect(modelRefForCatalogEntry(entry!)).toBe(DEFAULT_MODEL_REF);
  });

  it("carries the catalog's default reasoning effort on the default-model allowlist entry", () => {
    const template = readTemplate();
    const entry = catalogEntryForModelRef(DEFAULT_MODEL_REF)!;

    expect(template.agents.defaults.models[DEFAULT_MODEL_REF]).toEqual({
      alias: "glm",
      params: { thinking: entry.defaultReasoningEffort },
    });
    expect(entry.reasoningEfforts).toContain(entry.defaultReasoningEffort);
  });

  it("keeps the haiku fallback pin and drops the demoted sonnet allowlist entry", () => {
    const template = readTemplate();

    expect(template.agents.defaults.models["anthropic/claude-haiku-4-5"]).toEqual({
      alias: "haiku",
      params: { cacheRetention: "short" },
    });
    expect(template.agents.defaults.models["anthropic/claude-sonnet-4-6"]).toBeUndefined();
  });
});
