import { describe, expect, it } from "vitest";
import { codexRuntimeConfig } from "./model-credential-materializer.js";

describe("ChatGPT subscription model routing", () => {
  it("routes the current OpenAI catalog through Codex without changing the existing default", () => {
    const config = codexRuntimeConfig();
    expect(config.model).toBe("openai/gpt-5.5");
    for (const model of ["gpt-6-astra", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.4-mini", "gpt-5.5"]) {
      expect(config.modelsDef[`openai/${model}`]).toEqual({ agentRuntime: { id: "codex" } });
    }
    expect(Object.keys(config.modelsDef).some(ref => ref.startsWith("platform-"))).toBe(false);
  });
});
