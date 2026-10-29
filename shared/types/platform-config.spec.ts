import { describe, expect, it } from "vitest";

import {
  DEFAULT_BUILDER_AGENT_FALLBACK_MODEL_REF,
  DEFAULT_BUILDER_AGENT_MODEL_REF,
  DEFAULT_FREE_TIER_MODEL_REF,
  DEFAULT_OPS_AGENT_MODEL_REF,
  DEFAULT_PLATFORM_CONNECT_CONFIG,
  DEFAULT_PLATFORM_FREE_CONFIG,
  DEFAULT_PLATFORM_TRIAL_CONFIG,
  GOOGLE_CONNECT_CAPABILITY_KEYS,
  PLATFORM_CONNECT_CONFIG_DOC,
  PLATFORM_FREE_CONFIG_DOC,
  PLATFORM_TRIAL_CONFIG_DOC,
  TRIAL_CONFIG_SCHEMA_VERSION,
  builderAgentModelDefaultFromDoc,
  googleCapabilityConnectAllowed,
  googleConnectAllowed,
  googleConsentPermission,
  parseBuilderAgentModelDefault,
  parsePlatformConnectConfig,
  parsePlatformFreeConfig,
  parsePlatformModelConfig,
  parsePlatformTrialConfig,
  parseSignupOfferBudgetPolicy,
  resolveFreeTierModel,
  resolveOpsAgentModel,
  trialConfigHash,
} from "./platform-config";

describe("parsePlatformFreeConfig", () => {
  it("ships a configurable workspace-file allowance without making it a plan constant", () => {
    expect(DEFAULT_PLATFORM_FREE_CONFIG).toEqual({
      schemaVersion: 1,
      workspaceStorageGb: 10,
    });
    expect(parsePlatformFreeConfig(DEFAULT_PLATFORM_FREE_CONFIG)).toEqual(
      DEFAULT_PLATFORM_FREE_CONFIG,
    );
    expect(PLATFORM_FREE_CONFIG_DOC).toBe("free");
  });

  it("accepts bounded fractional allowances and rejects malformed values", () => {
    expect(parsePlatformFreeConfig({ schemaVersion: 1, workspaceStorageGb: 2.5 })).toEqual({
      schemaVersion: 1,
      workspaceStorageGb: 2.5,
    });
    expect(parsePlatformFreeConfig({ schemaVersion: 1, workspaceStorageGb: 0 })).toBeNull();
    expect(parsePlatformFreeConfig({ schemaVersion: 1, workspaceStorageGb: 1001 })).toBeNull();
    expect(parsePlatformFreeConfig({ schemaVersion: 2, workspaceStorageGb: 10 })).toBeNull();
    expect(parsePlatformFreeConfig(null)).toBeNull();
  });
});

