import { describe, it, test, expect, beforeEach, afterEach, vi } from "vitest";

const { gatewayRestartRequestSpy, secretsReloadSpy, closeSpy, createGatewayRpcSpy } = vi.hoisted(() => {
  const gatewayRestartRequestSpy = vi.fn(async () => ({ status: "requested" }));
  const secretsReloadSpy = vi.fn(async () => ({ ok: true, warningCount: 0 }));
  const closeSpy = vi.fn(async () => {});
  const createGatewayRpcSpy = vi.fn(() => ({
    gatewayRestartRequest: gatewayRestartRequestSpy,
    secretsReload: secretsReloadSpy,
    close: closeSpy,
    configGet: vi.fn(),
    configPatch: vi.fn(),
    channelsStatus: vi.fn(),
    isGatewayUp: vi.fn(async () => true),
  }));
  return { gatewayRestartRequestSpy, secretsReloadSpy, closeSpy, createGatewayRpcSpy };
});

vi.mock("./gateway-rpc", () => ({
  OpenclawWireError: class OpenclawWireError extends Error {
    code: string;
    constructor(code: string, message: string) {
      super(message);
      this.code = code;
      this.name = "OpenclawWireError";
    }
  },
  createGatewayRpc: createGatewayRpcSpy,
}));

const SUBPROCESS_GUARD = (name: string) => () => {
  throw new Error(
    `byot-sync must not shell out (called ${name}) — use the in-process gateway-rpc client.`,
  );
};
vi.mock("child_process", async () => {
  const actual = await vi.importActual<typeof import("child_process")>("child_process");
  return {
    ...actual,
    spawn: vi.fn(SUBPROCESS_GUARD("spawn")),
    spawnSync: vi.fn(SUBPROCESS_GUARD("spawnSync")),
    exec: vi.fn(SUBPROCESS_GUARD("exec")),
    execSync: vi.fn(SUBPROCESS_GUARD("execSync")),
    execFile: vi.fn(SUBPROCESS_GUARD("execFile")),
    execFileSync: vi.fn(SUBPROCESS_GUARD("execFileSync")),
    fork: vi.fn(SUBPROCESS_GUARD("fork")),
  };
});

vi.mock("./internal-fetch", () => ({ internalFetch: vi.fn() }));

import { deriveDesiredByotState, byosCoachConfigPatch, coachFullAgentList } from "./byot-sync.js";
import {
  triggerSecretsReload,
  restoreOauthStoreForSlug,
  brokerFetchByosubCreds,
  applyCoachModelPatch,
  applyOauthRuntimeModelAllowlist,
  requestGatewayRestartForRuntimeChange,
  syncByotForCustomer,
  applyAgentModelOverrides,
  markerProvidersForSlot,
} from "./byot-sync-runtime";
import { internalFetch } from "./internal-fetch.js";
import { codexAuthJsonPath, codexAgentDir } from "./byosub-restore.js";
import { readAuthProfileStore } from "./auth-profile-sqlite.js";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const ON = {
  byotActive: true,
  username: "tester-70",
  provisioning: { openclaw: { status: "complete" } },
};

const jwt = (claims: Record<string, unknown>) =>
  "e30." + Buffer.from(JSON.stringify(claims)).toString("base64url") + ".s";
const codexBlob = () =>
  JSON.stringify({
    auth_mode: "chatgpt",
    tokens: {
      id_token: jwt({ email: "u@example.com" }),
      access_token: "acc-1",
      refresh_token: "ref-1",
      account_id: "acct-1",
    },
  });

describe("deriveDesiredByotState — gating (characterization)", () => {
  it("disabled unless byotActive + username + status=complete", () => {
    expect(deriveDesiredByotState({ ...ON, byotActive: false }).enabled).toBe(false);
    expect(deriveDesiredByotState({ ...ON, username: undefined }).enabled).toBe(false);
    expect(
      deriveDesiredByotState({ ...ON, provisioning: { openclaw: { status: "in_progress" } } })
        .enabled,
    ).toBe(false);
  });

  it("free post-trial non-BYOK derives the GLM house-model patch without local BYOT materialization", () => {
    const desired = deriveDesiredByotState({
      ...ON,
      byotActive: false,
      selectedTier: "free",
    });
    expect(desired.enabled).toBe(false);
    expect(desired.input).toBeNull();
    expect(desired.coachModelInput).toEqual({
      slug: "tester-70",
      model: "platform-openrouter/z-ai/glm-5.2",
      source: "free-tier",
    });
  });

  it("non-BYOK trial coach keeps the template Sonnet default (no patch)", () => {
    const desired = deriveDesiredByotState({
      ...ON,
      byotActive: false,
      selectedTier: "personal_free",
      subscription: { trialStartedAt: new Date() },
    });
    expect(desired.enabled).toBe(false);
    expect(desired.input).toBeNull();
    expect(desired.coachModelInput).toBeNull();
  });

  it("paid non-BYOK customer leaves the config default model in place (no cohort pin)", () => {
    const desired = deriveDesiredByotState({
      ...ON,
      byotActive: false,
      selectedTier: "personal",
      provisioning: { openclaw: { status: "complete" } },
    });
    expect(desired.enabled).toBe(false);
    expect(desired.input).toBeNull();
    expect(desired.coachModelInput).toBeNull();
  });

  it("unknown/absent provider falls back to anthropic (api_key default)", () => {
    expect(deriveDesiredByotState({ ...ON }).input).toEqual({
      slug: "tester-70",
      provider: "anthropic",
      baseUrl: undefined,
      model: undefined,
    });
    expect(
      deriveDesiredByotState({ ...ON, systemConfig: { byot: { provider: "bogus" } } }).input!
        .provider,
    ).toBe("anthropic");
  });
});

describe("deriveDesiredByotState — recognizes every PROVIDERS-registry provider", () => {
  it.each(["openai", "openai-compatible", "anthropic"] as const)(
    "BYOT api_key provider %s is recognized (regression)",
    (provider) => {
      expect(
        deriveDesiredByotState({ ...ON, systemConfig: { byot: { provider } } }).input!.provider,
      ).toBe(provider);
    },
  );

  it("BYOS oauth provider openai-codex is recognized (rides the SAME sync path as BYOT)", () => {
    const { enabled, input } = deriveDesiredByotState({
      ...ON,
      systemConfig: { byot: { provider: "openai-codex" } },
    });
    expect(enabled).toBe(true);
    expect(input).toEqual({
      slug: "tester-70",
      provider: "openai-codex",
      baseUrl: undefined,
      model: undefined,
    });
  });

  it("BYOS oauth provider claude-cli (Claude subscription) is recognized — rides the same sync path", () => {
    const { enabled, input } = deriveDesiredByotState({
      ...ON,
      systemConfig: { byot: { provider: "claude-cli" } },
    });
    expect(enabled).toBe(true);
    expect(input).toEqual({
      slug: "tester-70",
      provider: "claude-cli",
      baseUrl: undefined,
      model: undefined,
    });
  });
});

