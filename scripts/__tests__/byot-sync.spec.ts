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

// Block ALL subprocess primitives so a regression that re-introduces ANY
// process boundary fails loudly (token would leak via argv).
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
} from "../lib/byot-sync-runtime";
import { codexAuthJsonPath } from "../lib/byosub-restore.js";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const ON = {
  byotActive: true,
  username: "tester-70",
  provisioning: { openclaw: { status: "complete" } },
};

// A valid codex CLI auth.json — byosub-restore now validate-before-writes,
// so an oauth-store materialization fixture must carry tokens.access_token
// (a placeholder blob would fail the item and never embed auth-profiles).
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
    // Copilot #1: auth-profiles.json lands under the SAME agents base as
    // the restored codex-home (not a divergent AGENTS_DIR/OPENCLAW_AGENTS_DIR).
    // Strengthened: it carries the EMBEDDED live OAuthCredential (envelope
    // v1, openai-codex:default, real access token) — not a routing stub.
    // applyByotState runs last and must NOT clobber this (oauth-skip guard).
    const ap = path.join(oc, "agents", "octogee-tester-70-coach", "agent", "auth-profiles.json");
    const prof = JSON.parse(fs.readFileSync(ap, "utf-8"));
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
    expect(r.restored).toBe(false); // gated on r.restored, not r.planned
    // present is false on a FAILED restore (failed≠skipped): no usable cred
    // on disk, so the re-mount must NOT treat BYOS as active.
    expect(r.present).toBe(false);
    const ap = path.join(oc, "agents", "octogee-tester-70-coach", "agent", "auth-profiles.json");
    expect(fs.existsSync(ap)).toBe(false); // never flip routing without the cred on disk
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

  // Regression guard for the coach-model clobber (task #22). On the
  // restore-customer RE-MOUNT of an already-provisioned BYOS customer, the
  // on-disk credential is healthy → byosub-restore conservatively SKIPS it
  // (openclaw owns + rotates it in place). That skip used to return
  // restored=false → byosActive=false → addCustomerToGateway clobbered the
  // coach model back to the anthropic platform default. `present` must be
  // TRUE on the skip so the re-mount keeps BYOS active and never clobbers.
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
    // First mount: cold start, writes the cred to disk.
    const first = await restoreOauthStoreForSlug("tester-70", opts);
    expect(first.restored).toBe(true);
    expect(first.present).toBe(true);
    // Second mount (restore-customer re-mount): cred already healthy on
    // disk → conservative skip. restored=false (nothing freshly written)
    // but present=true (the cred IS there — BYOS is active).
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
});