describe("parsePlatformTrialConfig", () => {
  it("seeds the seven-day momentum Signup Offer with a Hobby builder gateway", () => {
    expect(parsePlatformTrialConfig(DEFAULT_PLATFORM_TRIAL_CONFIG)).toEqual({
      schemaVersion: 2,
      offerId: "builder-signup",
      offerVersion: 3,
      durationDays: 7,
      defaultPersonalTier: "personal",
      defaultBuilderTier: "hobby",
      budgetPolicy: {
        schemaVersion: 1,
        currency: "USD",
        cumulativeUnlockUsd: [4.8, 5.6, 6.4, 6.8, 7.2, 7.6, 8],
        hardCapUsd: 8,
      },
    });
    expect(PLATFORM_TRIAL_CONFIG_DOC).toBe("trial");
    expect(TRIAL_CONFIG_SCHEMA_VERSION).toBe(2);
  });

  it("accepts every Personal tier and every provisionable builder tier", () => {
    for (const personalTier of ["personal_free", "personal", "personal_pro", "personal_pro_max"]) {
      expect(
        parsePlatformTrialConfig({
          ...DEFAULT_PLATFORM_TRIAL_CONFIG,
          defaultPersonalTier: personalTier,
        }),
      ).not.toBeNull();
    }
    for (const builderTier of ["hobby", "pro", "team"]) {
      expect(
        parsePlatformTrialConfig({
          ...DEFAULT_PLATFORM_TRIAL_CONFIG,
          defaultBuilderTier: builderTier,
        }),
      ).not.toBeNull();
    }
    expect(
      parsePlatformTrialConfig({
        ...DEFAULT_PLATFORM_TRIAL_CONFIG,
        defaultBuilderTier: null,
      }),
    ).toMatchObject({ defaultBuilderTier: null });
    // enterprise has no instance size, so nothing can provision it.
    expect(
      parsePlatformTrialConfig({
        ...DEFAULT_PLATFORM_TRIAL_CONFIG,
        defaultBuilderTier: "enterprise",
      }),
    ).toBeNull();
  });

  it("rejects malformed and unsupported configs", () => {
    expect(parsePlatformTrialConfig(null)).toBeNull();
    expect(parsePlatformTrialConfig({ ...DEFAULT_PLATFORM_TRIAL_CONFIG, schemaVersion: 1 })).toBeNull();
    expect(parsePlatformTrialConfig({ ...DEFAULT_PLATFORM_TRIAL_CONFIG, defaultPersonalTier: "pro" })).toBeNull();
    expect(parsePlatformTrialConfig({ ...DEFAULT_PLATFORM_TRIAL_CONFIG, defaultBuilderTier: "max" })).toBeNull();
    expect(parsePlatformTrialConfig({ ...DEFAULT_PLATFORM_TRIAL_CONFIG, offerId: "" })).toBeNull();
    expect(parsePlatformTrialConfig({ ...DEFAULT_PLATFORM_TRIAL_CONFIG, offerVersion: 0 })).toBeNull();
    expect(parsePlatformTrialConfig({ ...DEFAULT_PLATFORM_TRIAL_CONFIG, durationDays: 0 })).toBeNull();
    expect(parsePlatformTrialConfig({ ...DEFAULT_PLATFORM_TRIAL_CONFIG, durationDays: 31 })).toBeNull();
    expect(parsePlatformTrialConfig({
      ...DEFAULT_PLATFORM_TRIAL_CONFIG,
      budgetPolicy: undefined,
    })).toBeNull();
  });

  it("hashes only the canonical grant-shaping fields", () => {
    const hash = trialConfigHash(DEFAULT_PLATFORM_TRIAL_CONFIG);
    expect(hash).toMatch(/^[0-9a-f]{16}$/);
    expect(
      trialConfigHash({
        ...DEFAULT_PLATFORM_TRIAL_CONFIG,
        updatedBy: "operator-2",
      }),
    ).toBe(hash);
    expect(trialConfigHash({
      ...DEFAULT_PLATFORM_TRIAL_CONFIG,
      defaultBuilderTier: "team",
    })).not.toBe(hash);
    expect(
      trialConfigHash({ ...DEFAULT_PLATFORM_TRIAL_CONFIG, durationDays: 14 }),
    ).not.toBe(hash);
    expect(
      trialConfigHash({ ...DEFAULT_PLATFORM_TRIAL_CONFIG, offerVersion: 2 }),
    ).not.toBe(hash);
    expect(
      trialConfigHash({
        ...DEFAULT_PLATFORM_TRIAL_CONFIG,
        budgetPolicy: {
          ...DEFAULT_PLATFORM_TRIAL_CONFIG.budgetPolicy!,
          cumulativeUnlockUsd: [4.9, 5.6, 6.4, 6.8, 7.2, 7.6, 8],
        },
      }),
    ).not.toBe(hash);
  });

  it("validates the complete immutable momentum schedule", () => {
    const valid = DEFAULT_PLATFORM_TRIAL_CONFIG.budgetPolicy!;
    expect(parseSignupOfferBudgetPolicy(valid)).toEqual(valid);
    for (const invalid of [
      undefined,
      { ...valid, schemaVersion: 2 },
      { ...valid, currency: "EUR" },
      { ...valid, cumulativeUnlockUsd: [4.8, 5.6] },
      { ...valid, cumulativeUnlockUsd: [4.8, 5.6, 5.5, 6.8, 7.2, 7.6, 8] },
      { ...valid, cumulativeUnlockUsd: [4.8, 5.6, -1, 6.8, 7.2, 7.6, 8] },
      { ...valid, cumulativeUnlockUsd: [4.8, 5.6, Number.NaN, 6.8, 7.2, 7.6, 8] },
      { ...valid, hardCapUsd: 0 },
      { ...valid, hardCapUsd: 9 },
      { ...valid, unrecognizedPromise: true },
    ]) {
      expect(parseSignupOfferBudgetPolicy(invalid)).toBeNull();
    }
  });
});