describe("triggerSecretsReload — in-process RPC, no subprocess", () => {
  beforeEach(() => {
    gatewayRestartRequestSpy.mockClear();
    secretsReloadSpy.mockClear();
    closeSpy.mockClear();
    createGatewayRpcSpy.mockClear();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("calls gateway-rpc.secretsReload() and closes the client", async () => {
    secretsReloadSpy.mockResolvedValueOnce({ ok: true, warningCount: 0 });
    await triggerSecretsReload();
    expect(createGatewayRpcSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        allowLegacyGatewayTokenFallback: true,
        callTimeoutMs: 10_000,
        connectTimeoutMs: 10_000,
      }),
    );
    expect(secretsReloadSpy).toHaveBeenCalledTimes(1);
    expect(closeSpy).toHaveBeenCalledTimes(1);
  });

  test("never throws on a transport failure — best-effort contract preserved", async () => {
    secretsReloadSpy.mockRejectedValueOnce(new Error("ECONNREFUSED"));
    await expect(triggerSecretsReload()).resolves.toBeUndefined();
    expect(closeSpy).toHaveBeenCalledTimes(1);
  });

  test("still closes the client when the RPC throws (no resource leak)", async () => {
    secretsReloadSpy.mockRejectedValueOnce(new Error("auth-failed"));
    await triggerSecretsReload();
    expect(closeSpy).toHaveBeenCalledTimes(1);
  });
});

describe("requestGatewayRestartForRuntimeChange — in-process RPC, no subprocess", () => {
  beforeEach(() => {
    gatewayRestartRequestSpy.mockClear();
    closeSpy.mockClear();
    createGatewayRpcSpy.mockClear();
  });

  test("requests an OpenClaw-aware restart and closes the client", async () => {
    gatewayRestartRequestSpy.mockResolvedValueOnce({ status: "requested" });
    await expect(requestGatewayRestartForRuntimeChange()).resolves.toBe(true);
    expect(createGatewayRpcSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        allowLegacyGatewayTokenFallback: true,
        callTimeoutMs: 10_000,
        connectTimeoutMs: 10_000,
      }),
    );
    expect(gatewayRestartRequestSpy).toHaveBeenCalledWith({
      reason: "byosub.oauth-runtime",
      skipDeferral: true,
    });
    expect(closeSpy).toHaveBeenCalledTimes(1);
  });

  test("returns false on restart failure so sync can fall back to secrets.reload", async () => {
    gatewayRestartRequestSpy.mockRejectedValueOnce(new Error("restart disabled"));
    await expect(requestGatewayRestartForRuntimeChange()).resolves.toBe(false);
    expect(closeSpy).toHaveBeenCalledTimes(1);
  });
});

describe("markerProvidersForSlot — byosub provider set → PROVIDERS-registry oauth providers", () => {
  const agentId = "octogee-a-coach";
  it("maps connected subscription providers and returns [] when absent", () => {
    expect(
      markerProvidersForSlot(
        {
          [agentId]: {
            providers: {
              anthropic: { provider: "anthropic", secretName: "s-a" },
              openai: { provider: "openai", secretName: "s-o" },
            },
          },
        },
        agentId,
      ),
    ).toEqual(["openai-codex", "claude-cli"]);
    expect(markerProvidersForSlot(undefined, agentId)).toEqual([]);
    expect(markerProvidersForSlot({}, agentId)).toEqual([]);
  });
});

describe("restoreOauthStoreForSlug — post-boot-mount oauth-store materialization", () => {
  const tmps: string[] = [];
  const mk = () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "byot-oauth-"));
    tmps.push(d);
    return d;
  };
  afterEach(() => {
    for (const d of tmps.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  });

  it("materializes the per-agent codex-home for a mounted oauth customer (restored + present)", async () => {
    const oc = mk();
    const r = await restoreOauthStoreForSlug("tester-70", {
      fetchByosubCreds: async () => [
        {
          provider: "openai",
          secretName: "byosub-uid-openai",
          credential: codexBlob(),
        },
      ],
      openclawDir: oc,
    });
    expect(r.restored).toBe(true);
    expect(r.present).toBe(true);
    expect(
      JSON.parse(fs.readFileSync(codexAuthJsonPath(oc, "octogee-tester-70-coach"), "utf-8"))
        .auth_mode,
    ).toBe("chatgpt");

    const agentDir = codexAgentDir(oc, "octogee-tester-70-coach");
    const prof = readAuthProfileStore(agentDir) as {
      version: number;
      profiles: Record<string, unknown>;
    };
    expect(prof.version).toBe(1);
    expect(prof.profiles["openai-codex:default"]).toMatchObject({
      type: "oauth",
      provider: "openai-codex",
      access: "acc-1",
      refresh: "ref-1",
      expires: 0,
      copyToAgents: true,
    });
  });

  it("materializes Claude and Codex from one hosted-agent broker response", async () => {
    const oc = mk();
    const home = mk();
    const r = await restoreOauthStoreForSlug("tester-70", {
      fetchByosubCreds: async () => [
        {
          provider: "openai",
          secretName: "byosub-uid-openai",
          credential: codexBlob(),
        },
        {
          provider: "anthropic",
          secretName: "byosub-uid-anthropic",
          credential: JSON.stringify({
            claudeAiOauth: {
              accessToken: "claude-access-1",
              refreshToken: "claude-refresh-1",
              expiresAt: Date.now() + 24 * 60 * 60 * 1000,
            },
          }),
        },
      ],
      openclawDir: oc,
      claudeCliNativeHomeDir: home,
    });

    expect(r).toEqual({ restored: true, present: true, providers: ["openai", "anthropic"] });
    expect(
      JSON.parse(fs.readFileSync(codexAuthJsonPath(oc, "octogee-tester-70-coach"), "utf-8"))
        .auth_mode,
    ).toBe("chatgpt");
    expect(fs.existsSync(path.join(home, ".claude", ".credentials.json"))).toBe(true);
    const prof = readAuthProfileStore(codexAgentDir(oc, "octogee-tester-70-coach")) as {
      profiles: Record<string, { provider?: string; access?: string }>;
    };
    expect(prof.profiles["openai-codex:default"]).toMatchObject({
      provider: "openai-codex",
      access: "acc-1",
    });
    expect(prof.profiles["anthropic:claude-cli"]).toMatchObject({
      provider: "claude-cli",
      access: "claude-access-1",
    });
  });

  it("Copilot #2: a FAILED restore does NOT activate (not restored, not present)", async () => {
    const oc = mk();
    const r = await restoreOauthStoreForSlug("tester-70", {
      fetchByosubCreds: async () => {
        throw new Error("transient broker failure");
      },
      openclawDir: oc,
      logFn: () => {},
    });
    expect(r.restored).toBe(false);
    expect(r.present).toBe(false);
    const ap = path.join(oc, "agents", "octogee-tester-70-coach", "agent", "auth-profiles.json");
    expect(fs.existsSync(ap)).toBe(false); 
  });

  it("not restored / not present when this customer has no byosub ref (nothing to restore)", async () => {
    const r = await restoreOauthStoreForSlug("tester-70", {
      fetchByosubCreds: async () => null,
      openclawDir: mk(),
    });
    expect(r.restored).toBe(false);
    expect(r.present).toBe(false);
  });

  it("never throws — a fetch failure is neither restored nor present (mount continues)", async () => {
    const r = await restoreOauthStoreForSlug("tester-70", {
      fetchByosubCreds: async () => {
        throw new Error("glmGateways read failed");
      },
      openclawDir: mk(),
      logFn: () => {},
    });
    expect(r.restored).toBe(false);
    expect(r.present).toBe(false);
  });

  it("re-mount over a healthy on-disk cred → conservative skip → NOT restored but present", async () => {
    const oc = mk();
    const opts = {
      fetchByosubCreds: async () => [
        {
          provider: "openai" as const,
          secretName: "byosub-uid-openai",
          credential: codexBlob(),
        },
      ],
      openclawDir: oc,
      logFn: () => {},
    };
    
    const first = await restoreOauthStoreForSlug("tester-70", opts);
    expect(first.restored).toBe(true);
    expect(first.present).toBe(true);

    const second = await restoreOauthStoreForSlug("tester-70", opts);
    expect(second.restored).toBe(false);
    expect(second.present).toBe(true);
    expect(second.providers).toEqual(["openai"]);
  });
});

