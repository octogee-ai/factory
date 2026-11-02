import { describe, expect, it } from "vitest";
import {
  buildCodexAuthJsonFromStore,
  buildCodexAuthProfilesStore,
  buildClaudeCliAuthProfilesStore,
  codexRuntimeConfig,
} from "./model-credential-materializer.js";

const jwt = (claims: Record<string, unknown>) =>
  "e30." + Buffer.from(JSON.stringify(claims)).toString("base64url") + ".sig";

describe("Claude subscription model routing", () => {
  it.each([
    "sk-ant-oat01-subscription",
    JSON.stringify({ claudeAiOauth: { accessToken: "access", refreshToken: "refresh", expiresAt: 2_000_000_000_000 } }),
  ])("materializes subscription credentials under the native Anthropic provider", (credential) => {
    const store = buildClaudeCliAuthProfilesStore(credential, 1_700_000_000_000);
    expect(store.profiles["anthropic:claude-cli"]).toMatchObject({ type: "oauth", provider: "anthropic" });
  });
});

describe("ChatGPT subscription model routing", () => {
  it("materializes ChatGPT OAuth under the native OpenAI route provider", () => {
    const store = buildCodexAuthProfilesStore(JSON.stringify({
      tokens: { access_token: "access", refresh_token: "refresh" },
    }));
    expect(Object.keys(store.profiles)).toEqual(["openai:octogee-chatgpt"]);
    expect(store.profiles["openai:octogee-chatgpt"]).toMatchObject({
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

describe("ChatGPT subscription auth.json rebuilt from the auth store", () => {
  const storeWith = (access: string) => JSON.stringify(buildCodexAuthProfilesStore(JSON.stringify({
    tokens: { access_token: access, refresh_token: "refresh" },
  })));

  it("reads the managed OpenAI subscription profile alongside a separate API key", () => {
    const rebuilt = buildCodexAuthJsonFromStore(JSON.stringify({
      version: 1,
      profiles: {
        "openai:default": { type: "api_key", provider: "openai", key: "separate-api-key" },
        "openai:octogee-chatgpt": {
          type: "oauth", provider: "openai", access: "subscription-access", refresh: "subscription-refresh",
        },
      },
    }));
    expect(JSON.parse(rebuilt!)).toMatchObject({
      tokens: { access_token: "subscription-access", refresh_token: "subscription-refresh" },
    });
  });

  it("stamps last_refresh with the access token's issue time so the broker can keep the newer credential", () => {
    const rebuilt = buildCodexAuthJsonFromStore(storeWith(jwt({ iat: 1_789_736_218, exp: 1_790_600_218 })));
    expect(JSON.parse(rebuilt!).last_refresh).toBe("2026-09-18T12:56:58.000Z");
  });

  it("omits last_refresh when the access token carries no issue time", () => {
    const rebuilt = buildCodexAuthJsonFromStore(storeWith(jwt({ exp: 1_790_600_218 })));
    expect(JSON.parse(rebuilt!)).not.toHaveProperty("last_refresh");
  });
});
