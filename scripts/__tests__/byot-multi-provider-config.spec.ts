import { describe, it, expect } from "vitest";
import {
  buildByotConfigForProvider,
  codexRuntimeConfig,
  type ByotConfigInput,
} from "../lib/byot-multi-provider-config.js";

describe("buildByotConfigForProvider — provider parity (BYOT api_key cases)", () => {
  it("anthropic → api_key profile via SecretRef, no model override", () => {
    const out = buildByotConfigForProvider({ slug: "tester-70", provider: "anthropic" });
    expect(out.agentModelOverride).toBeNull();
    expect(out.models).toBeNull();
    const p = out.authProfiles!.profiles["anthropic:default"];
    expect(p.type).toBe("api_key");
    expect(p.provider).toBe("anthropic");
    expect((p as { keyRef?: unknown }).keyRef).toBeTruthy();
  });

  it("openai → api_key profile + model override", () => {
    const out = buildByotConfigForProvider({ slug: "tester-70", provider: "openai" });
    expect(out.agentModelOverride).toBeTruthy();
    const p = out.authProfiles!.profiles["openai:default"];
    expect(p.type).toBe("api_key");
  });
});

describe("buildByotConfigForProvider — openai-codex (BYOS, ChatGPT sub) at parity", () => {
  // BYOS rides the SAME primitive as BYOT: a per-agent auth profile +
  // agentModelOverride. The only difference vs api_key BYOT is the profile
  // is `type:"oauth"` (no keyRef — the credential is the per-agent
  // CODEX_HOME auth.json that openclaw isolates per agent), and the model
  // is the codex agentRuntime model. No higher bar than BYOT.
  const input: ByotConfigInput = { slug: "tester-70", provider: "openai-codex" };

  it("emits an oauth profile (no keyRef) — credential is the per-agent codex-home", () => {
    const out = buildByotConfigForProvider(input);
    const p = out.authProfiles!.profiles["openai-codex"];
    expect(p).toEqual({ type: "oauth", provider: "openai-codex" });
    expect((p as { keyRef?: unknown }).keyRef).toBeUndefined();
    expect(out.models).toBeNull();
  });

  it("overrides the agent model to the codex agentRuntime model", () => {
    expect(buildByotConfigForProvider(input).agentModelOverride).toBe("openai/gpt-5.5");
  });

  it("honors an explicit model override", () => {
    expect(
      buildByotConfigForProvider({ ...input, model: "openai/gpt-5.5-pro" })
        .agentModelOverride,
    ).toBe("openai/gpt-5.5-pro");
  });

  it("still validates the slug (parity with the api_key cases)", () => {
    expect(() =>
      buildByotConfigForProvider({ slug: "Bad/Slug", provider: "openai-codex" }),
    ).toThrow();
  });
});

describe("buildByotConfigForProvider — openai-compatible (custom provider) characterization", () => {
  // Pins current behavior so the registry refactor stays byte-identical.
  it("emits a custom models.provider (no auth profile) + namespaced model override", () => {
    const out = buildByotConfigForProvider({
      slug: "tester-70",
      provider: "openai-compatible",
      baseUrl: "https://llm.example.com",
      model: "llama-3.1-70b",
    });
    expect(out.authProfiles).toBeNull();
    expect(out.models).toEqual({
      providers: {
        "custom-tester-70": {
          api: "openai-completions",
          baseUrl: "https://llm.example.com",
          apiKey: {
            source: "exec",
            provider: "gcp-secret-manager",
            id: "byok-tester-70-openai-compatible/latest",
          },
          models: [{ id: "llama-3.1-70b", name: "llama-3.1-70b" }],
        },
      },
    });
    expect(out.agentModelOverride).toBe("custom-tester-70/llama-3.1-70b");
  });

  it("requires baseUrl and model", () => {
    expect(() =>
      buildByotConfigForProvider({ slug: "tester-70", provider: "openai-compatible" }),
    ).toThrow(/baseUrl is required/);
    expect(() =>
      buildByotConfigForProvider({
        slug: "tester-70",
        provider: "openai-compatible",
        baseUrl: "https://llm.example.com",
      }),
    ).toThrow(/model is required/);
  });
});

describe("codexRuntimeConfig — BYOS coach model + agentRuntime:codex routing", () => {
  it("pins agentRuntime:{id:codex} so a per-agent gpt-5.5 override routes through the codex harness, not direct OpenAI API", () => {
    expect(codexRuntimeConfig()).toEqual({
      model: "openai/gpt-5.5",
      modelsDef: { "openai/gpt-5.5": { agentRuntime: { id: "codex" } } },
    });
  });
});
