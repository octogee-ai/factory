import { describe, expect, it, vi } from "vitest";
import { applyPlatformModelAllowlist } from "./byot-sync-runtime.js";

describe("native model picker allowlist", () => {
  it("offers the full platform catalog while preserving BYOSUB entries and the current default", async () => {
    const applyConfigPatch = vi.fn(async (args) => {
      const patch = args.buildPatch({ agents: { defaults: {
        model: "claude-cli/claude-opus-4-8",
        models: { "claude-cli/claude-opus-4-8": {}, "openai/gpt-5.5": { agentRuntime: { id: "codex" } } },
      } } });
      expect(patch.agents.defaults).not.toHaveProperty("model");
      expect(patch.agents.defaults.modelPolicy).toEqual({ allow: [] });
      expect(patch.agents.defaults.models).toMatchObject({
        "platform-openai/gpt-6-astra": {},
        "platform-openrouter/openai/gpt-6-astra": {},
        "platform-openrouter/anthropic/claude-opus-5": {},
        "platform-openrouter/x-ai/grok-4.6": {},
      });
      expect(Object.keys(patch.agents.defaults.models)).not.toContain("claude-cli/claude-opus-4-8");
      expect(Object.keys(patch.agents.defaults.models)).not.toContain("openai/gpt-5.5");
      expect(args.buildReplacePaths()).toEqual(["agents.defaults.modelPolicy.allow"]);
      expect(args.skipIfAlreadyApplied).toBe(true);
      return { mode: "rpc" as const, attempts: 1, noop: true };
    });
    expect(await applyPlatformModelAllowlist(applyConfigPatch, true)).toBe(false);
  });

  it("uses provider-wide model permissions for customer broker routes", async () => {
    await applyPlatformModelAllowlist(async (args) => {
      expect(args.buildPatch({})).toMatchObject({ agents: { defaults: {
        modelPolicy: { allow: ["anthropic/*", "platform-openrouter/*", "platform-openai/*", "platform-vertex/*"] },
      } } });
      return { mode: "rpc", attempts: 1 };
    }, false);
  });

  it.each([true, false])("removes retired broker models while retaining authenticated providers (Builder: %s)", async (builder) => {
    await applyPlatformModelAllowlist(async (args) => {
      const patch = args.buildPatch({ agents: { defaults: { models: {
        "platform-openrouter/provider/retired-model": { alias: "retired" },
        "platform-openai/retired-model": {},
        "claude-cli/custom-subscription-model": {},
        "openai/custom-subscription-model": { agentRuntime: { id: "codex" } },
        "anthropic/custom-api-model": {},
      } } } }) as { agents: { defaults: { models: Record<string, unknown> } } };
      expect(patch.agents.defaults.models).toMatchObject({
        "platform-openrouter/provider/retired-model": null,
        "platform-openai/retired-model": null,
        "platform-openai/gpt-6-astra": { alias: "astra" },
      });
      for (const ref of ["claude-cli/custom-subscription-model", "openai/custom-subscription-model", "anthropic/custom-api-model"]) {
        expect(patch.agents.defaults.models).not.toHaveProperty(ref);
      }
      return { mode: "rpc", attempts: 1 };
    }, builder);
  });

  it("propagates a rejected config update so the sync can retry", async () => {
    await expect(applyPlatformModelAllowlist(async () => { throw new Error("gateway unavailable"); }))
      .rejects.toThrow("gateway unavailable");
  });
});