describe("brokerFetchByosubCreds — gateway-side broker client (no silent failures)", () => {
  beforeEach(() => vi.mocked(internalFetch).mockReset());

  it("returns the materialized credentials on 200", async () => {
    vi.mocked(internalFetch).mockResolvedValue(
      new Response(
        JSON.stringify({
          credentials: [
            {
              provider: "anthropic",
              secretName: "byosub-uid-anthropic",
              credential: "tok",
            },
          ],
        }),
        { status: 200 },
      ),
    );
    expect(await brokerFetchByosubCreds("octogee-tester5-coach")).toEqual([
      {
        provider: "anthropic",
        secretName: "byosub-uid-anthropic",
        credential: "tok",
      },
    ]);
  });

  it("returns null on 404 (no byosub ref for this agent — nothing to restore)", async () => {
    vi.mocked(internalFetch).mockResolvedValue(new Response("{}", { status: 404 }));
    expect(await brokerFetchByosubCreds("octogee-tester5-coach")).toBeNull();
  });

  it("throws on a non-ok, non-404 status (fail loud, never a silent skip)", async () => {
    vi.mocked(internalFetch).mockResolvedValue(new Response("boom", { status: 500 }));
    await expect(brokerFetchByosubCreds("octogee-tester5-coach")).rejects.toThrow(/500/);
  });

  it("throws on a malformed broker response (never a half-materialized cred)", async () => {
    vi.mocked(internalFetch).mockResolvedValue(
      new Response(JSON.stringify({ provider: "anthropic" }), { status: 200 }),
    );
    await expect(brokerFetchByosubCreds("octogee-tester5-coach")).rejects.toThrow(/malformed/);
  });
});

// Every BYOK coach model is a primary+fallback chain to the platform house
// model baseline (B6).
const withFallback = (primary: string) => ({
  primary,
  fallbacks: ["platform-openrouter/z-ai/glm-5.2"],
});

const claudeCliDefaultModels = {
  "claude-cli/claude-opus-4-8": {},
  "claude-cli/claude-opus-4-7": {},
  "claude-cli/claude-sonnet-4-6": {},
  "claude-cli/claude-opus-4-6": {},
};

describe("byosCoachConfigPatch — durable coach-model patch (#1001 core)", () => {
  const id = "octogee-tester-70-coach";
  it("null input / no-override providers → null (keep gateway default, no per-agent model)", () => {
    expect(byosCoachConfigPatch(null)).toBeNull();
    expect(byosCoachConfigPatch({ slug: "tester-70", provider: "anthropic" })).toBeNull();
  });

  it("free-tier platform baseline → GLM primary with no BYOK credential profile", () => {
    expect(
      byosCoachConfigPatch({
        slug: "tester-70",
        model: "platform-openrouter/z-ai/glm-5.2",
        source: "free-tier",
      }),
    ).toEqual({
      agents: { list: [{ id, model: { primary: "platform-openrouter/z-ai/glm-5.2", fallbacks: [] } }] },
    });
  });

  it("openai-codex → coach model + agentRuntime:codex; runtime allowlist owns codex plugin config", () => {
    expect(byosCoachConfigPatch({ slug: "tester-70", provider: "openai-codex" })).toEqual({
      agents: {
        list: [{ id, model: withFallback("openai/gpt-5.5") }],
        defaults: { models: { "openai/gpt-5.5": { agentRuntime: { id: "codex" } } } },
      },
    });
  });

  it("claude-cli (Claude subscription) → default model plus the Claude CLI provider catalog", () => {
    expect(byosCoachConfigPatch({ slug: "tester-70", provider: "claude-cli" })).toEqual({
      agents: {
        list: [{ id, model: withFallback("claude-cli/claude-opus-4-8") }],
        defaults: {
          models: claudeCliDefaultModels,
        },
      },
    });
  });

  it("openai (api_key) → coach model only, NO agentRuntime pin", () => {
    expect(byosCoachConfigPatch({ slug: "tester-70", provider: "openai" })).toEqual({
      agents: { list: [{ id, model: withFallback("openai/gpt-5") }] },
    });
  });

  it("openai-compatible → namespaced custom model, no agentRuntime pin", () => {
    expect(
      byosCoachConfigPatch({
        slug: "tester-70",
        provider: "openai-compatible",
        baseUrl: "https://llm.example.com",
        model: "llama-3.1-70b",
      }),
    ).toEqual({ agents: { list: [{ id, model: withFallback("custom-tester-70/llama-3.1-70b") }] } });
  });
});

describe("coachFullAgentList — full-list upsert (coach model updated, every sibling preserved)", () => {
  it("updates only the coach's model, preserving its other fields + every sibling (incl. an id-less one)", () => {
    const current = {
      agents: {
        list: [
          { name: "legacy", model: "x/y" }, // id-less: this is what flips the array to wholesale
          { id: "octogee-tester-70-coach", name: "coach", model: "old", mmAccount: "a" },
          { id: "octogee-zed-coach", model: "z/y" },
        ],
      },
    };
    expect(coachFullAgentList(current, "octogee-tester-70-coach", withFallback("openai/gpt-5"))).toEqual([
      { name: "legacy", model: "x/y" },
      { id: "octogee-tester-70-coach", name: "coach", model: withFallback("openai/gpt-5"), mmAccount: "a" },
      { id: "octogee-zed-coach", model: "z/y" },
    ]);
  });

  it("no agents.list (empty/missing) → [] (a no-op patch, never a destructive replace)", () => {
    expect(coachFullAgentList(undefined, "octogee-tester-70-coach", withFallback("m"))).toEqual([]);
    expect(coachFullAgentList({ agents: {} }, "octogee-tester-70-coach", withFallback("m"))).toEqual([]);
  });
});

