import { describe, expect, it } from "vitest";

import {
  DEFAULT_FREE_TIER_MODEL_REF,
  DEFAULT_OPS_AGENT_MODEL_REF,
  DEFAULT_PLATFORM_CONNECT_CONFIG,
  PLATFORM_CONNECT_CONFIG_DOC,
  googleConnectAllowed,
  parsePlatformConnectConfig,
  parsePlatformModelConfig,
  resolveFreeTierModel,
  resolveOpsAgentModel,
} from "./platform-config";

describe("DEFAULT_FREE_TIER_MODEL_REF", () => {
  it("is DeepSeek V4 Pro on the OpenRouter platform key", () => {
    expect(DEFAULT_FREE_TIER_MODEL_REF).toBe("platform-openrouter/deepseek/deepseek-v4-pro");
  });

  it("always resolves against the catalog — a compiled default outside it would strand the free tier", () => {
    expect(resolveFreeTierModel(DEFAULT_FREE_TIER_MODEL_REF)).not.toBeNull();
  });
});

describe("parsePlatformModelConfig", () => {
  it("accepts a catalog model ref", () => {
    expect(parsePlatformModelConfig({
      freeTierModelRef: "anthropic/claude-haiku-4-5",
      opsAgentModelRef: "platform-openrouter/z-ai/glm-5.2",
    })).toEqual({
      freeTierModelRef: "anthropic/claude-haiku-4-5",
      opsAgentModelRef: "platform-openrouter/z-ai/glm-5.2",
    });
    expect(
      parsePlatformModelConfig({
        freeTierModelRef: "platform-openrouter/deepseek/deepseek-v4-pro",
        opsAgentModelRef: "platform-openrouter/deepseek/deepseek-v4-pro",
      }),
    ).toEqual({
      freeTierModelRef: "platform-openrouter/deepseek/deepseek-v4-pro",
      opsAgentModelRef: "platform-openrouter/deepseek/deepseek-v4-pro",
    });
  });

  it("defaults the new Ops dial for an existing free-tier-only document", () => {
    expect(parsePlatformModelConfig({ freeTierModelRef: "anthropic/claude-haiku-4-5" })).toEqual({
      freeTierModelRef: "anthropic/claude-haiku-4-5",
      opsAgentModelRef: DEFAULT_OPS_AGENT_MODEL_REF,
    });
  });

  it("accepts only OpenRouter catalog models for the Ops Agent", () => {
    expect(parsePlatformModelConfig({
      freeTierModelRef: DEFAULT_FREE_TIER_MODEL_REF,
      opsAgentModelRef: "anthropic/claude-haiku-4-5",
    })).toBeNull();
    expect(parsePlatformModelConfig({
      freeTierModelRef: DEFAULT_FREE_TIER_MODEL_REF,
      opsAgentModelRef: "platform-openrouter/gone/model",
    })).toBeNull();
  });

  it("rejects refs outside the catalog", () => {
    expect(parsePlatformModelConfig({ freeTierModelRef: "anthropic/claude-opus-4-8" })).toBeNull();
    expect(parsePlatformModelConfig({ freeTierModelRef: "z-ai/glm-5.2" })).toBeNull();
    expect(parsePlatformModelConfig({ freeTierModelRef: "" })).toBeNull();
    expect(parsePlatformModelConfig({ freeTierModelRef: 42 })).toBeNull();
    expect(parsePlatformModelConfig({})).toBeNull();
    expect(parsePlatformModelConfig(null)).toBeNull();
    expect(parsePlatformModelConfig("anthropic/claude-haiku-4-5")).toBeNull();
  });
});

describe("DEFAULT_OPS_AGENT_MODEL_REF", () => {
  it("defaults to GLM 5.2 on the platform OpenRouter key and maps to the OpenClaw runtime ref", () => {
    expect(DEFAULT_OPS_AGENT_MODEL_REF).toBe("platform-openrouter/z-ai/glm-5.2");
    expect(resolveOpsAgentModel(DEFAULT_OPS_AGENT_MODEL_REF)).toEqual({
      ref: "platform-openrouter/z-ai/glm-5.2",
      provider: "openrouter",
      upstreamModelId: "z-ai/glm-5.2",
      runtimeModelRef: "openrouter/z-ai/glm-5.2",
    });
  });

  it("rejects non-OpenRouter models", () => {
    expect(resolveOpsAgentModel("anthropic/claude-haiku-4-5")).toBeNull();
    expect(resolveOpsAgentModel("platform-openai/gpt-5.4-mini")).toBeNull();
  });
});

