import { describe, it, test, expect, beforeEach, afterEach, vi } from "vitest";

const secretsReloadSpy = vi.fn(async () => ({ ok: true, warningCount: 0 }));
const closeSpy = vi.fn(async () => {});

vi.mock("../lib/gateway-rpc", () => ({
  GatewayRpcError: class GatewayRpcError extends Error {
    code: string;
    constructor(code: string, message: string) {
      super(message);
      this.code = code;
      this.name = "GatewayRpcError";
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

import { deriveDesiredByotState } from "../lib/byot-sync.js";
import { triggerSecretsReload, restoreOauthStoreForSlug } from "../lib/byot-sync-runtime";
import { codexAuthJsonPath } from "../lib/byosub-restore.js";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const ON = {
  byotActive: true,
  username: "tester-70",
  provisioning: { openclaw: { status: "complete" } },
};

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

  it("materializes the per-agent codex-home for a mounted oauth customer (returns true)", async () => {
    const oc = mk();
    const ok = await restoreOauthStoreForSlug("tester-70", {
      fetchGlmByosub: async () => ({
        "octogee-tester-70-coach": { provider: "openai", secretName: "byosub-uid-openai" },
      }),
      fetchSecret: async () => '{"auth_mode":"chatgpt"}',
      openclawDir: oc,
    });
    expect(ok).toBe(true);
    expect(
      JSON.parse(fs.readFileSync(codexAuthJsonPath(oc, "octogee-tester-70-coach"), "utf-8"))
        .auth_mode,
    ).toBe("chatgpt");
    // Copilot #1: auth-profiles.json lands under the SAME agents base as
    // the restored codex-home (not a divergent AGENTS_DIR/OPENCLAW_AGENTS_DIR).
    const ap = path.join(oc, "agents", "octogee-tester-70-coach", "agent", "auth-profiles.json");
    const prof = JSON.parse(fs.readFileSync(ap, "utf-8"));
    expect(Object.values(prof.profiles)[0]).toMatchObject({
      type: "oauth",
      provider: "openai-codex",
    });
  });

  it("Copilot #2: a FAILED restore does NOT activate (no auth-profiles, routing unchanged)", async () => {
    const oc = mk();
    const ok = await restoreOauthStoreForSlug("tester-70", {
      fetchGlmByosub: async () => ({
        "octogee-tester-70-coach": { provider: "openai", secretName: "byosub-uid-openai" },
      }),
      fetchSecret: async () => {
        throw new Error("transient Secret Manager failure");
      },
      openclawDir: oc,
      logFn: () => {},
    });
    expect(ok).toBe(false); // gated on r.restored, not r.planned
    const ap = path.join(oc, "agents", "octogee-tester-70-coach", "agent", "auth-profiles.json");
    expect(fs.existsSync(ap)).toBe(false); // never flip routing without the cred on disk
  });

  it("returns false when this customer has no byosub ref (nothing to restore)", async () => {
    const ok = await restoreOauthStoreForSlug("tester-70", {
      fetchGlmByosub: async () => ({}),
      fetchSecret: async () => "x",
      openclawDir: mk(),
    });
    expect(ok).toBe(false);
  });

  it("never throws — a fetch failure returns false (mount continues)", async () => {
    const ok = await restoreOauthStoreForSlug("tester-70", {
      fetchGlmByosub: async () => {
        throw new Error("glmGateways read failed");
      },
      openclawDir: mk(),
      logFn: () => {},
    });
    expect(ok).toBe(false);
  });
});
