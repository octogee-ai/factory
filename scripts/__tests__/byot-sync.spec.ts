import { describe, it, test, expect, beforeEach, afterEach, vi } from "vitest";

const secretsReloadSpy = vi.fn(async () => ({ ok: true, warningCount: 0 }));
const closeSpy = vi.fn(async () => {});

vi.mock("../lib/gateway-rpc", () => ({
  OpenclawWireError: class OpenclawWireError extends Error {
    code: string;
    constructor(code: string, message: string) {
      super(message);
      this.code = code;
      this.name = "OpenclawWireError";
    }
  },
  createGatewayRpc: () => ({
    secretsReload: secretsReloadSpy,
    close: closeSpy,
    configGet: vi.fn(),
    configPatch: vi.fn(),
    channelsStatus: vi.fn(),
    isGatewayUp: vi.fn(async () => true),
  }),
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

import { deriveDesiredByotState, byosCoachConfigPatch } from "../lib/byot-sync.js";
import {
  triggerSecretsReload,
  restoreOauthStoreForSlug,
  applyCoachModelPatch,
  syncByotForCustomer,
  markerProviderForSlot,
} from "../lib/byot-sync-runtime";
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
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("calls gateway-rpc.secretsReload() and closes the client", async () => {
    secretsReloadSpy.mockResolvedValueOnce({ ok: true, warningCount: 0 });
    await triggerSecretsReload();
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
      fetchGlmByosub: async () => ({
        "octogee-tester-70-coach": { provider: "openai", secretName: "byosub-uid-openai" },
      }),
      fetchSecret: async () => codexBlob(),
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
      fetchGlmByosub: async () => ({
        "octogee-tester-70-coach": { provider: "openai", secretName: "byosub-uid-openai" },
      }),
      fetchSecret: async () => {
        throw new Error("transient Secret Manager failure");
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
      fetchGlmByosub: async () => ({}),
      fetchSecret: async () => "x",
      openclawDir: mk(),
    });
    expect(r.restored).toBe(false);
    expect(r.present).toBe(false);
  });

  it("never throws — a fetch failure is neither restored nor present (mount continues)", async () => {
    const r = await restoreOauthStoreForSlug("tester-70", {
      fetchGlmByosub: async () => {
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
      fetchGlmByosub: async () => ({
        "octogee-tester-70-coach": { provider: "openai", secretName: "byosub-uid-openai" } as const,
      }),
      fetchSecret: async () => codexBlob(),
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

describe("byosCoachConfigPatch — durable coach-model patch (#1001 core)", () => {
  const id = "octogee-tester-70-coach";
  it("null input / no-override providers → null (keep gateway default, no per-agent model)", () => {
    expect(byosCoachConfigPatch(null)).toBeNull();
    expect(byosCoachConfigPatch({ slug: "tester-70", provider: "anthropic" })).toBeNull();
  });

  it("openai-codex → coach model openai/gpt-5.5 + agentRuntime:codex registry pin", () => {
    expect(byosCoachConfigPatch({ slug: "tester-70", provider: "openai-codex" })).toEqual({
      agents: {
        list: [{ id, model: "openai/gpt-5.5" }],
        defaults: { models: { "openai/gpt-5.5": { agentRuntime: { id: "codex" } } } },
      },
    });
  });

  it("claude-cli (Claude subscription) → coach model Opus 4.8 + agentRuntime:claude-cli registry pin", () => {
    expect(byosCoachConfigPatch({ slug: "tester-70", provider: "claude-cli" })).toEqual({
      agents: {
        list: [{ id, model: "anthropic/claude-opus-4-8" }],
        defaults: {
          models: { "anthropic/claude-opus-4-8": { agentRuntime: { id: "claude-cli" } } },
        },
      },
    });
  });

  it("openai (api_key) → coach model only, NO agentRuntime pin", () => {
    expect(byosCoachConfigPatch({ slug: "tester-70", provider: "openai" })).toEqual({
      agents: { list: [{ id, model: "openai/gpt-5" }] },
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
    ).toEqual({ agents: { list: [{ id, model: "custom-tester-70/llama-3.1-70b" }] } });
  });
});

describe("applyCoachModelPatch — applies the durable patch, best-effort", () => {
  it("codex input → applies the codex patch once, returns true", async () => {
    const calls: object[] = [];
    const r = await applyCoachModelPatch(
      { slug: "tester-70", provider: "openai-codex" },
      {
        applyPatch: async (p) => {
          calls.push(p);
        },
      },
    );
    expect(r).toBe(true);
    expect(calls).toEqual([
      {
        agents: {
          list: [{ id: "octogee-tester-70-coach", model: "openai/gpt-5.5" }],
          defaults: { models: { "openai/gpt-5.5": { agentRuntime: { id: "codex" } } } },
        },
      },
    ]);
  });

  it("no-override / null → does NOT apply, returns false", async () => {
    const applyPatch = vi.fn(async () => {});
    expect(await applyCoachModelPatch(null, { applyPatch })).toBe(false);
    expect(
      await applyCoachModelPatch({ slug: "tester-70", provider: "anthropic" }, { applyPatch }),
    ).toBe(false);
    expect(applyPatch).not.toHaveBeenCalled();
  });

  it("never throws — a failed apply returns false (sync continues → retried next sync)", async () => {
    const r = await applyCoachModelPatch(
      { slug: "tester-70", provider: "openai-codex" },
      {
        applyPatch: async () => {
          throw new Error("config.patch hash-mismatch exhausted");
        },
        logFn: () => {},
      },
    );
    expect(r).toBe(false);
  });

  it("operator gateway: never applies the patch (operator owns openclaw.json on PVC)", async () => {
    const applyPatch = vi.fn(async () => {});
    const r = await applyCoachModelPatch(
      { slug: "tester-70", provider: "openai-codex" },
      { applyPatch, isOperatorGateway: () => true },
    );
    expect(r).toBe(false);
    expect(applyPatch).not.toHaveBeenCalled();
  });

  it("waits for the booting runtime: deadline-bounded retries, not a 3-shot budget (byot fires at pod boot before openclaw listens on :18789)", async () => {
    const opts: Array<Record<string, unknown>> = [];
    const r = await applyCoachModelPatch(
      { slug: "tester-70", provider: "openai-codex" },
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

describe("operator gateway — provisioner does not touch auth or openclaw.json", () => {
  it("restoreOauthStoreForSlug: returns {restored:false, present:false} without fetching", async () => {
    const fetchGlmByosub = vi.fn(async () => ({}));
    const fetchSecret = vi.fn(async () => "x");
    const r = await restoreOauthStoreForSlug("tester-70", {
      fetchGlmByosub,
      fetchSecret,
      openclawDir: fs.mkdtempSync(path.join(os.tmpdir(), "operator-skip-")),
      isOperatorGateway: () => true,
      logFn: () => {},
    });
    expect(r).toEqual({ restored: false, present: false });
    expect(fetchGlmByosub).not.toHaveBeenCalled();
    expect(fetchSecret).not.toHaveBeenCalled();
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
});