describe("DEFAULT_FREE_TIER_MODEL_REF", () => {
  it("is the Errands tier (GPT-6 Luna) on the OpenAI platform key", () => {
    expect(DEFAULT_FREE_TIER_MODEL_REF).toBe("platform-openai/gpt-6-luna");
    expect(resolveFreeTierModel(DEFAULT_FREE_TIER_MODEL_REF)).toEqual({
      ref: "platform-openai/gpt-6-luna",
      provider: "openai",
      upstreamModelId: "gpt-6-luna",
    });
  });

  it("always resolves against the catalog — a compiled default outside it would strand the free tier", () => {
    expect(resolveFreeTierModel(DEFAULT_FREE_TIER_MODEL_REF)).not.toBeNull();
  });
});

const DEFAULT_BUILDER_DIAL_FIELDS = {
  builderAgentModelRef: DEFAULT_BUILDER_AGENT_MODEL_REF,
  builderAgentFallbackModelRef: DEFAULT_BUILDER_AGENT_FALLBACK_MODEL_REF,
};

describe("parsePlatformModelConfig", () => {
  it("accepts a catalog model ref", () => {
    expect(parsePlatformModelConfig({
      freeTierModelRef: "anthropic/claude-haiku-4-5",
      opsAgentModelRef: "platform-openrouter/z-ai/glm-5.2",
    })).toEqual({
      freeTierModelRef: "anthropic/claude-haiku-4-5",
      opsAgentModelRef: "platform-openrouter/z-ai/glm-5.2",
      ...DEFAULT_BUILDER_DIAL_FIELDS,
    });
    expect(
      parsePlatformModelConfig({
        freeTierModelRef: "platform-openrouter/deepseek/deepseek-v4-pro",
        opsAgentModelRef: "platform-openrouter/deepseek/deepseek-v4-pro",
      }),
    ).toEqual({
      freeTierModelRef: "platform-openrouter/deepseek/deepseek-v4-pro",
      opsAgentModelRef: "platform-openrouter/deepseek/deepseek-v4-pro",
      ...DEFAULT_BUILDER_DIAL_FIELDS,
    });
  });

  it("defaults the new Ops dial for an existing free-tier-only document", () => {
    expect(parsePlatformModelConfig({ freeTierModelRef: "anthropic/claude-haiku-4-5" })).toEqual({
      freeTierModelRef: "anthropic/claude-haiku-4-5",
      opsAgentModelRef: DEFAULT_OPS_AGENT_MODEL_REF,
      ...DEFAULT_BUILDER_DIAL_FIELDS,
    });
  });

  it("accepts a Builder Agent dial from any catalog provider, fallback none included", () => {
    expect(parsePlatformModelConfig({
      freeTierModelRef: DEFAULT_FREE_TIER_MODEL_REF,
      builderAgentModelRef: "anthropic/claude-haiku-4-5",
      builderAgentFallbackModelRef: null,
    })).toEqual({
      freeTierModelRef: DEFAULT_FREE_TIER_MODEL_REF,
      opsAgentModelRef: DEFAULT_OPS_AGENT_MODEL_REF,
      builderAgentModelRef: "anthropic/claude-haiku-4-5",
      builderAgentFallbackModelRef: null,
    });
  });

  it("rejects Builder Agent refs outside the catalog", () => {
    expect(parsePlatformModelConfig({
      freeTierModelRef: DEFAULT_FREE_TIER_MODEL_REF,
      builderAgentModelRef: "platform-openrouter/gone/model",
    })).toBeNull();
    expect(parsePlatformModelConfig({
      freeTierModelRef: DEFAULT_FREE_TIER_MODEL_REF,
      builderAgentFallbackModelRef: "z-ai/glm-5.2",
    })).toBeNull();
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
    expect(parsePlatformModelConfig({ freeTierModelRef: "anthropic/model-not-in-catalog" })).toBeNull();
    expect(parsePlatformModelConfig({ freeTierModelRef: "z-ai/glm-5.2" })).toBeNull();
    expect(parsePlatformModelConfig({ freeTierModelRef: "" })).toBeNull();
    expect(parsePlatformModelConfig({ freeTierModelRef: 42 })).toBeNull();
    expect(parsePlatformModelConfig({})).toBeNull();
    expect(parsePlatformModelConfig(null)).toBeNull();
    expect(parsePlatformModelConfig("anthropic/claude-haiku-4-5")).toBeNull();
  });
});