describe("applyCoachModelPatch — applies the durable patch, best-effort", () => {
  const CURRENT = {
    agents: {
      list: [
        { id: "octogee-tester-70-coach", name: "coach", model: "old", mmAccount: "a" },
        { id: "octogee-zed-coach", model: "z/y" },
      ],
    },
  };

  it("openai api_key input → ships the FULL agents.list + replacePaths:[agents.list], only the coach's model updated", async () => {
    const calls: object[] = [];
    let replacePaths: string[] | undefined;
    const r = await applyCoachModelPatch(
      { slug: "tester-70", provider: "openai" },
      {
        applyConfigPatch: async (args) => {
          calls.push(args.buildPatch(CURRENT));
          replacePaths = args.buildReplacePaths?.(CURRENT);
          return { mode: "rpc", attempts: 1 };
        },
      },
    );
    expect(r).toBe(true);
    // Load-bearing: an id-less base agent flips agents.list to wholesale, where
    // the guard (arrayPreservesBaseEntries) flags the re-modeled coach entry as
    // "removed" unless this exact path is confirmed. Without it applyConfigPatch
    // rejects the patch permanently and the coach silently stays on the platform key.
    expect(replacePaths).toEqual(["agents.list"]);
    expect(calls).toEqual([
      {
        agents: {
          list: [
            { id: "octogee-tester-70-coach", name: "coach", model: withFallback("openai/gpt-5"), mmAccount: "a" },
            { id: "octogee-zed-coach", model: "z/y" },
          ],
        },
      },
    ]);
  });

  it("shell-runtime BYOS providers (codex / claude-cli) patch the full list + model defaults", async () => {
    const codexCalls: object[] = [];
    const rc = await applyCoachModelPatch(
      { slug: "tester-70", provider: "openai-codex" },
      {
        applyConfigPatch: async (args) => {
          codexCalls.push(args.buildPatch(CURRENT));
          return { mode: "rpc", attempts: 1 };
        },
      },
    );
    expect(rc).toBe(true);
    expect(codexCalls).toEqual([
      {
        agents: {
          list: [
            { id: "octogee-tester-70-coach", name: "coach", model: withFallback("openai/gpt-5.5"), mmAccount: "a" },
            { id: "octogee-zed-coach", model: "z/y" },
          ],
          defaults: { models: { "openai/gpt-5.5": { agentRuntime: { id: "codex" } } } },
        },
      },
    ]);

    const claudeCalls: object[] = [];
    const ra = await applyCoachModelPatch(
      { slug: "tester-70", provider: "claude-cli" },
      {
        applyConfigPatch: async (args) => {
          claudeCalls.push(args.buildPatch(CURRENT));
          return { mode: "rpc", attempts: 1 };
        },
      },
    );
    expect(ra).toBe(true);
    // claude-cli is an openclaw CORE runtime — no plugin to enable.
    expect(claudeCalls).toEqual([
      {
        agents: {
          list: [
            { id: "octogee-tester-70-coach", name: "coach", model: withFallback("claude-cli/claude-opus-4-8"), mmAccount: "a" },
            { id: "octogee-zed-coach", model: "z/y" },
          ],
          defaults: { models: claudeCliDefaultModels },
        },
      },
    ]);
  });

  it("no-override / null → does NOT apply, returns false", async () => {
    let calls = 0;
    expect(
      await applyCoachModelPatch(null, {
        applyConfigPatch: async () => { calls += 1; return { mode: "rpc", attempts: 1 }; },
      }),
    ).toBe(false);
    expect(
      await applyCoachModelPatch(
        { slug: "tester-70", provider: "anthropic" },
        { applyConfigPatch: async () => { calls += 1; return { mode: "rpc", attempts: 1 }; } },
      ),
    ).toBe(false);
    expect(calls).toBe(0);
  });

  it("never throws — a failed apply returns false (sync continues → retried next sync)", async () => {
    const r = await applyCoachModelPatch(
      { slug: "tester-70", provider: "openai" },
      {
        applyConfigPatch: async () => {
          throw new Error("config.patch hash-mismatch exhausted");
        },
        logFn: () => {},
      },
    );
    expect(r).toBe(false);
  });

  it("operator gateway: applies the same runtime model patch as builder gateways", async () => {
    let calls = 0;
    const r = await applyCoachModelPatch(
      { slug: "tester-70", provider: "openai-codex" },
      {
        applyConfigPatch: async () => { calls += 1; return { mode: "rpc", attempts: 1 }; },
        isOperatorGateway: () => true,
      },
    );
    expect(r).toBe(true);
    expect(calls).toBe(1);
  });

  it("waits for the booting runtime: deadline-bounded retries, not a 3-shot budget (byot fires at pod boot before openclaw listens on :18789)", async () => {
    const opts: Array<Record<string, unknown>> = [];
    const r = await applyCoachModelPatch(
      { slug: "tester-70", provider: "openai" },
      {
        isOperatorGateway: () => false,
        applyConfigPatch: async (_args, o) => {
          opts.push(o ?? {});
          return { mode: "rpc", attempts: 1 };
        },
      },
    );
    expect(r).toBe(true);
    expect(opts).toHaveLength(1);
    expect(opts[0].maxRetries).toBe(Number.POSITIVE_INFINITY);
    expect(opts[0].totalDeadlineMs as number).toBeGreaterThanOrEqual(60_000);
  });
});

describe("applyOauthRuntimeModelAllowlist — provider-set runtime defaults", () => {
  it("allowlists every restored BYOSUB runtime without changing the coach primary model", async () => {
    const calls: object[] = [];
    const r = await applyOauthRuntimeModelAllowlist(["openai", "anthropic"], {
      applyConfigPatch: async (args) => {
        calls.push(args.buildPatch({}));
        return { mode: "rpc", attempts: 1 };
      },
    });

    expect(r).toEqual({ patched: true, changed: true, restartRequired: true });
    expect(calls).toEqual([
      {
        agents: {
          defaults: {
            models: {
              "openai/gpt-5.5": { agentRuntime: { id: "codex" } },
              ...claudeCliDefaultModels,
            },
          },
        },
        plugins: {
          entries: {
            codex: {
              enabled: true,
              config: { appServer: { sandbox: "workspace-write", approvalPolicy: "never" } },
            },
          },
        },
      },
    ]);
  });

  it("preserves an existing operator Codex sandbox while adding runtime defaults", async () => {
    const calls: object[] = [];
    const r = await applyOauthRuntimeModelAllowlist(["openai"], {
      applyConfigPatch: async (args) => {
        calls.push(args.buildPatch({
          plugins: {
            entries: {
              codex: {
                config: {
                  appServer: {
                    sandbox: "danger-full-access",
                    approvalPolicy: "never",
                  },
                },
              },
            },
          },
        }));
        return { mode: "rpc", attempts: 1 };
      },
    });

    expect(r).toEqual({ patched: true, changed: true, restartRequired: false });
    expect(calls).toEqual([
      {
        agents: {
          defaults: {
            models: {
              "openai/gpt-5.5": { agentRuntime: { id: "codex" } },
            },
          },
        },
        plugins: {
          entries: {
            codex: {
              enabled: true,
              config: {
                appServer: {
                  sandbox: "danger-full-access",
                  approvalPolicy: "never",
                },
              },
            },
          },
        },
      },
    ]);
  });

  it("does nothing when no OAuth providers were restored", async () => {
    const applyConfigPatchFn = vi.fn(async () => ({ mode: "rpc" as const, attempts: 1 }));
    await expect(
      applyOauthRuntimeModelAllowlist([], { applyConfigPatch: applyConfigPatchFn }),
    ).resolves.toEqual({ patched: false, changed: false, restartRequired: false });
    expect(applyConfigPatchFn).not.toHaveBeenCalled();
  });

  it("does not require a restart when config.patch reports a no-op", async () => {
    const r = await applyOauthRuntimeModelAllowlist(["anthropic"], {
      applyConfigPatch: async () => ({ mode: "rpc", attempts: 1, noop: true }),
    });
    expect(r).toEqual({ patched: true, changed: false, restartRequired: false });
  });
});

