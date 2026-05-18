import { describe, it, expect } from "vitest";
import {
  buildByotConfigForProvider,
  buildCodexAuthProfilesStore,
  buildCodexAuthJsonFromStore,
  codexRuntimeConfig,
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
    // access present but no refresh: pre-fix this silently produced an
    // expires:0 profile with no refresh material → openclaw fails at
    // runtime AFTER validate-before-write passed (routing already flipped).
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
    // openclaw expires is epoch-ms (proven: `new Date(cred.expires)`).
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
    expect(exp0("not-a-jwt")).toBe(0); // placeholder/opaque token
    expect(exp0(jwt({}))).toBe(0); // JWT but no exp claim
    expect(exp0(jwt({ exp: "soon" }))).toBe(0); // exp not numeric
    expect(exp0(jwt({ exp: 0 }))).toBe(0); // non-positive
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
    // re-mapping the inverse must reproduce the same Plane-1 store
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
    expect("account_id" in blob.tokens).toBe(false); // omitted when absent
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
    ).toBeNull(); // no refresh → not round-trippable
    expect(
      buildCodexAuthJsonFromStore(
        JSON.stringify({
          profiles: { "openai-codex:default": { type: "api_key", access: "a", refresh: "r" } },
        }),
      ),
    ).toBeNull(); // not an oauth profile
  });
});
