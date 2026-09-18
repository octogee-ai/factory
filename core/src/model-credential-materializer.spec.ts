import { describe, expect, it } from "vitest";
import { buildCodexAuthProfilesStore, codexRuntimeConfig } from "./model-credential-materializer.js";

describe("ChatGPT subscription model routing", () => {
  it("materializes ChatGPT OAuth under the native OpenAI route provider", () => {
    const store = buildCodexAuthProfilesStore(JSON.stringify({
      tokens: { access_token: "access", refresh_token: "refresh" },
    }));
    expect(store.profiles["openai-codex:default"]).toMatchObject({
      type: "oauth", provider: "openai",
    });
  });
  it("routes the current OpenAI catalog through Codex and keeps the default inside it", () => {
    const config = codexRuntimeConfig();
    expect(config.modelsDef[config.model]).toEqual({ agentRuntime: { id: "codex" } });
    for (const model of ["gpt-6-astra", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.4-mini"]) {
      expect(config.modelsDef[`openai/${model}`]).toEqual({ agentRuntime: { id: "codex" } });
    }
    expect(Object.keys(config.modelsDef).some(ref => ref.startsWith("platform-"))).toBe(false);
  });
});