describe("standard gateway — BYOS materialization", () => {
  it("free post-trial non-BYOK customer removes local BYOT state, patches GLM, and reloads", async () => {
    const applyByotStateFn = vi.fn(() => false);
    const restoreOauthFn = vi.fn(async () => ({ restored: true, present: true }));
    const applyCoachModelPatchFn = vi.fn(async () => true);
    const triggerSecretsReloadFn = vi.fn(async () => {});

    await syncByotForCustomer(
      {
        byotActive: false,
        username: "tester-70",
        provisioning: { openclaw: { status: "complete" } },
        selectedTier: "free",
      },
      {
        usesLlmBrokerToken: () => true,
        isOperatorGateway: () => false,
        applyByotState: applyByotStateFn,
        restoreOauthStoreForSlug: restoreOauthFn,
        applyCoachModelPatch: applyCoachModelPatchFn,
        triggerSecretsReload: triggerSecretsReloadFn,
      },
    );

    expect(applyByotStateFn).toHaveBeenCalledWith("tester-70", null);
    expect(restoreOauthFn).not.toHaveBeenCalled();
    expect(applyCoachModelPatchFn).toHaveBeenCalledWith({
      slug: "tester-70",
      model: "platform-openrouter/z-ai/glm-5.2",
      source: "free-tier",
    });
    expect(triggerSecretsReloadFn).toHaveBeenCalledTimes(1);
  });

  it("trial non-BYOK customer leaves the template model untouched", async () => {
    const applyByotStateFn = vi.fn(() => false);
    const applyCoachModelPatchFn = vi.fn(async () => true);
    const triggerSecretsReloadFn = vi.fn(async () => {});

    await syncByotForCustomer(
      {
        byotActive: false,
        username: "tester-70",
        provisioning: { openclaw: { status: "complete" } },
        selectedTier: "personal_free",
        subscription: { trialStartedAt: new Date() },
      },
      {
        isOperatorGateway: () => false,
        applyByotState: applyByotStateFn,
        applyCoachModelPatch: applyCoachModelPatchFn,
        triggerSecretsReload: triggerSecretsReloadFn,
      },
    );

    expect(applyByotStateFn).toHaveBeenCalledWith("tester-70", null);
    expect(applyCoachModelPatchFn).not.toHaveBeenCalled();
    expect(triggerSecretsReloadFn).not.toHaveBeenCalled();
  });

  it("broker-token gateway: anthropic BYOT is broker-resolved, not materialized locally", async () => {
    const applyByotStateFn = vi.fn(() => true);
    const restoreOauthFn = vi.fn(async () => ({ restored: true, present: true }));
    const applyCoachModelPatchFn = vi.fn(async () => true);
    const materializeFn = vi.fn(() => false);
    const triggerSecretsReloadFn = vi.fn(async () => {});

    await syncByotForCustomer(
      {
        byotActive: true,
        username: "tester-70",
        provisioning: { openclaw: { status: "complete" } },
        systemConfig: { byot: { provider: "anthropic" } },
      },
      {
        usesLlmBrokerToken: () => true,
        isOperatorGateway: () => false,
        applyByotState: applyByotStateFn,
        restoreOauthStoreForSlug: restoreOauthFn,
        applyCoachModelPatch: applyCoachModelPatchFn,
        materializeAnthropicBroker: materializeFn,
        triggerSecretsReload: triggerSecretsReloadFn,
      },
    );

    expect(applyByotStateFn).toHaveBeenCalledWith("tester-70", null);
    expect(materializeFn).toHaveBeenCalledWith("tester-70");
    expect(restoreOauthFn).not.toHaveBeenCalled();
    expect(applyCoachModelPatchFn).not.toHaveBeenCalled();
    expect(triggerSecretsReloadFn).toHaveBeenCalledTimes(1);
  });

  it("materializes claude-cli BYOS on a standard gateway: applyByotState(input) + oauth-store restore + coach-model patch + reload", async () => {
    const applyByotStateFn = vi.fn(() => true);
    const restoreOauthFn = vi.fn(async () => ({ restored: true, present: true }));
    const applyCoachModelPatchFn = vi.fn(async () => true);
    const triggerSecretsReloadFn = vi.fn(async () => {});

    await syncByotForCustomer(
      {
        byotActive: true,
        username: "tester-70",
        selectedTier: "personal",
        provisioning: { openclaw: { status: "complete" } },
        systemConfig: { byot: { provider: "claude-cli" } },
      },
      {
        isOperatorGateway: () => false,
        applyByotState: applyByotStateFn,
        restoreOauthStoreForSlug: restoreOauthFn,
        applyCoachModelPatch: applyCoachModelPatchFn,
        triggerSecretsReload: triggerSecretsReloadFn,
      },
    );

    const input = {
      slug: "tester-70",
      provider: "claude-cli",
      baseUrl: undefined,
      model: undefined,
    };
    expect(applyByotStateFn).toHaveBeenCalledWith("tester-70", input);
    expect(restoreOauthFn).toHaveBeenCalledWith("tester-70");
    expect(applyCoachModelPatchFn).toHaveBeenCalledWith(input);
    expect(triggerSecretsReloadFn).toHaveBeenCalledTimes(1);
  });

  it("restores a multi-provider BYOSUB set, allowlists every runtime, then requests the Claude runtime restart", async () => {
    const applyByotStateFn = vi.fn(() => false);
    const restoreOauthFn = vi.fn(async () => ({
      restored: true,
      present: true,
      providers: ["openai", "anthropic"] as const,
    }));
    const applyCoachModelPatchFn = vi.fn(async () => true);
    const applyOauthRuntimeModelAllowlistFn = vi.fn(async () => ({
      patched: true,
      changed: true,
      restartRequired: true,
    }));
    const requestGatewayRestartFn = vi.fn(async () => true);
    const triggerSecretsReloadFn = vi.fn(async () => {});

    await syncByotForCustomer(
      {
        byotActive: true,
        username: "tester-70",
        provisioning: { openclaw: { status: "complete" } },
        systemConfig: { byot: { provider: "openai-codex" } },
      },
      {
        isOperatorGateway: () => false,
        applyByotState: applyByotStateFn,
        restoreOauthStoreForSlug: restoreOauthFn,
        applyCoachModelPatch: applyCoachModelPatchFn,
        applyOauthRuntimeModelAllowlist: applyOauthRuntimeModelAllowlistFn,
        requestGatewayRestart: requestGatewayRestartFn,
        triggerSecretsReload: triggerSecretsReloadFn,
      },
    );

    expect(restoreOauthFn).toHaveBeenCalledWith("tester-70");
    expect(applyOauthRuntimeModelAllowlistFn).toHaveBeenCalledWith(["openai", "anthropic"]);
    expect(applyCoachModelPatchFn).toHaveBeenCalledWith({
      slug: "tester-70",
      provider: "openai-codex",
      baseUrl: undefined,
      model: undefined,
    });
    expect(requestGatewayRestartFn).toHaveBeenCalledTimes(1);
    expect(triggerSecretsReloadFn).not.toHaveBeenCalled();
  });

  it("oauth credential absent (missing ref / transient SM failure) → does NOT pin the coach, preserving the platform-key fallback", async () => {
    const applyByotStateFn = vi.fn(() => false);
    const restoreOauthFn = vi.fn(async () => ({ restored: false, present: false }));
    const applyCoachModelPatchFn = vi.fn(async () => true);
    const triggerSecretsReloadFn = vi.fn(async () => {});

    await syncByotForCustomer(
      {
        byotActive: true,
        username: "tester-70",
        provisioning: { openclaw: { status: "complete" } },
        systemConfig: { byot: { provider: "openai-codex" } },
      },
      {
        isOperatorGateway: () => false,
        applyByotState: applyByotStateFn,
        restoreOauthStoreForSlug: restoreOauthFn,
        applyCoachModelPatch: applyCoachModelPatchFn,
        triggerSecretsReload: triggerSecretsReloadFn,
      },
    );

    expect(restoreOauthFn).toHaveBeenCalledWith("tester-70");
    // The coach is NOT pinned to codex without a credential — it stays on the
    // platform-key fallback until a later sync restores the subscription.
    expect(applyCoachModelPatchFn).not.toHaveBeenCalled();
    expect(triggerSecretsReloadFn).not.toHaveBeenCalled();
  });
});