describe("Builder Agent default dial", () => {
  it("compiles to the Everyday tier (GPT-6.1 Terra) on OpenAI direct with a GLM 5.2 fallback", () => {
    expect(DEFAULT_BUILDER_AGENT_MODEL_REF).toBe("platform-openai/gpt-6.1-terra");
    expect(DEFAULT_BUILDER_AGENT_FALLBACK_MODEL_REF).toBe("platform-openrouter/z-ai/glm-5.2");
    expect(resolveFreeTierModel(DEFAULT_BUILDER_AGENT_MODEL_REF)).not.toBeNull();
    expect(resolveFreeTierModel(DEFAULT_BUILDER_AGENT_FALLBACK_MODEL_REF!)).not.toBeNull();
  });

  it("reads the stored dial field-tolerantly — invalid refs fall back per field", () => {
    expect(builderAgentModelDefaultFromDoc(undefined)).toEqual({
      primary: DEFAULT_BUILDER_AGENT_MODEL_REF,
      fallbacks: [DEFAULT_BUILDER_AGENT_FALLBACK_MODEL_REF],
    });
    expect(builderAgentModelDefaultFromDoc({
      builderAgentModelRef: "anthropic/claude-haiku-4-5",
      builderAgentFallbackModelRef: "platform-openrouter/gone/model",
    })).toEqual({
      primary: "anthropic/claude-haiku-4-5",
      fallbacks: [DEFAULT_BUILDER_AGENT_FALLBACK_MODEL_REF],
    });
    expect(builderAgentModelDefaultFromDoc({
      builderAgentFallbackModelRef: null,
    })).toEqual({
      primary: DEFAULT_BUILDER_AGENT_MODEL_REF,
      fallbacks: [],
    });
  });

  it("drops a fallback that duplicates the primary", () => {
    expect(builderAgentModelDefaultFromDoc({
      builderAgentModelRef: "platform-openrouter/z-ai/glm-5.2",
      builderAgentFallbackModelRef: "platform-openrouter/z-ai/glm-5.2",
    })).toEqual({ primary: "platform-openrouter/z-ai/glm-5.2", fallbacks: [] });
  });

  it("validates the sync-wire stamp strictly — any bad ref voids the whole stamp", () => {
    expect(parseBuilderAgentModelDefault({
      primary: DEFAULT_BUILDER_AGENT_MODEL_REF,
      fallbacks: ["platform-openrouter/z-ai/glm-5.2"],
    })).toEqual({
      primary: DEFAULT_BUILDER_AGENT_MODEL_REF,
      fallbacks: ["platform-openrouter/z-ai/glm-5.2"],
    });
    expect(parseBuilderAgentModelDefault({ primary: DEFAULT_BUILDER_AGENT_MODEL_REF, fallbacks: [] }))
      .toEqual({ primary: DEFAULT_BUILDER_AGENT_MODEL_REF, fallbacks: [] });
    expect(parseBuilderAgentModelDefault(undefined)).toBeNull();
    expect(parseBuilderAgentModelDefault({ primary: "z-ai/glm-5.2", fallbacks: [] })).toBeNull();
    expect(parseBuilderAgentModelDefault({
      primary: DEFAULT_BUILDER_AGENT_MODEL_REF,
      fallbacks: ["platform-openrouter/gone/model"],
    })).toBeNull();
    expect(parseBuilderAgentModelDefault({ primary: DEFAULT_BUILDER_AGENT_MODEL_REF })).toBeNull();
  });
});

