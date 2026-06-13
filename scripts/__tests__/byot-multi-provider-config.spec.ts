import { describe, it, expect } from "vitest";
import {
  buildByotConfigForProvider,
  buildCodexAuthProfilesStore,
  buildCodexAuthJsonFromStore,
  buildClaudeCliAuthProfilesStore,
  claudeCliRuntimeConfig,
  codexRuntimeConfig,
  CLAUDE_CLI_DEFAULT_PROFILE_ID,
  type ByotConfigInput,
} from "../lib/byot-multi-provider-config.js";

const jwt = (claims: Record<string, unknown>) =>
  "e30." + Buffer.from(JSON.stringify(claims)).toString("base64url") + ".sig";

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

describe("buildCodexAuthProfilesStore — codex-shape per-agent OAuth profile (beta.6)", () => {
  it("maps a codex auth.json into the proven openai-codex:default OAuthCredential", () => {
    const idToken = jwt({
      email: "u@example.com",
      "https://api.openai.com/auth": { chatgpt_plan_type: "plus" },
    });
    const authJson = JSON.stringify({
      auth_mode: "chatgpt",
      OPENAI_API_KEY: null,
      tokens: {
        id_token: idToken,
        access_token: "acc-123",
        refresh_token: "ref-456",
        account_id: "acct-789",
      },
      last_refresh: "2026-05-18T00:11:06Z",
    });
    expect(buildCodexAuthProfilesStore(authJson)).toEqual({
      version: 1,
      profiles: {
        "openai-codex:default": {
          type: "oauth",
          provider: "openai-codex",
          access: "acc-123",
          refresh: "ref-456",
          expires: 0,
          accountId: "acct-789",
          idToken,
          chatgptPlanType: "plus",
          email: "u@example.com",
          copyToAgents: true,
        },
      },
    });
  });

  it("omits idToken/chatgptPlanType/email when id_token absent — no throw", () => {
    const out = buildCodexAuthProfilesStore(
      JSON.stringify({ tokens: { access_token: "a", refresh_token: "r", account_id: "x" } }),
    );
    const p = out.profiles["openai-codex:default"];
    expect(p).toEqual({
      type: "oauth",
      provider: "openai-codex",
      access: "a",
      refresh: "r",
      expires: 0,
      accountId: "x",
      copyToAgents: true,
    });
  });

  it("fail-loud when tokens.access_token is missing (useless credential)", () => {
    expect(() =>
      buildCodexAuthProfilesStore(JSON.stringify({ tokens: { refresh_token: "r" } })),
    ).toThrow(/access_token/);
    expect(() => buildCodexAuthProfilesStore("not json")).toThrow();
  });

  it("fail-loud when tokens.refresh_token is missing — expires:0 makes a refresh-less blob dead-on-arrival (PR #989)", () => {

expect(() =>
      buildCodexAuthProfilesStore(
        JSON.stringify({ auth_mode: "chatgpt", tokens: { access_token: "a" } }),
      ),
    ).toThrow(/refresh_token/);
  });

  it("real-expiry: access_token JWT exp (seconds) → openclaw expires (epoch ms)", () => {
    const out = buildCodexAuthProfilesStore(
      JSON.stringify({
        auth_mode: "chatgpt",
        tokens: { access_token: jwt({ exp: 1_893_456_000 }), refresh_token: "r" },
      }),
    );
    
    expect(out.profiles["openai-codex:default"].expires).toBe(1_893_456_000_000);
  });

  it("fail-safe: non-JWT / no exp / non-numeric exp access_token → expires 0 (force refresh, prior behavior)", () => {
    const exp0 = (accessToken: string) =>
      buildCodexAuthProfilesStore(
        JSON.stringify({
          auth_mode: "chatgpt",
          tokens: { access_token: accessToken, refresh_token: "r" },
        }),
      ).profiles["openai-codex:default"].expires;
    expect(exp0("not-a-jwt")).toBe(0); 
    expect(exp0(jwt({}))).toBe(0); 
    expect(exp0(jwt({ exp: "soon" }))).toBe(0); 
    expect(exp0(jwt({ exp: 0 }))).toBe(0); 
  });
});