describe("shared gateway — per-customer broker-token materialization", () => {
  const PRESERVE = { preserveAuthProfileStore: true };
  const baseDeps = (overrides: Record<string, unknown>) => ({
    isSharedGateway: () => true,
    isOperatorGateway: () => false,
    applyCoachModelPatch: vi.fn(async () => false),
    triggerSecretsReload: vi.fn(async () => {}),
    ...overrides,
  });

  it("platform (non-BYOK) customer: materializes the anthropic broker profile, PRESERVES the store, reloads", async () => {
    const applyByotStateFn = vi.fn(() => false);
    const materializeFn = vi.fn(() => true);
    const restoreOauthFn = vi.fn(async () => ({ restored: false, present: true }));
    const reloadFn = vi.fn(async () => {});

    await syncByotForCustomer(
      { byotActive: false, username: "tester-70", provisioning: { openclaw: { status: "complete" } } },
      baseDeps({
        applyByotState: applyByotStateFn,
        materializeAnthropicBroker: materializeFn,
        restoreOauthStoreForSlug: restoreOauthFn,
        triggerSecretsReload: reloadFn,
      }),
    );

    expect(materializeFn).toHaveBeenCalledWith("tester-70");
    expect(applyByotStateFn).toHaveBeenCalledWith("tester-70", null, undefined, PRESERVE);
    expect(restoreOauthFn).not.toHaveBeenCalled();
    expect(reloadFn).toHaveBeenCalledTimes(1);
  });

  it("anthropic BYOK: no local key (broker resolves per-owner), but the broker profile is still materialized", async () => {
    const applyByotStateFn = vi.fn(() => false);
    const materializeFn = vi.fn(() => true);

    await syncByotForCustomer(
      {
        byotActive: true,
        username: "tester-70",
        provisioning: { openclaw: { status: "complete" } },
        systemConfig: { byot: { provider: "anthropic" } },
      },
      baseDeps({ applyByotState: applyByotStateFn, materializeAnthropicBroker: materializeFn }),
    );

    expect(applyByotStateFn).toHaveBeenCalledWith("tester-70", null, undefined, PRESERVE);
    expect(materializeFn).toHaveBeenCalledWith("tester-70");
  });

  it("claude-cli BYOS on shared: suppressed — no OAuth restore, store purged, platform profile only", async () => {
    const applyByotStateFn = vi.fn(() => false);
    const materializeFn = vi.fn(() => true);
    const restoreOauthFn = vi.fn(async () => ({ restored: true, present: true }));
    const applyCoachModelPatchFn = vi.fn(async () => false);
    const reloadFn = vi.fn(async () => {});
    const logLines: string[] = [];

    await syncByotForCustomer(
      {
        byotActive: true,
        username: "tester-70",
        selectedTier: "personal",
        provisioning: { openclaw: { status: "complete" } },
        systemConfig: { byot: { provider: "claude-cli" } },
      },
      baseDeps({
        applyByotState: applyByotStateFn,
        materializeAnthropicBroker: materializeFn,
        restoreOauthStoreForSlug: restoreOauthFn,
        applyCoachModelPatch: applyCoachModelPatchFn,
        triggerSecretsReload: reloadFn,
        logFn: (m: string) => logLines.push(m),
      }),
    );

    // BYOSUB is single-trust-boundary-only: no OAuth credential may land on a
    // shared pod, and any lingering profile from the pre-gate era is purged.
    expect(restoreOauthFn).not.toHaveBeenCalled();
    expect(materializeFn).toHaveBeenCalledWith("tester-70");
    expect(applyByotStateFn).toHaveBeenCalledWith("tester-70", null, undefined, {
      preserveAuthProfileStore: false,
    });
    // no cohort model configured → coach stays on the pod default; never the byos model
    expect(applyCoachModelPatchFn).not.toHaveBeenCalled();
    expect(reloadFn).toHaveBeenCalledTimes(1);
    expect(logLines.join("\n")).toContain("byosub (claude-cli) suppressed on shared gateway");
  });

  it("codex BYOS on shared (paid plan): suppressed to the platform rail, config default model stands", async () => {
    const applyByotStateFn = vi.fn(() => false);
    const materializeFn = vi.fn(() => true);
    const restoreOauthFn = vi.fn(async () => ({ restored: true, present: true }));
    const applyCoachModelPatchFn = vi.fn(async () => true);
    const reloadFn = vi.fn(async () => {});

    await syncByotForCustomer(
      {
        byotActive: true,
        username: "tester-70",
        selectedTier: "personal",
        provisioning: { openclaw: { status: "complete" } },
        systemConfig: { byot: { provider: "openai-codex" } },
      },
      baseDeps({
        applyByotState: applyByotStateFn,
        materializeAnthropicBroker: materializeFn,
        restoreOauthStoreForSlug: restoreOauthFn,
        applyCoachModelPatch: applyCoachModelPatchFn,
        triggerSecretsReload: reloadFn,
      }),
    );

    expect(restoreOauthFn).not.toHaveBeenCalled();
    expect(materializeFn).toHaveBeenCalledWith("tester-70");
    // same models + budgets as any paying platform customer on shared — the
    // paid plan has no house pin, so no coach-model patch is forced.
    expect(applyCoachModelPatchFn).not.toHaveBeenCalled();
    expect(reloadFn).toHaveBeenCalledTimes(1);
  });
  it("grok (non-anthropic) BYOK: writes the custom-provider models.json (store preserved) + materializes the anthropic fallback", async () => {
    const applyByotStateFn = vi.fn(() => true);
    const materializeFn = vi.fn(() => false);

    await syncByotForCustomer(
      {
        byotActive: true,
        username: "tester-70",
        provisioning: { openclaw: { status: "complete" } },
        systemConfig: { byot: { provider: "grok", model: "grok-2" } },
      },
      baseDeps({ applyByotState: applyByotStateFn, materializeAnthropicBroker: materializeFn }),
    );

    expect(applyByotStateFn).toHaveBeenCalledWith(
      "tester-70",
      expect.objectContaining({ provider: "grok" }),
      undefined,
      PRESERVE,
    );
    expect(materializeFn).toHaveBeenCalledWith("tester-70");
  });
});

