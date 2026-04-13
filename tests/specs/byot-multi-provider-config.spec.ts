/**
 * Phase 2 — multi-provider per-agent config builders.
 *
 * For each customer's BYOT, the provisioner writes one or two files
 * inside their agent dir, depending on which provider they chose:
 *
 *   anthropic:
 *     auth-profiles.json:  { "anthropic:default": { type, keyRef → byok-{slug}-anthropic } }
 *     (Phase 1 unchanged)
 *
 *   openai (direct API):
 *     auth-profiles.json:  { "openai:default": { type, keyRef → byok-{slug}-openai } }
 *
 *   openai-compatible (OpenRouter, Groq, Mistral, Fireworks, Together, ...):
 *     models.json:         { providers.custom-{slug}: { baseUrl, apiKey: SecretRef → byok-{slug}-openai-compatible } }
 *     (no auth-profiles.json — apiKey lives directly on the provider entry)
 *
 * Pure builders. Tests cover shape and Secret Manager id grammar.
 */
import { describe, test, expect } from "vitest";
import {
  buildByotConfigForProvider,
  type ByotConfigInput,
} from "../../scripts/lib/byot-multi-provider-config";

describe("buildByotConfigForProvider — anthropic (Phase 1 shape preserved)", () => {
  test("emits auth-profiles.json with anthropic:default + keyRef", () => {
    const out = buildByotConfigForProvider({
      slug: "smile-wring-011b",
      provider: "anthropic",
    });
    expect(out.authProfiles).toEqual({
      profiles: {
        "anthropic:default": {
          type: "api_key",
          keyRef: {
            source: "exec",
            provider: "gcp-secret-manager",
            id: "byok-smile-wring-011b-anthropic/latest",
          },
        },
      },
    });
    expect(out.models).toBeNull();
    expect(out.agentModelOverride).toBeNull();
  });
});

describe("buildByotConfigForProvider — openai (direct)", () => {
  test("emits auth-profiles.json with openai:default + keyRef", () => {
    const out = buildByotConfigForProvider({
      slug: "smile-wring-011b",
      provider: "openai",
      model: "openai/gpt-5",
    });
    expect(out.authProfiles).toEqual({
      profiles: {
        "openai:default": {
          type: "api_key",
          keyRef: {
            source: "exec",
            provider: "gcp-secret-manager",
            id: "byok-smile-wring-011b-openai/latest",
          },
        },
      },
    });
    expect(out.models).toBeNull();
    expect(out.agentModelOverride).toBe("openai/gpt-5");
  });

  test("agentModelOverride defaults when no model is specified", () => {
    const out = buildByotConfigForProvider({ slug: "x", provider: "openai" });
    // We pick a sensible default OpenAI model when the customer didn't choose.
    expect(out.agentModelOverride).toBeTruthy();
    expect(out.agentModelOverride!.startsWith("openai/")).toBe(true);
  });
});