describe("resolveFreeTierModel", () => {
  it("splits an anthropic ref into the broker provider + bare upstream model id", () => {
    expect(resolveFreeTierModel("anthropic/claude-haiku-4-5")).toEqual({
      ref: "anthropic/claude-haiku-4-5",
      provider: "anthropic",
      upstreamModelId: "claude-haiku-4-5",
    });
  });

  it("splits a platform-openai ref into the broker provider + bare upstream model id", () => {
    expect(resolveFreeTierModel("platform-openai/gpt-5.4-mini")).toEqual({
      ref: "platform-openai/gpt-5.4-mini",
      provider: "openai",
      upstreamModelId: "gpt-5.4-mini",
    });
  });

  it("splits a platform-openrouter ref into the broker provider + openrouter model id", () => {
    expect(resolveFreeTierModel("platform-openrouter/z-ai/glm-5.2")).toEqual({
      ref: "platform-openrouter/z-ai/glm-5.2",
      provider: "openrouter",
      upstreamModelId: "z-ai/glm-5.2",
    });
    expect(resolveFreeTierModel("platform-openrouter/deepseek/deepseek-v4-pro")).toEqual({
      ref: "platform-openrouter/deepseek/deepseek-v4-pro",
      provider: "openrouter",
      upstreamModelId: "deepseek/deepseek-v4-pro",
    });
  });

  it("returns null for a ref outside the catalog", () => {
    expect(resolveFreeTierModel("claude-cli/claude-opus-4-8")).toBeNull();
    expect(resolveFreeTierModel("z-ai/glm-5.2")).toBeNull();
  });
});

describe("parsePlatformConnectConfig", () => {
  it("accepts each stage and normalizes the allowlist", () => {
    expect(
      parsePlatformConnectConfig({ googleStage: "allowlist", googleAllowlistUids: ["u1", " u2 ", ""] }),
    ).toEqual({ googleStage: "allowlist", googleAllowlistUids: ["u1", "u2"] });
    expect(parsePlatformConnectConfig({ googleStage: "on" })).toEqual({
      googleStage: "on",
      googleAllowlistUids: [],
    });
    expect(parsePlatformConnectConfig({ googleStage: "off", googleAllowlistUids: [] })).toEqual({
      googleStage: "off",
      googleAllowlistUids: [],
    });
  });

  it("rejects unknown stages and malformed docs", () => {
    expect(parsePlatformConnectConfig({ googleStage: "public" })).toBeNull();
    expect(parsePlatformConnectConfig({ googleStage: 42 })).toBeNull();
    expect(parsePlatformConnectConfig({ googleStage: "on", googleAllowlistUids: "u1" })).toBeNull();
    expect(parsePlatformConnectConfig({ googleStage: "on", googleAllowlistUids: [42] })).toBeNull();
    expect(parsePlatformConnectConfig({})).toBeNull();
    expect(parsePlatformConnectConfig(null)).toBeNull();
    expect(parsePlatformConnectConfig("on")).toBeNull();
  });

  it("ships dark: the compiled default is off with an empty allowlist", () => {
    expect(DEFAULT_PLATFORM_CONNECT_CONFIG).toEqual({ googleStage: "off", googleAllowlistUids: [] });
    expect(PLATFORM_CONNECT_CONFIG_DOC).toBe("connect");
  });
});

describe("googleConnectAllowed", () => {
  it("off (or an unreadable doc) admits nobody", () => {
    expect(googleConnectAllowed(null, "u1")).toBe(false);
    expect(googleConnectAllowed({ googleStage: "off", googleAllowlistUids: ["u1"] }, "u1")).toBe(false);
  });

  it("allowlist admits exactly the listed uids", () => {
    const config = { googleStage: "allowlist" as const, googleAllowlistUids: ["u1", "u2"] };
    expect(googleConnectAllowed(config, "u1")).toBe(true);
    expect(googleConnectAllowed(config, "u3")).toBe(false);
  });

  it("on admits any authenticated uid but never a blank one", () => {
    const config = { googleStage: "on" as const, googleAllowlistUids: [] };
    expect(googleConnectAllowed(config, "anyone")).toBe(true);
    expect(googleConnectAllowed(config, "")).toBe(false);
  });
});