describe("operator gateway — runtime sync stays narrow", () => {
  it("restoreOauthStoreForSlug: materializes owner BYOS credentials on operator gateways", async () => {
    const openclawDir = fs.mkdtempSync(path.join(os.tmpdir(), "operator-byos-"));
    const fetchByosubCreds = vi.fn(async () => [
      {
        provider: "anthropic" as const,
        secretName: "byosub-uid-anthropic",
        credential: "sk-ant-oat01-operator-token",
      },
    ]);
    const r = await restoreOauthStoreForSlug("tester-70", {
      fetchByosubCreds,
      openclawDir,
      logFn: () => {},
    });
    expect(r).toEqual({ restored: true, present: true, providers: ["anthropic"] });
    expect(fetchByosubCreds).toHaveBeenCalledWith("octogee-tester-70-coach");

    const store = readAuthProfileStore(codexAgentDir(openclawDir, "octogee-tester-70-coach")) as {
      profiles: Record<string, { provider?: string; access?: string }>;
    };
    expect(store.profiles["anthropic:claude-cli"]).toMatchObject({
      provider: "claude-cli",
      access: "sk-ant-oat01-operator-token",
    });
  });

  it("syncByotForCustomer: restores OAuth credentials and patches the operator runtime model after the credential is present", async () => {
    const applyByotStateFn = vi.fn(() => true);
    const restoreOauthFn = vi.fn(async () => ({
      restored: true,
      present: true,
      providers: ["openai", "anthropic"] as const,
    }));
    const applyCoachModelPatchFn = vi.fn(async () => true);
    const applyOauthRuntimeModelAllowlistFn = vi.fn(async () => ({
      patched: true,
      changed: true,
      restartRequired: true,
    }));
    const requestGatewayRestartFn = vi.fn(async () => true);
    const triggerSecretsReloadFn = vi.fn(async () => {});

    await syncByotForCustomer(
      {
        byotActive: true,
        username: "tester-70",
        provisioning: { openclaw: { status: "complete" } },
        systemConfig: { byot: { provider: "openai-codex" } },
      },
      {
        isOperatorGateway: () => true,
        applyByotState: applyByotStateFn,
        restoreOauthStoreForSlug: restoreOauthFn,
        applyCoachModelPatch: applyCoachModelPatchFn,
        applyOauthRuntimeModelAllowlist: applyOauthRuntimeModelAllowlistFn,
        requestGatewayRestart: requestGatewayRestartFn,
        triggerSecretsReload: triggerSecretsReloadFn,
      },
    );

    expect(applyByotStateFn).not.toHaveBeenCalled();
    expect(restoreOauthFn).toHaveBeenCalledWith("tester-70");
    expect(applyOauthRuntimeModelAllowlistFn).toHaveBeenCalledWith(["openai", "anthropic"]);
    expect(applyCoachModelPatchFn).toHaveBeenCalledWith({
      slug: "tester-70",
      provider: "openai-codex",
      baseUrl: undefined,
      model: undefined,
    });
    expect(requestGatewayRestartFn).toHaveBeenCalledTimes(1);
    expect(triggerSecretsReloadFn).not.toHaveBeenCalled();
  });

  it("syncByotForCustomer: preserves an operator Codex danger-full-access sandbox through the full restore and coach patch cycle", async () => {
    const currentConfig = {
      agents: {
        list: [
          { id: "octogee-tester-70-coach", model: "anthropic/claude-haiku-4-5" },
        ],
      },
      plugins: {
        entries: {
          codex: {
            enabled: true,
            config: {
              appServer: {
                sandbox: "danger-full-access",
                approvalPolicy: "never",
              },
            },
          },
        },
      },
    };
    const patches: object[] = [];

    await syncByotForCustomer(
      {
        byotActive: true,
        username: "tester-70",
        provisioning: { openclaw: { status: "complete" } },
        systemConfig: { byot: { provider: "openai-codex" } },
      },
      {
        isOperatorGateway: () => true,
        applyByotState: vi.fn(() => true),
        restoreOauthStoreForSlug: vi.fn(async () => ({
          restored: true,
          present: true,
          providers: ["openai"] as const,
        })),
        applyOauthRuntimeModelAllowlist: (providers) =>
          applyOauthRuntimeModelAllowlist(providers, {
            applyConfigPatch: async (args) => {
              patches.push(args.buildPatch(currentConfig));
              return { mode: "rpc", attempts: 1 };
            },
          }),
        applyCoachModelPatch: (input) =>
          applyCoachModelPatch(input, {
            applyConfigPatch: async (args) => {
              patches.push(args.buildPatch(currentConfig));
              return { mode: "rpc", attempts: 1 };
            },
          }),
        triggerSecretsReload: vi.fn(async () => {}),
      },
    );

    expect(patches).toEqual([
      {
        agents: {
          defaults: {
            models: {
              "openai/gpt-5.5": { agentRuntime: { id: "codex" } },
            },
          },
        },
        plugins: {
          entries: {
            codex: {
              enabled: true,
              config: {
                appServer: {
                  sandbox: "danger-full-access",
                  approvalPolicy: "never",
                },
              },
            },
          },
        },
      },
      {
        agents: {
          list: [
            {
              id: "octogee-tester-70-coach",
              model: withFallback("openai/gpt-5.5"),
            },
          ],
          defaults: {
            models: {
              "openai/gpt-5.5": { agentRuntime: { id: "codex" } },
            },
          },
        },
      },
    ]);
  });

  it("anthropic BYOT cleanup still runs on operator broker-token gateways", async () => {
    const applyByotStateFn = vi.fn(() => true);
    const restoreOauthFn = vi.fn(async () => ({ restored: true, present: true }));
    const applyCoachModelPatchFn = vi.fn(async () => true);
    const triggerSecretsReloadFn = vi.fn(async () => {});

    await syncByotForCustomer(
      {
        byotActive: true,
        username: "tester-70",
        provisioning: { openclaw: { status: "complete" } },
        systemConfig: { byot: { provider: "anthropic" } },
      },
      {
        isOperatorGateway: () => true,
        usesLlmBrokerToken: () => true,
        applyByotState: applyByotStateFn,
        restoreOauthStoreForSlug: restoreOauthFn,
        applyCoachModelPatch: applyCoachModelPatchFn,
        triggerSecretsReload: triggerSecretsReloadFn,
      },
    );

    expect(applyByotStateFn).toHaveBeenCalledWith("tester-70", null);
    expect(restoreOauthFn).not.toHaveBeenCalled();
    expect(applyCoachModelPatchFn).not.toHaveBeenCalled();
    expect(triggerSecretsReloadFn).toHaveBeenCalledTimes(1);
  });
});