describe("buildByotConfigForProvider — openai-compatible", () => {
  test("emits models.json with api adapter, baseUrl, keyRef apiKey, and explicit models[]", () => {
    const out = buildByotConfigForProvider({
      slug: "smile-wring-011b",
      provider: "openai-compatible",
      baseUrl: "https://openrouter.ai/api/v1",
      model: "anthropic/claude-3.5-sonnet",
    });
    expect(out.models).toEqual({
      providers: {
        "custom-smile-wring-011b": {
          // OpenClaw needs `api` to know which request adapter to use.
          // openai-completions covers OpenRouter, Groq, Mistral, Fireworks,
          // Together, and any other OpenAI-schema endpoint.
          api: "openai-completions",
          baseUrl: "https://openrouter.ai/api/v1",
          apiKey: {
            source: "exec",
            provider: "gcp-secret-manager",
            id: "byok-smile-wring-011b-openai-compatible/latest",
          },
          // Explicit models[] entry so OpenClaw doesn't have to guess
          // when the agent ref namespaces the customer's model.
          models: [{ id: "anthropic/claude-3.5-sonnet", name: "anthropic/claude-3.5-sonnet" }],
        },
      },
    });
    // No auth-profiles.json — apiKey lives on the provider entry.
    expect(out.authProfiles).toBeNull();
    // Agent model namespaced under the custom provider. OpenClaw splits
    // model refs on the FIRST `/` to separate provider from model id.
    expect(out.agentModelOverride).toBe("custom-smile-wring-011b/anthropic/claude-3.5-sonnet");
  });

  test("rejects missing baseUrl", () => {
    expect(() =>
      buildByotConfigForProvider({ slug: "x", provider: "openai-compatible" }),
    ).toThrow(/baseUrl is required/i);
  });

  test("rejects malformed baseUrl (must be http(s) URL)", () => {
    expect(() =>
      buildByotConfigForProvider({
        slug: "x",
        provider: "openai-compatible",
        baseUrl: "not-a-url",
      }),
    ).toThrow(/baseUrl/i);
  });

  test("rejects missing model (openai-compatible needs explicit model)", () => {
    expect(() =>
      buildByotConfigForProvider({
        slug: "x",
        provider: "openai-compatible",
        baseUrl: "https://openrouter.ai/api/v1",
      }),
    ).toThrow(/model is required/i);
  });

  test("rejects model strings with characters outside [A-Za-z0-9._/-]", () => {
    for (const bad of ["../etc/passwd", "model;rm", "model name", "model$x", "model\\x"]) {
      expect(() =>
        buildByotConfigForProvider({
          slug: "x",
          provider: "openai-compatible",
          baseUrl: "https://example.com/v1",
          model: bad,
        }),
      ).toThrow(/invalid model/i);
    }
  });

  test("rejects baseUrls with query strings or fragments (avoid surprise composition)", () => {
    expect(() =>
      buildByotConfigForProvider({
        slug: "x",
        provider: "openai-compatible",
        baseUrl: "https://example.com/v1?foo=bar",
        model: "x/y",
      }),
    ).toThrow(/baseUrl/i);
    expect(() =>
      buildByotConfigForProvider({
        slug: "x",
        provider: "openai-compatible",
        baseUrl: "https://example.com/v1#frag",
        model: "x/y",
      }),
    ).toThrow(/baseUrl/i);
  });

  test("does not accept inline plaintext apiKey field (defense in depth)", () => {
    const out = buildByotConfigForProvider({
      slug: "smile-wring-011b",
      provider: "openai-compatible",
      baseUrl: "https://openrouter.ai/api/v1",
      model: "x/y",
    });
    const json = JSON.stringify(out);
    expect(json).not.toMatch(/"apiKey"\s*:\s*"sk-/);
    expect(json).not.toMatch(/"apiKey"\s*:\s*"gsk_/);
  });
});

describe("buildByotConfigForProvider — slug grammar", () => {
  test("rejects slugs with characters that would break SM ids", () => {
    for (const bad of ["has/slash", "has.dot", "has space", ""]) {
      expect(() => buildByotConfigForProvider({ slug: bad, provider: "anthropic" })).toThrow(
        /invalid slug/i,
      );
    }
  });
});

describe("buildByotConfigForProvider — never embeds plaintext", () => {
  test.each<ByotConfigInput>([
    { slug: "smile-wring-011b", provider: "anthropic" },
    { slug: "smile-wring-011b", provider: "openai", model: "openai/gpt-5" },
    {
      slug: "smile-wring-011b",
      provider: "openai-compatible",
      baseUrl: "https://api.openrouter.ai/v1",
      model: "x/y",
    },
  ])("provider=$provider produces no plaintext key", (input) => {
    const out = buildByotConfigForProvider(input);
    const json = JSON.stringify(out);
    expect(json).not.toContain("sk-");
    expect(json).not.toContain("gsk_");
  });
});