describe("resolveOpsAgentModel", () => {
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

  it("keeps the anthropic vendor prefix on an OpenRouter Claude model id", () => {
    expect(resolveFreeTierModel("platform-openrouter/anthropic/claude-fable-5.1")).toEqual({
      ref: "platform-openrouter/anthropic/claude-fable-5.1",
      provider: "openrouter",
      upstreamModelId: "anthropic/claude-fable-5.1",
    });
    expect(resolveOpsAgentModel("platform-openrouter/anthropic/claude-fable-5.1")?.runtimeModelRef)
      .toBe("openrouter/anthropic/claude-fable-5.1");
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

const ALL_OFF = DEFAULT_PLATFORM_CONNECT_CONFIG.googleStages;
const SPLIT_STAGES = {
  calendar: "on",
  gmail: "allowlist",
  drive: "on",
  "drive-full": "allowlist",
  tasks: "on",
  contacts: "on",
} as const;

describe("parsePlatformConnectConfig", () => {
  it("accepts a full per-capability stage map and normalizes the allowlist", () => {
    expect(
      parsePlatformConnectConfig({ googleStages: SPLIT_STAGES, googleAllowlistUids: ["u1", " u2 ", ""] }),
    ).toEqual({ googleStages: SPLIT_STAGES, googleAllowlistUids: ["u1", "u2"] });
    expect(parsePlatformConnectConfig({ googleStages: ALL_OFF })).toEqual({
      googleStages: ALL_OFF,
      googleAllowlistUids: [],
    });
  });

  it("rejects an unknown capability key", () => {
    expect(
      parsePlatformConnectConfig({ googleStages: { ...ALL_OFF, voice: "on" } }),
    ).toBeNull();
  });

  it("rejects a map missing a capability key — no silent per-key default", () => {
    const { gmail: _gmail, ...missingGmail } = ALL_OFF;
    expect(parsePlatformConnectConfig({ googleStages: missingGmail })).toBeNull();
  });

  it("rejects the old global googleStage shape", () => {
    expect(parsePlatformConnectConfig({ googleStage: "on", googleAllowlistUids: ["u1"] })).toBeNull();
    expect(parsePlatformConnectConfig({ googleStage: "allowlist" })).toBeNull();
  });

  it("rejects unknown stages and malformed docs", () => {
    expect(parsePlatformConnectConfig({ googleStages: { ...ALL_OFF, gmail: "public" } })).toBeNull();
    expect(parsePlatformConnectConfig({ googleStages: { ...ALL_OFF, gmail: 42 } })).toBeNull();
    expect(parsePlatformConnectConfig({ googleStages: "on" })).toBeNull();
    expect(parsePlatformConnectConfig({ googleStages: ALL_OFF, googleAllowlistUids: "u1" })).toBeNull();
    expect(parsePlatformConnectConfig({ googleStages: ALL_OFF, googleAllowlistUids: [42] })).toBeNull();
    expect(parsePlatformConnectConfig({})).toBeNull();
    expect(parsePlatformConnectConfig(null)).toBeNull();
    expect(parsePlatformConnectConfig("on")).toBeNull();
  });

  it("ships dark: every capability off with an empty allowlist", () => {
    expect(GOOGLE_CONNECT_CAPABILITY_KEYS).toEqual([
      "calendar",
      "gmail",
      "drive",
      "drive-full",
      "tasks",
      "contacts",
    ]);
    expect(DEFAULT_PLATFORM_CONNECT_CONFIG).toEqual({
      googleStages: {
        calendar: "off",
        gmail: "off",
        drive: "off",
        "drive-full": "off",
        tasks: "off",
        contacts: "off",
      },
      googleAllowlistUids: [],
    });
    expect(PLATFORM_CONNECT_CONFIG_DOC).toBe("connect");
  });
});

describe("googleCapabilityConnectAllowed", () => {
  const config = { googleStages: SPLIT_STAGES, googleAllowlistUids: ["u1", "u2"] };

  it("an unreadable doc admits nobody to anything", () => {
    expect(googleCapabilityConnectAllowed(null, "u1", "calendar")).toBe(false);
    expect(googleConnectAllowed(null, "u1")).toBe(false);
  });

  it("on admits any authenticated uid to that capability but never a blank one", () => {
    expect(googleCapabilityConnectAllowed(config, "anyone", "calendar")).toBe(true);
    expect(googleCapabilityConnectAllowed(config, "", "calendar")).toBe(false);
  });

  it("allowlist admits exactly the listed uids to that capability", () => {
    expect(googleCapabilityConnectAllowed(config, "u1", "gmail")).toBe(true);
    expect(googleCapabilityConnectAllowed(config, "u3", "gmail")).toBe(false);
  });

  it("off admits nobody, listed or not", () => {
    const off = { googleStages: { ...SPLIT_STAGES, gmail: "off" as const }, googleAllowlistUids: ["u1"] };
    expect(googleCapabilityConnectAllowed(off, "u1", "gmail")).toBe(false);
    expect(googleCapabilityConnectAllowed(off, "u1", "calendar")).toBe(true);
  });

  it("googleConnectAllowed is true when any capability admits the uid", () => {
    expect(googleConnectAllowed({ googleStages: ALL_OFF, googleAllowlistUids: ["u1"] }, "u1")).toBe(false);
    expect(googleConnectAllowed({ googleStages: { ...ALL_OFF, gmail: "allowlist" }, googleAllowlistUids: ["u1"] }, "u1")).toBe(true);
    expect(googleConnectAllowed({ googleStages: { ...ALL_OFF, gmail: "allowlist" }, googleAllowlistUids: ["u1"] }, "u3")).toBe(false);
  });
});

describe("googleConsentPermission", () => {
  const config = { googleStages: SPLIT_STAGES, googleAllowlistUids: ["u1"] };

  it("keeps every requested capability the uid may start", () => {
    expect(googleConsentPermission(config, "u1", ["calendar", "gmail"])).toEqual({
      permitted: ["calendar", "gmail"],
      excluded: [],
    });
  });

  it("drops only the disallowed capabilities from a mixed request, preserving order", () => {
    expect(googleConsentPermission(config, "u3", ["gmail", "calendar", "drive-full", "tasks"])).toEqual({
      permitted: ["calendar", "tasks"],
      excluded: ["gmail", "drive-full"],
    });
  });

  it("leaves nothing permitted when every requested capability is disallowed", () => {
    expect(googleConsentPermission(config, "u3", ["gmail", "drive-full"])).toEqual({
      permitted: [],
      excluded: ["gmail", "drive-full"],
    });
    expect(googleConsentPermission({ googleStages: ALL_OFF, googleAllowlistUids: ["u1"] }, "u1", ["calendar"])).toEqual({
      permitted: [],
      excluded: ["calendar"],
    });
  });
});
