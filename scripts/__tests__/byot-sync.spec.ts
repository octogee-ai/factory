import { describe, it, test, expect, beforeEach, afterEach, vi } from "vitest";

const { secretsReloadSpy, closeSpy, createGatewayRpcSpy } = vi.hoisted(() => {
  const secretsReloadSpy = vi.fn(async () => ({ ok: true, warningCount: 0 }));
  const closeSpy = vi.fn(async () => {});
  const createGatewayRpcSpy = vi.fn(() => ({
    secretsReload: secretsReloadSpy,
    close: closeSpy,
    configGet: vi.fn(),
    configPatch: vi.fn(),
    channelsStatus: vi.fn(),
    isGatewayUp: vi.fn(async () => true),
  }));
  return { secretsReloadSpy, closeSpy, createGatewayRpcSpy };
});

vi.mock("../lib/gateway-rpc", () => ({
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

vi.mock("../lib/internal-fetch", () => ({ internalFetch: vi.fn() }));

import { deriveDesiredByotState, byosCoachConfigPatch, coachFullAgentList } from "../lib/byot-sync.js";
import {
  triggerSecretsReload,
  restoreOauthStoreForSlug,
  brokerFetchByosubCred,
  applyCoachModelPatch,
  syncByotForCustomer,
  markerProviderForSlot,
} from "../lib/byot-sync-runtime";
import { internalFetch } from "../lib/internal-fetch.js";
import { codexAuthJsonPath, codexAgentDir } from "../lib/byosub-restore.js";
import { readAuthProfileStore } from "../lib/auth-profile-sqlite.js";
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

  it("free post-trial non-BYOK derives a Haiku coach-model patch without local BYOT materialization", () => {
    const desired = deriveDesiredByotState({
      ...ON,
      byotActive: false,
      tier: "free",
      selectedTier: "free",
      trialExpired: true,
    });
    expect(desired.enabled).toBe(false);
    expect(desired.input).toBeNull();
    expect(desired.coachModelInput).toEqual({
      slug: "tester-70",
      model: "anthropic/claude-haiku-4-5",
      source: "free-tier",
    });
  });

  it("non-BYOK trial coach keeps the template Sonnet default (no patch)", () => {
    const desired = deriveDesiredByotState({
      ...ON,
      byotActive: false,
      tier: "trial",
      selectedTier: "trial",
      trialExpired: false,
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

describe("markerProviderForSlot — byosub slot → PROVIDERS-registry oauth provider", () => {
  const agentId = "octogee-a-coach";
  it("anthropic slot → claude-cli; openai slot → openai-codex; absent → openai-codex", () => {
    expect(markerProviderForSlot({ [agentId]: { provider: "anthropic", secretName: "s" } }, agentId)).toBe(
      "claude-cli",
    );
    expect(markerProviderForSlot({ [agentId]: { provider: "openai", secretName: "s" } }, agentId)).toBe(
      "openai-codex",
    );
    expect(markerProviderForSlot(undefined, agentId)).toBe("openai-codex");
    expect(markerProviderForSlot({}, agentId)).toBe("openai-codex");
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
      fetchByosubCred: async () => ({
        provider: "openai",
        secretName: "byosub-uid-openai",
        credential: codexBlob(),
      }),
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

  it("Copilot #2: a FAILED restore does NOT activate (not restored, not present)", async () => {
    const oc = mk();
    const r = await restoreOauthStoreForSlug("tester-70", {
      fetchByosubCred: async () => {
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
      fetchByosubCred: async () => null,
      openclawDir: mk(),
    });
    expect(r.restored).toBe(false);
    expect(r.present).toBe(false);
  });

  it("never throws — a fetch failure is neither restored nor present (mount continues)", async () => {
    const r = await restoreOauthStoreForSlug("tester-70", {
      fetchByosubCred: async () => {
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
      fetchByosubCred: async () => ({
        provider: "openai",
        secretName: "byosub-uid-openai",
        credential: codexBlob(),
      }),
      openclawDir: oc,
      logFn: () => {},
    };
    
    const first = await restoreOauthStoreForSlug("tester-70", opts);
    expect(first.restored).toBe(true);
    expect(first.present).toBe(true);

const second = await restoreOauthStoreForSlug("tester-70", opts);
    expect(second.restored).toBe(false);
    expect(second.present).toBe(true);
  });
});

describe("brokerFetchByosubCred — gateway-side broker client (no silent failures)", () => {
  beforeEach(() => vi.mocked(internalFetch).mockReset());

  it("returns the materialized cred on 200", async () => {
    vi.mocked(internalFetch).mockResolvedValue(
      new Response(
        JSON.stringify({
          provider: "anthropic",
          secretName: "byosub-uid-anthropic",
          credential: "tok",
        }),
        { status: 200 },
      ),
    );
    expect(await brokerFetchByosubCred("octogee-tester5-coach")).toEqual({
      provider: "anthropic",
      secretName: "byosub-uid-anthropic",
      credential: "tok",
    });
  });

  it("returns null on 404 (no byosub ref for this agent — nothing to restore)", async () => {
    vi.mocked(internalFetch).mockResolvedValue(new Response("{}", { status: 404 }));
    expect(await brokerFetchByosubCred("octogee-tester5-coach")).toBeNull();
  });

  it("throws on a non-ok, non-404 status (fail loud, never a silent skip)", async () => {
    vi.mocked(internalFetch).mockResolvedValue(new Response("boom", { status: 500 }));
    await expect(brokerFetchByosubCred("octogee-tester5-coach")).rejects.toThrow(/500/);
  });

  it("throws on a malformed broker response (never a half-materialized cred)", async () => {
    vi.mocked(internalFetch).mockResolvedValue(
      new Response(JSON.stringify({ provider: "anthropic" }), { status: 200 }),
    );
    await expect(brokerFetchByosubCred("octogee-tester5-coach")).rejects.toThrow(/malformed/);
  });
});

// Every BYOK coach model is a primary+fallback chain to the cheap platform
// (haiku) baseline (B6).
const withFallback = (primary: string) => ({
  primary,
  fallbacks: ["anthropic/claude-haiku-4-5"],
});

describe("byosCoachConfigPatch — durable coach-model patch (#1001 core)", () => {
  const id = "octogee-tester-70-coach";
  it("null input / no-override providers → null (keep gateway default, no per-agent model)", () => {
    expect(byosCoachConfigPatch(null)).toBeNull();
    expect(byosCoachConfigPatch({ slug: "tester-70", provider: "anthropic" })).toBeNull();
  });

  it("free-tier platform baseline → Haiku primary with no BYOK credential profile", () => {
    expect(
      byosCoachConfigPatch({
        slug: "tester-70",
        model: "anthropic/claude-haiku-4-5",
        source: "free-tier",
      }),
    ).toEqual({
      agents: { list: [{ id, model: { primary: "anthropic/claude-haiku-4-5", fallbacks: [] } }] },
    });
  });

  it("openai-codex → coach model + agentRuntime:codex + enables the codex plugin with a SAFE (non-YOLO) sandbox so it runs on a standard shared gateway", () => {
    expect(byosCoachConfigPatch({ slug: "tester-70", provider: "openai-codex" })).toEqual({
      agents: {
        list: [{ id, model: withFallback("openai/gpt-5.5") }],
        defaults: { models: { "openai/gpt-5.5": { agentRuntime: { id: "codex" } } } },
      },
      plugins: {
        entries: {
          codex: {
            enabled: true,
            // workspace-write + never = autonomous but sandboxed. NOT the
            // operator-only danger-full-access YOLO (apply-operator-codex-sandbox.mjs).
            config: { appServer: { sandbox: "workspace-write", approvalPolicy: "never" } },
          },
        },
      },
    });
  });

  it("claude-cli (Claude subscription) → native claude-cli/claude-opus-4-8 + empty allowlist entry (prefix selects the runtime; no agentRuntime remap)", () => {
    expect(byosCoachConfigPatch({ slug: "tester-70", provider: "claude-cli" })).toEqual({
      agents: {
        list: [{ id, model: withFallback("claude-cli/claude-opus-4-8") }],
        defaults: {
          models: { "claude-cli/claude-opus-4-8": {} },
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
        { id: "octogee-router", name: "router" },
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
            { id: "octogee-router", name: "router" },
            { id: "octogee-tester-70-coach", name: "coach", model: withFallback("openai/gpt-5"), mmAccount: "a" },
            { id: "octogee-zed-coach", model: "z/y" },
          ],
        },
      },
    ]);
  });

  it("shell-runtime BYOS providers (codex / claude-cli) patch the full list + defaults/plugins", async () => {
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
            { id: "octogee-router", name: "router" },
            { id: "octogee-tester-70-coach", name: "coach", model: withFallback("openai/gpt-5.5"), mmAccount: "a" },
            { id: "octogee-zed-coach", model: "z/y" },
          ],
          defaults: { models: { "openai/gpt-5.5": { agentRuntime: { id: "codex" } } } },
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
            { id: "octogee-router", name: "router" },
            { id: "octogee-tester-70-coach", name: "coach", model: withFallback("claude-cli/claude-opus-4-8"), mmAccount: "a" },
            { id: "octogee-zed-coach", model: "z/y" },
          ],
          defaults: { models: { "claude-cli/claude-opus-4-8": {} } },
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

  it("operator gateway: never applies the patch (operator owns openclaw.json on PVC)", async () => {
    let calls = 0;
    const r = await applyCoachModelPatch(
      { slug: "tester-70", provider: "openai-codex" },
      {
        applyConfigPatch: async () => { calls += 1; return { mode: "rpc", attempts: 1 }; },
        isOperatorGateway: () => true,
      },
    );
    expect(r).toBe(false);
    expect(calls).toBe(0);
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

describe("standard gateway — BYOS materialization", () => {
  it("free post-trial non-BYOK customer removes local BYOT state, patches Haiku, and reloads", async () => {
    const applyByotStateFn = vi.fn(() => false);
    const restoreOauthFn = vi.fn(async () => ({ restored: true, present: true }));
    const applyCoachModelPatchFn = vi.fn(async () => true);
    const triggerSecretsReloadFn = vi.fn(async () => {});

    await syncByotForCustomer(
      {
        byotActive: false,
        username: "tester-70",
        provisioning: { openclaw: { status: "complete" } },
        tier: "free",
        selectedTier: "free",
        trialExpired: true,
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
      model: "anthropic/claude-haiku-4-5",
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
        tier: "trial",
        selectedTier: "trial",
        trialExpired: false,
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
        triggerSecretsReload: triggerSecretsReloadFn,
      },
    );

    expect(applyByotStateFn).toHaveBeenCalledWith("tester-70", null);
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

describe("operator gateway — runtime sync stays narrow", () => {
  it("restoreOauthStoreForSlug: returns {restored:false, present:false} without fetching", async () => {
    const fetchByosubCred = vi.fn(async () => null);
    const r = await restoreOauthStoreForSlug("tester-70", {
      fetchByosubCred,
      openclawDir: fs.mkdtempSync(path.join(os.tmpdir(), "operator-skip-")),
      isOperatorGateway: () => true,
      logFn: () => {},
    });
    expect(r).toEqual({ restored: false, present: false });
    expect(fetchByosubCred).not.toHaveBeenCalled();
  });

  it("syncByotForCustomer: no internal call fires — applyByotState, restore, patch, reload all skipped", async () => {
    const applyByotStateFn = vi.fn(() => true);
    const restoreOauthFn = vi.fn(async () => ({ restored: true, present: true }));
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
        isOperatorGateway: () => true,
        applyByotState: applyByotStateFn,
        restoreOauthStoreForSlug: restoreOauthFn,
        applyCoachModelPatch: applyCoachModelPatchFn,
        triggerSecretsReload: triggerSecretsReloadFn,
      },
    );

    expect(applyByotStateFn).not.toHaveBeenCalled();
    expect(restoreOauthFn).not.toHaveBeenCalled();
    expect(applyCoachModelPatchFn).not.toHaveBeenCalled();
    expect(triggerSecretsReloadFn).not.toHaveBeenCalled();
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