describe("applyAgentModelOverrides — per-agent model picks (PWA catalog picker)", () => {
  const CURRENT = {
    agents: {
      list: [
        { id: "octogee-tester-70-coach", name: "coach", model: "old", mmAccount: "a" },
        { id: "octogee-tester-70-proj-web-coach", model: "old" },
        { id: "octogee-zed-coach", model: "z/y" },
      ],
    },
  };

  it("patches each owned agent's full list; openrouter refs get a defaults.models allowlist entry", async () => {
    const calls: object[] = [];
    const paths: (string[] | undefined)[] = [];
    const r = await applyAgentModelOverrides(
      "tester-70",
      {
        "octogee-tester-70-coach": {
          primary: "platform-openrouter/z-ai/glm-5.2",
          fallbacks: ["anthropic/claude-haiku-4-5"],
        },
        "octogee-tester-70-proj-web-coach": {
          primary: "anthropic/claude-sonnet-4-6",
          fallbacks: [],
        },
      },
      { houseOnly: false },
      {
        applyConfigPatch: async (args) => {
          calls.push(args.buildPatch(CURRENT));
          paths.push(args.buildReplacePaths?.(CURRENT));
          return { mode: "rpc", attempts: 1 };
        },
        logFn: () => {},
      },
    );
    expect(r).toBe(true);
    expect(paths).toEqual([["agents.list"], ["agents.list"]]);
    expect(calls[0]).toEqual({
      agents: {
        defaults: { models: { "platform-openrouter/z-ai/glm-5.2": {} } },
        list: [
          {
            id: "octogee-tester-70-coach",
            name: "coach",
            model: {
              primary: "platform-openrouter/z-ai/glm-5.2",
              fallbacks: ["anthropic/claude-haiku-4-5"],
            },
            mmAccount: "a",
          },
          { id: "octogee-tester-70-proj-web-coach", model: "old" },
          { id: "octogee-zed-coach", model: "z/y" },
        ],
      },
    });
    expect(calls[1]).toEqual({
      agents: {
        list: [
          { id: "octogee-tester-70-coach", name: "coach", model: "old", mmAccount: "a" },
          {
            id: "octogee-tester-70-proj-web-coach",
            model: { primary: "anthropic/claude-sonnet-4-6", fallbacks: [] },
          },
          { id: "octogee-zed-coach", model: "z/y" },
        ],
      },
    });
  });

  it("ignores foreign agent ids (cross-tenant safety) and no-ops on empty input", async () => {
    const applyConfigPatchFn = vi.fn(async () => ({ mode: "rpc" as const, attempts: 1 }));
    const logs: string[] = [];
    const r = await applyAgentModelOverrides(
      "tester-70",
      { "octogee-zed-coach": { primary: "anthropic/claude-sonnet-4-6", fallbacks: [] } },
      { houseOnly: false },
      { applyConfigPatch: applyConfigPatchFn, logFn: (m) => logs.push(m) },
    );
    expect(r).toBe(false);
    expect(applyConfigPatchFn).not.toHaveBeenCalled();
    expect(logs.join("\n")).toContain("octogee-zed-coach");

    expect(
      await applyAgentModelOverrides("tester-70", undefined, { houseOnly: false }, {
        applyConfigPatch: applyConfigPatchFn,
        logFn: () => {},
      }),
    ).toBe(false);
  });

  it("defers all overrides on a house-only plan (free pins the house model)", async () => {
    const applyConfigPatchFn = vi.fn(async () => ({ mode: "rpc" as const, attempts: 1 }));
    const r = await applyAgentModelOverrides(
      "tester-70",
      { "octogee-tester-70-coach": { primary: "anthropic/claude-sonnet-4-6", fallbacks: [] } },
      { houseOnly: true },
      { applyConfigPatch: applyConfigPatchFn, logFn: () => {} },
    );
    expect(r).toBe(false);
    expect(applyConfigPatchFn).not.toHaveBeenCalled();
  });

  it("a failed patch on one agent does not abort the rest", async () => {
    const applyConfigPatchFn = vi
      .fn()
      .mockRejectedValueOnce(new Error("gateway busy"))
      .mockResolvedValueOnce({ mode: "rpc", attempts: 1 });
    const r = await applyAgentModelOverrides(
      "tester-70",
      {
        "octogee-tester-70-coach": { primary: "anthropic/claude-sonnet-4-6", fallbacks: [] },
        "octogee-tester-70-proj-web-coach": {
          primary: "anthropic/claude-haiku-4-5",
          fallbacks: [],
        },
      },
      { houseOnly: false },
      { applyConfigPatch: applyConfigPatchFn, logFn: () => {} },
    );
    expect(r).toBe(true);
    expect(applyConfigPatchFn).toHaveBeenCalledTimes(2);
  });
});

describe("syncByotForCustomer — agent-model overrides ride every class path", () => {
  it("standard gateway: overrides applied after the coach-model sync with the plan's houseOnly", async () => {
    const applyAgentModelOverridesFn = vi.fn(async () => true);
    const agentModels = {
      "octogee-tester-70-coach": {
        primary: "platform-openrouter/z-ai/glm-5.2",
        fallbacks: [] as string[],
      },
    };

    await syncByotForCustomer(
      {
        byotActive: false,
        username: "tester-70",
        provisioning: { openclaw: { status: "complete" } },
        selectedTier: "personal",
        systemConfig: { agentModels },
      },
      {
        isOperatorGateway: () => false,
        applyByotState: vi.fn(() => false),
        applyCoachModelPatch: vi.fn(async () => false),
        triggerSecretsReload: vi.fn(async () => {}),
        applyAgentModelOverrides: applyAgentModelOverridesFn,
      },
    );

    expect(applyAgentModelOverridesFn).toHaveBeenCalledWith("tester-70", agentModels, {
      houseOnly: false,
    });
  });

  it("shared gateway: a free-plan owner's overrides arrive houseOnly:true (deferred)", async () => {
    const applyAgentModelOverridesFn = vi.fn(async () => false);

    await syncByotForCustomer(
      {
        byotActive: false,
        username: "tester-70",
        provisioning: { openclaw: { status: "complete" } },
        selectedTier: "free",
        systemConfig: {
          agentModels: {
            "octogee-tester-70-coach": {
              primary: "anthropic/claude-sonnet-4-6",
              fallbacks: [] as string[],
            },
          },
        },
      },
      {
        isSharedGateway: () => true,
        isOperatorGateway: () => false,
        applyByotState: vi.fn(() => false),
        applyCoachModelPatch: vi.fn(async () => false),
        materializeAnthropicBroker: vi.fn(() => false),
        triggerSecretsReload: vi.fn(async () => {}),
        applyAgentModelOverrides: applyAgentModelOverridesFn,
      },
    );

    expect(applyAgentModelOverridesFn).toHaveBeenCalledWith(
      "tester-70",
      expect.objectContaining({ "octogee-tester-70-coach": expect.anything() }),
      { houseOnly: true },
    );
  });
});