describe("buildCodexAuthJsonFromStore — Chunk B inverse-mapper (sync-back)", () => {
  it("round-trips a captured codex auth.json through store→json→store", () => {
    const idToken = jwt({
      email: "u@example.com",
      "https://api.openai.com/auth": { chatgpt_plan_type: "plus" },
    });
    const accessJwt = jwt({ exp: 1_893_456_000 });
    const original = JSON.stringify({
      auth_mode: "chatgpt",
      OPENAI_API_KEY: null,
      tokens: {
        access_token: accessJwt,
        refresh_token: "ref-ROTATED",
        account_id: "acct-1",
        id_token: idToken,
      },
    });
    const store = buildCodexAuthProfilesStore(original);
    const back = buildCodexAuthJsonFromStore(JSON.stringify(store));
    expect(back).not.toBeNull();
    
    expect(buildCodexAuthProfilesStore(back as string)).toEqual(store);
    const tokens = JSON.parse(back as string).tokens;
    expect(tokens.access_token).toBe(accessJwt);
    expect(tokens.refresh_token).toBe("ref-ROTATED");
    expect(tokens.account_id).toBe("acct-1");
    expect(tokens.id_token).toBe(idToken);
  });

  it("emits a blob validateCodexCredential-shaped (auth_mode + tokens.access/refresh)", () => {
    const store = buildCodexAuthProfilesStore(
      JSON.stringify({ auth_mode: "chatgpt", tokens: { access_token: "a", refresh_token: "r" } }),
    );
    const blob = JSON.parse(buildCodexAuthJsonFromStore(JSON.stringify(store)) as string);
    expect(blob.auth_mode).toBe("chatgpt");
    expect(blob.tokens.access_token).toBe("a");
    expect(blob.tokens.refresh_token).toBe("r");
    expect("account_id" in blob.tokens).toBe(false); 
  });

  it("null when nothing usable to sync (no codex profile / missing access|refresh / garbage)", () => {
    expect(buildCodexAuthJsonFromStore("not json")).toBeNull();
    expect(buildCodexAuthJsonFromStore(JSON.stringify({ version: 1 }))).toBeNull();
    expect(
      buildCodexAuthJsonFromStore(
        JSON.stringify({ profiles: { "anthropic:default": { type: "api_key" } } }),
      ),
    ).toBeNull();
    expect(
      buildCodexAuthJsonFromStore(
        JSON.stringify({
          profiles: { "openai-codex:default": { type: "oauth", access: "a" } },
        }),
      ),
    ).toBeNull(); 
    expect(
      buildCodexAuthJsonFromStore(
        JSON.stringify({
          profiles: { "openai-codex:default": { type: "api_key", access: "a", refresh: "r" } },
        }),
      ),
    ).toBeNull(); 
  });
});

describe("claudeCliRuntimeConfig — Claude SUBSCRIPTION coach model + agentRuntime:claude-cli", () => {
  it("pins agentRuntime:{id:claude-cli} on Opus 4.8 so a per-agent override routes through the Claude CLI sub, not the platform anthropic API key", () => {
    expect(claudeCliRuntimeConfig()).toEqual({
      model: "anthropic/claude-opus-4-8",
      modelsDef: {
        "anthropic/claude-opus-4-8": { agentRuntime: { id: "claude-cli" } },
      },
    });
  });
});

describe("buildClaudeCliAuthProfilesStore — claude-cli per-agent OAuth profile from a setup-token", () => {
  const NOW = 1_700_000_000_000;
  const ONE_YEAR_MS = 365 * 24 * 60 * 60 * 1000;

  it("maps a setup-token bearer into the anthropic:claude-cli OAuthCredential (no refresh — the sub token has none)", () => {
    expect(buildClaudeCliAuthProfilesStore("sk-ant-oat01-abc", NOW)).toEqual({
      version: 1,
      profiles: {
        [CLAUDE_CLI_DEFAULT_PROFILE_ID]: {
          type: "oauth",
          provider: "claude-cli",
          access: "sk-ant-oat01-abc",
          expires: NOW + ONE_YEAR_MS,
          copyToAgents: true,
        },
      },
    });
  });

  it("CLAUDE_CLI_DEFAULT_PROFILE_ID is the claude-cli profile key", () => {
    expect(CLAUDE_CLI_DEFAULT_PROFILE_ID).toBe("anthropic:claude-cli");
  });

  it("fail-loud on an empty token (a useless credential)", () => {
    expect(() => buildClaudeCliAuthProfilesStore("", NOW)).toThrow();
    expect(() => buildClaudeCliAuthProfilesStore("   ", NOW)).toThrow();
  });

  it("expires is stable for a given mint time (1yr out) — not boot-volatile when the same now is threaded", () => {
    const a = buildClaudeCliAuthProfilesStore("sk-ant-oat01-x", NOW);
    const b = buildClaudeCliAuthProfilesStore("sk-ant-oat01-x", NOW);
    expect(a.profiles[CLAUDE_CLI_DEFAULT_PROFILE_ID].expires).toBe(
      b.profiles[CLAUDE_CLI_DEFAULT_PROFILE_ID].expires,
    );
  });
});

describe("buildByotConfigForProvider — claude-cli (Claude subscription) at parity with codex", () => {
  const base: ByotConfigInput = { slug: "acme", provider: "claude-cli" };

  it("emits an oauth profile (no keyRef) — the credential is the per-agent claude-cli store", () => {
    const out = buildByotConfigForProvider(base);
    expect(out.authProfiles).toEqual({
      profiles: { "anthropic:claude-cli": { type: "oauth", provider: "claude-cli" } },
    });
    expect(out.models).toBeNull();
  });

  it("overrides the agent model to Opus 4.8 (the sub-routed model)", () => {
    expect(buildByotConfigForProvider(base).agentModelOverride).toBe(
      "anthropic/claude-opus-4-8",
    );
  });
});
