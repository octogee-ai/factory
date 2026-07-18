import { describe, it, expect, afterEach, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  restoreByosubCredentials,
  agentIdsFromConfig,
  codexHomeDir,
  codexAuthJsonPath,
  codexStagingHomeDir,
  codexStagingAuthJsonPath,
  codexAgentDir,
  codexAuthStatePath,
  shouldRestoreCodexCredential,
  isSafeAgentId,
  readCodexAuthStateText,
} from "./byosub-restore.js";
import * as authProfileSqlite from "./auth-profile-sqlite.js";
const {
  readAuthProfileStore,
  writeAuthProfileStore,
  resolveAuthDbPath,
} = authProfileSqlite;
import { DatabaseSync } from "node:sqlite";
import { OPENAI_CODEX_DEFAULT_PROFILE_ID } from "./model-credential-materializer.js";

const tmpDirs: string[] = [];
function mkTmp(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "byosub-"));
  tmpDirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

const OC = "/home/node/.openclaw";
const codexAuth = (agentId: string) =>
  `${OC}/agents/${agentId}/agent/codex-home/auth.json`;
const jwt = (claims: Record<string, unknown>) =>
  "e30." + Buffer.from(JSON.stringify(claims)).toString("base64url") + ".s";
const codexBlob = () =>
  JSON.stringify({
    auth_mode: "chatgpt",
    OPENAI_API_KEY: null,
    tokens: {
      id_token: jwt({
        email: "u@example.com",
        "https://api.openai.com/auth": { chatgpt_plan_type: "plus" },
      }),
      access_token: "acc-1",
      refresh_token: "ref-1",
      account_id: "acct-1",
    },
    last_refresh: "2026-05-18T00:11:06Z",
  });
const apReadFor = (oc: string, agentId: string): unknown =>
  readAuthProfileStore(codexAgentDir(oc, agentId));

describe("isSafeAgentId (shared path-safety boundary)", () => {
  it("accepts real coach agent ids", () => {
    expect(isSafeAgentId("octogee-smile-wring-011b-coach")).toBe(true);
    expect(isSafeAgentId("octogee-a-coach")).toBe(true);
  });
  it("rejects traversal / unsafe / oversized / non-string ids", () => {
    expect(isSafeAgentId("../../etc/passwd")).toBe(false);
    expect(isSafeAgentId("octogee/../x")).toBe(false);
    expect(isSafeAgentId("Octogee-A-Coach")).toBe(false);
    expect(isSafeAgentId("")).toBe(false);
    expect(isSafeAgentId("a".repeat(65))).toBe(false);
    expect(isSafeAgentId(undefined as unknown as string)).toBe(false);
    expect(isSafeAgentId(123 as unknown as string)).toBe(false);
  });
});

describe("codexHomeDir / codexAuthJsonPath (shared codex-home path atom)", () => {
  it("composes the per-agent codex-home — the C1a/A/B invariant path", () => {
    expect(codexHomeDir(OC, "octogee-ceckert-coach")).toBe(
      "/home/node/.openclaw/agents/octogee-ceckert-coach/agent/codex-home",
    );
  });

  it("auth.json sits directly in the codex-home dir", () => {
    expect(codexAuthJsonPath(OC, "octogee-a-coach")).toBe(
      codexAuth("octogee-a-coach"),
    );
  });

  it("staging codex-home is a sibling of the live one — never the same path", () => {
    const live = codexHomeDir(OC, "octogee-a-coach");
    const staging = codexStagingHomeDir(OC, "octogee-a-coach");
    expect(staging).not.toBe(live);
    expect(staging.startsWith(`${OC}/agents/octogee-a-coach/agent/`)).toBe(true);
    expect(codexStagingAuthJsonPath(OC, "octogee-a-coach")).toBe(
      `${staging}/auth.json`,
    );
  });

  it("codexAuthStatePath + resolveAuthDbPath = openclaw paths, siblings under agentDir (R8 reader/writer no-drift)", () => {
    expect(codexAgentDir(OC, "octogee-a-coach")).toBe(
      "/home/node/.openclaw/agents/octogee-a-coach/agent",
    );
    expect(codexAuthStatePath(OC, "octogee-a-coach")).toBe(
      "/home/node/.openclaw/agents/octogee-a-coach/agent/auth-state.json",
    );

    expect(path.dirname(codexAuthStatePath(OC, "octogee-a-coach"))).toBe(
      codexAgentDir(OC, "octogee-a-coach"),
    );
    expect(path.dirname(codexHomeDir(OC, "octogee-a-coach"))).toBe(
      codexAgentDir(OC, "octogee-a-coach"),
    );

    // auth-profiles moved to openclaw-agent.sqlite in OC v2026.6+ (PR #89102).
    // The DB sits as a sibling of auth-state.json, both under agentDir.
    expect(resolveAuthDbPath(codexAgentDir(OC, "octogee-a-coach"))).toBe(
      "/home/node/.openclaw/agents/octogee-a-coach/agent/openclaw-agent.sqlite",
    );
    expect(path.dirname(resolveAuthDbPath(codexAgentDir(OC, "octogee-a-coach")))).toBe(
      path.dirname(codexAuthStatePath(OC, "octogee-a-coach")),
    );
  });

});

describe("shouldRestoreCodexCredential — conservative-restore keystone", () => {
  const P = OPENAI_CODEX_DEFAULT_PROFILE_ID;
  const NOW = 1_780_000_000_000;
  const authPermanent = JSON.stringify({
    version: 1,
    usageStats: { [P]: { disabledReason: "auth_permanent", disabledUntil: NOW + 600_000 } },
  });

  it("cold start (no on-disk auth-profiles.json) → write — nothing healthy to clobber", () => {
    expect(
      shouldRestoreCodexCredential({
        usableCodexProfilePresent: false,
        authStateText: null,
        profileId: P,
        now: NOW,
      }),
    ).toBe("write");
    
    expect(
      shouldRestoreCodexCredential({
        usableCodexProfilePresent: false,
        authStateText: authPermanent,
        profileId: P,
        now: NOW,
      }),
    ).toBe("write");
  });

  it("steady state (healthy on-disk cred, no auth_permanent) → SKIP — never clobber openclaw's rotated token", () => {
    expect(
      shouldRestoreCodexCredential({
        usableCodexProfilePresent: true,
        authStateText: null,
        profileId: P,
        now: NOW,
      }),
    ).toBe("skip");
    expect(
      shouldRestoreCodexCredential({
        usableCodexProfilePresent: true,
        authStateText: JSON.stringify({ version: 1, usageStats: { [P]: { errorCount: 0 } } }),
        profileId: P,
        now: NOW,
      }),
    ).toBe("skip");
  });

  it("healthy SQLite credential with missing CODEX_HOME → materialize without replacing the rotated token", () => {
    expect(
      shouldRestoreCodexCredential({
        usableCodexProfilePresent: true,
        authStateText: null,
        profileId: P,
        now: NOW,
        targetPathPresent: false,
      }),
    ).toBe("materialize");
  });

  it("recovery (on-disk cred present but openclaw flagged auth_permanent) → write — replace the dead cred", () => {
    expect(
      shouldRestoreCodexCredential({
        usableCodexProfilePresent: true,
        authStateText: authPermanent,
        profileId: P,
        now: NOW,
      }),
    ).toBe("write");
  });

  it("an elapsed auth_permanent window is healthy again → SKIP (openclaw will retry; don't clobber)", () => {
    expect(
      shouldRestoreCodexCredential({
        usableCodexProfilePresent: true,
        authStateText: JSON.stringify({
          version: 1,
          usageStats: { [P]: { disabledReason: "auth_permanent", disabledUntil: NOW - 1 } },
        }),
        profileId: P,
        now: NOW,
      }),
    ).toBe("skip");
  });
});

describe("restoreByosubCredentials", () => {
  it("anthropic → materializes a claude-cli OAuth profile into the SQLite store, no auth.json file", async () => {
    const oc = mkTmp();
    const home = mkTmp();
    const agentId = "octogee-a-coach";
    const ssoCredential = JSON.stringify({
      claudeAiOauth: {
        accessToken: "claude-access-1",
        refreshToken: "claude-refresh-1",
        expiresAt: Date.now() + 24 * 60 * 60 * 1000,
        subscriptionType: "max",
      },
    });
    const item = {
      agentId,
      provider: "anthropic" as const,
      secretName: "byosub-a-anthropic",
      openclawDir: oc,
    };
    const r = await restoreByosubCredentials({
      plan: [item],
      fetchSecret: async () => ssoCredential,
      claudeCliNativeHomeDir: home,
    });
    expect(r).toEqual({ restored: 1, failed: 0, skipped: 0 });
    // No codex-home auth.json — claude-cli uses the native Claude credential file.
    expect(
      fs.existsSync(path.join(oc, "agents", agentId, "agent", "codex-home", "auth.json")),
    ).toBe(false);
    const nativeCredentialPath = path.join(home, ".claude", ".credentials.json");
    expect(JSON.parse(fs.readFileSync(nativeCredentialPath, "utf-8"))).toEqual(
      JSON.parse(ssoCredential),
    );
    expect(fs.statSync(path.dirname(nativeCredentialPath)).mode & 0o777).toBe(0o700);
    expect(fs.statSync(nativeCredentialPath).mode & 0o777).toBe(0o600);
    const store = apReadFor(oc, agentId) as {
      version: number;
      profiles: Record<string, { type: string; provider: string; access: string }>;
    };
    expect(store.version).toBe(1);
    expect(store.profiles["anthropic:claude-cli"]).toMatchObject({
      type: "oauth",
      provider: "claude-cli",
      access: "claude-access-1",
    });
  });

  it("anthropic SSO payload already expired → fails restore instead of promoting a dead profile", async () => {
    const oc = mkTmp();
    const home = mkTmp();
    const agentId = "octogee-a-coach";
    const item = {
      agentId,
      provider: "anthropic" as const,
      secretName: "byosub-a-anthropic",
      openclawDir: oc,
    };
    const r = await restoreByosubCredentials({
      plan: [item],
      fetchSecret: async () =>
        JSON.stringify({
          claudeAiOauth: {
            accessToken: "claude-access-1",
            refreshToken: "claude-refresh-1",
            expiresAt: Date.now() - 60_000,
          },
        }),
      claudeCliNativeHomeDir: home,
    });
    expect(r).toEqual({ restored: 0, failed: 1, skipped: 0 });
    expect(apReadFor(oc, agentId)).toBeNull();
    expect(fs.existsSync(path.join(home, ".claude", ".credentials.json"))).toBe(false);
  });

  it("anthropic setup-token restores the agent profile without claiming native Claude CLI continuity", async () => {
    const oc = mkTmp();
    const home = mkTmp();
    const agentId = "octogee-a-coach";
    const r = await restoreByosubCredentials({
      plan: [
        {
          agentId,
          provider: "anthropic" as const,
          secretName: "byosub-a-anthropic",
          openclawDir: oc,
        },
      ],
      fetchSecret: async () => "sk-ant-oat01-livetoken",
      claudeCliNativeHomeDir: home,
    });
    expect(r).toEqual({ restored: 1, failed: 0, skipped: 0 });
    expect(fs.existsSync(path.join(home, ".claude", ".credentials.json"))).toBe(false);
    const store = apReadFor(oc, agentId) as {
      profiles: Record<string, { access: string }>;
    };
    expect(store.profiles["anthropic:claude-cli"].access).toBe("sk-ant-oat01-livetoken");
  });

  it("anthropic without native restore keeps the store-only setup-token path", async () => {
    const oc = mkTmp();
    const agentId = "octogee-a-coach";
    const r = await restoreByosubCredentials({
      plan: [
        {
          agentId,
          provider: "anthropic" as const,
          secretName: "byosub-a-anthropic",
          openclawDir: oc,
        },
      ],
      fetchSecret: async () => "sk-ant-oat01-livetoken",
    });
    expect(r).toEqual({ restored: 1, failed: 0, skipped: 0 });
    const store = apReadFor(oc, agentId) as {
      profiles: Record<string, { access: string }>;
    };
    expect(store.profiles["anthropic:claude-cli"].access).toBe("sk-ant-oat01-livetoken");
  });

  it("atomically writes auth.json (0600) into the agent codex-home, creating dirs", async () => {
    const oc = mkTmp();
    const item = {
      agentId: "octogee-a-coach",
      provider: "openai" as const,
      secretName: "byosub-a-openai",
      targetPath: path.join(oc, "agents", "octogee-a-coach", "agent", "codex-home", "auth.json"),
      openclawDir: oc,
    };
    const r = await restoreByosubCredentials({
      plan: [item],
      fetchSecret: async () => codexBlob(),
    });
    expect(r).toEqual({ restored: 1, failed: 0, skipped: 0 });
    expect(fs.existsSync(item.targetPath)).toBe(true);
    expect(JSON.parse(fs.readFileSync(item.targetPath, "utf-8")).auth_mode).toBe("chatgpt");
    expect(fs.statSync(path.dirname(item.targetPath)).mode & 0o777).toBe(0o700);
    expect(fs.statSync(item.targetPath).mode & 0o777).toBe(0o600);
    expect(fs.existsSync(item.targetPath + ".tmp")).toBe(false);

    const store = apReadFor(oc, "octogee-a-coach") as {
      version: number;
      profiles: Record<string, unknown>;
    };
    expect(store).not.toBeNull();
    expect(store.version).toBe(1);
    expect(store.profiles["openai-codex:default"]).toMatchObject({
      type: "oauth",
      provider: "openai-codex",
      access: "acc-1",
      refresh: "ref-1",
      expires: 0,
      accountId: "acct-1",
      chatgptPlanType: "plus",
      email: "u@example.com",
      copyToAgents: true,
    });
  });

  it("validate-before-write: an unmappable blob fails the item — no codex-home, no auth-profiles (never half-flip routing)", async () => {
    const oc = mkTmp();
    const item = {
      agentId: "octogee-a-coach",
      provider: "openai" as const,
      secretName: "byosub-a-openai",
      targetPath: path.join(oc, "agents", "octogee-a-coach", "agent", "codex-home", "auth.json"),
      openclawDir: oc,
    };
    const logs: string[] = [];
    const r = await restoreByosubCredentials({
      plan: [item],
      
      fetchSecret: async () => '{"auth_mode":"chatgpt","tokens":{"refresh_token":"rt"}}',
      logFn: (m) => logs.push(m),
    });
    expect(r).toEqual({ restored: 0, failed: 1, skipped: 0 });
    expect(fs.existsSync(item.targetPath)).toBe(false);
    expect(fs.existsSync(item.targetPath + ".tmp")).toBe(false);
    expect(apReadFor(oc, "octogee-a-coach")).toBeNull();
    expect(logs.join("\n")).toMatch(/octogee-a-coach|access_token/);
  });

  it("cross-pair atomicity (Copilot #989): a SQLite write failure on auth-profiles aborts BEFORE codex-home is promoted — no half-promoted pair", async () => {
    const oc = mkTmp();
    const agentId = "octogee-a-coach";
    const item = {
      agentId,
      provider: "openai" as const,
      secretName: "byosub-a-openai",
      targetPath: path.join(oc, "agents", agentId, "agent", "codex-home", "auth.json"),
      openclawDir: oc,
    };

    // Spy on the SQLite write so it throws — isolates the failure to
    // step 3 of the restore (after secret fetch + codex-home tmp write,
    // before codex-home rename). Replicates the Copilot #989 invariant:
    // a write-step failure must not leave codex-home half-promoted.
    const writeSpy = vi
      .spyOn(authProfileSqlite, "writeAuthProfileStore")
      .mockImplementation(() => {
        throw new Error("simulated SQLite write failure");
      });

    const logs: string[] = [];
    const r = await restoreByosubCredentials({
      plan: [item],
      fetchSecret: async () => codexBlob(),
      logFn: (m) => logs.push(m),
    });
    expect(r).toEqual({ restored: 0, failed: 1, skipped: 0 });

    expect(writeSpy).toHaveBeenCalledTimes(1);
    expect(fs.existsSync(item.targetPath)).toBe(false);
    expect(fs.existsSync(item.targetPath + ".tmp")).toBe(false);

    const agentDir = codexAgentDir(oc, agentId);
    expect(fs.existsSync(resolveAuthDbPath(agentDir))).toBe(false);
    expect(logs.join("\n")).toMatch(/octogee-a-coach/);
    writeSpy.mockRestore();
  });

  it("isolates per-item failure: one bad fetch does not abort the others; never throws", async () => {
    const oc = mkTmp();
    const mk = (a: string, s: string) => ({
      agentId: a,
      provider: "openai" as const,
      secretName: s,
      targetPath: path.join(oc, "agents", a, "agent", "codex-home", "auth.json"),
      openclawDir: oc,
    });
    const logs: string[] = [];
    const r = await restoreByosubCredentials({
      plan: [mk("octogee-a-coach", "ok"), mk("octogee-b-coach", "boom")],
      fetchSecret: async (s) => {
        if (s === "boom") throw new Error("secret access denied");
        return codexBlob();
      },
      logFn: (m) => logs.push(m),
    });
    expect(r).toEqual({ restored: 1, failed: 1, skipped: 0 });
    expect(fs.existsSync(mk("octogee-a-coach", "ok").targetPath)).toBe(true);
    expect(fs.existsSync(mk("octogee-b-coach", "boom").targetPath)).toBe(false);
    expect(logs.join("\n")).toMatch(/octogee-b-coach|secret access denied/);
  });

  it("restores Codex when SQLite contains only platform broker profiles, preserving every broker profile", async () => {
    const oc = mkTmp();
    const agentId = "octogee-a-coach";
    const agentDir = path.join(oc, "agents", agentId, "agent");
    const targetPath = path.join(agentDir, "codex-home", "auth.json");
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.writeFileSync(
      targetPath,
      JSON.stringify({
        auth_mode: "chatgpt",
        tokens: { access_token: "stale-on-disk" },
      }),
    );

    const brokerProfiles = {
      "anthropic:default": {
        type: "api_key",
        provider: "anthropic",
        keyRef: {
          source: "exec",
          provider: "gcp-secret-manager",
          id: `agent-model-token-${agentId}`,
        },
      },
      "platform-openrouter:default": {
        type: "api_key",
        provider: "platform-openrouter",
        keyRef: {
          source: "exec",
          provider: "gcp-secret-manager",
          id: `agent-model-token-openrouter-${agentId}`,
        },
      },
      "platform-openai:default": {
        type: "api_key",
        provider: "platform-openai",
        keyRef: {
          source: "exec",
          provider: "gcp-secret-manager",
          id: `agent-model-token-openai-${agentId}`,
        },
      },
    };
    writeAuthProfileStore(agentDir, { version: 1, profiles: brokerProfiles });

    let fetched = false;
    const r = await restoreByosubCredentials({
      plan: [
        {
          agentId,
          provider: "openai",
          secretName: "byosub-a-openai",
          targetPath,
          openclawDir: oc,
        },
      ],
      fetchSecret: async () => {
        fetched = true;
        return codexBlob();
      },
    });

    expect(r).toEqual({ restored: 1, failed: 0, skipped: 0 });
    expect(fetched).toBe(true);
    expect(JSON.parse(fs.readFileSync(targetPath, "utf8")).tokens.access_token).toBe("acc-1");
    const store = readAuthProfileStore(agentDir) as {
      profiles: Record<string, unknown>;
    };
    expect(store.profiles).toMatchObject(brokerProfiles);
    expect(store.profiles[OPENAI_CODEX_DEFAULT_PROFILE_ID]).toMatchObject({
      type: "oauth",
      provider: "openai-codex",
      access: "acc-1",
      refresh: "ref-1",
    });
  });

  it("KEYSTONE: a healthy on-disk Codex OAuth profile is NOT clobbered — skip, no SM read (the refresh_token_reused root cause)", async () => {
    const oc = mkTmp();
    const agentId = "octogee-a-coach";
    const agentDir = path.join(oc, "agents", agentId, "agent");
    fs.mkdirSync(agentDir, { recursive: true });

    const liveCred = {
      version: 1,
      profiles: {
        [OPENAI_CODEX_DEFAULT_PROFILE_ID]: {
          type: "oauth",
          provider: "openai-codex",
          access: "live",
          refresh: "rotated-refresh",
          expires: Date.now() + 3_600_000,
          copyToAgents: true,
        },
      },
    };
    writeAuthProfileStore(agentDir, liveCred);
    const targetPath = path.join(agentDir, "codex-home", "auth.json");
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.writeFileSync(targetPath, JSON.stringify({ auth_mode: "chatgpt", tokens: { access_token: "live" } }));

    let fetched = false;
    const logs: string[] = [];
    const r = await restoreByosubCredentials({
      plan: [
        {
          agentId,
          provider: "openai" as const,
          secretName: "byosub-a-openai",
          targetPath,
          openclawDir: oc,
        },
      ],
      fetchSecret: async () => {
        fetched = true;
        return codexBlob();
      },
      logFn: (m) => logs.push(m),
    });
    expect(r).toEqual({ restored: 0, failed: 0, skipped: 1 });
    expect(fetched).toBe(false);

    expect(readAuthProfileStore(agentDir)).toEqual(liveCred);
    expect(JSON.parse(fs.readFileSync(targetPath, "utf-8")).tokens.access_token).toBe("live");
    expect(logs.join("\n")).toMatch(/octogee-a-coach|skip|conservative/i);
  });

  it("materializes missing Codex auth.json from the healthy SQLite credential without fetching or replacing it", async () => {
    const oc = mkTmp();
    const agentId = "octogee-a-coach";
    const agentDir = path.join(oc, "agents", agentId, "agent");
    fs.mkdirSync(agentDir, { recursive: true });
    const liveCred = {
      version: 1,
      profiles: {
        "platform-openai:default": {
          type: "api_key",
          provider: "platform-openai",
          keyRef: {
            source: "exec",
            provider: "gcp-secret-manager",
            id: `agent-model-token-openai-${agentId}`,
          },
        },
        [OPENAI_CODEX_DEFAULT_PROFILE_ID]: {
          type: "oauth",
          provider: "openai-codex",
          access: "live",
          refresh: "rotated-refresh",
          expires: Date.now() + 3_600_000,
          copyToAgents: true,
        },
      },
    };
    writeAuthProfileStore(agentDir, liveCred);

    const targetPath = path.join(agentDir, "codex-home", "auth.json");
    let fetched = false;
    const r = await restoreByosubCredentials({
      plan: [
        {
          agentId,
          provider: "openai" as const,
          secretName: "byosub-a-openai",
          targetPath,
          openclawDir: oc,
        },
      ],
      fetchSecret: async () => {
        fetched = true;
        return codexBlob();
      },
    });

    expect(r).toEqual({ restored: 1, failed: 0, skipped: 0 });
    expect(fetched).toBe(false);
    expect(JSON.parse(fs.readFileSync(targetPath, "utf-8"))).toMatchObject({
      auth_mode: "chatgpt",
      tokens: {
        access_token: "live",
        refresh_token: "rotated-refresh",
      },
    });
    expect(readAuthProfileStore(agentDir)).toEqual(liveCred);
  });

  it("restores Codex from Secret Manager when only unrelated profiles exist and CODEX_HOME is missing", async () => {
    const oc = mkTmp();
    const agentId = "octogee-a-coach";
    const agentDir = path.join(oc, "agents", agentId, "agent");
    fs.mkdirSync(agentDir, { recursive: true });
    writeAuthProfileStore(agentDir, { version: 1, profiles: { rotated: "RT1" } });

    const targetPath = path.join(agentDir, "codex-home", "auth.json");
    const r = await restoreByosubCredentials({
      plan: [
        {
          agentId,
          provider: "openai" as const,
          secretName: "byosub-a-openai",
          targetPath,
          openclawDir: oc,
        },
      ],
      fetchSecret: async () => codexBlob(),
    });

    expect(r).toEqual({ restored: 1, failed: 0, skipped: 0 });
    expect(JSON.parse(fs.readFileSync(targetPath, "utf-8")).auth_mode).toBe("chatgpt");
    const store = readAuthProfileStore(agentDir) as {
      profiles: Record<string, { access?: string }>;
    };
    expect(store.profiles["openai-codex:default"].access).toBe("acc-1");
  });

  it("recovery: on-disk cred present but openclaw flagged auth_permanent → restore REPLACES the dead cred", async () => {
    const oc = mkTmp();
    const agentId = "octogee-a-coach";
    const agentDir = path.join(oc, "agents", agentId, "agent");
    fs.mkdirSync(agentDir, { recursive: true });
    writeAuthProfileStore(agentDir, { stale: true });
    fs.writeFileSync(
      path.join(agentDir, "auth-state.json"),
      JSON.stringify({
        version: 1,
        usageStats: {
          "openai-codex:default": {
            disabledReason: "auth_permanent",
            disabledUntil: Date.now() + 3_600_000,
          },
        },
      }),
    );
    const r = await restoreByosubCredentials({
      plan: [
        {
          agentId,
          provider: "openai" as const,
          secretName: "byosub-a-openai",
          targetPath: path.join(agentDir, "codex-home", "auth.json"),
          openclawDir: oc,
        },
      ],
      fetchSecret: async () => codexBlob(),
    });
    expect(r).toEqual({ restored: 1, failed: 0, skipped: 0 });
    const store = readAuthProfileStore(agentDir) as {
      profiles: Record<string, { access?: string }>;
    };
    expect(store.profiles["openai-codex:default"].access).toBe("acc-1");
  });
});

describe("readCodexAuthStateText — SQLite state row preferred, JSON file fallback (upstream PR #89102 + earlier)", () => {
  function seedSqliteState(agentDir: string, payload: unknown): void {
    fs.mkdirSync(agentDir, { recursive: true });
    const dbPath = resolveAuthDbPath(agentDir);
    const db = new DatabaseSync(dbPath);
    db.exec(
      `CREATE TABLE IF NOT EXISTS auth_profile_state (state_key TEXT NOT NULL PRIMARY KEY, state_json TEXT NOT NULL, updated_at INTEGER NOT NULL);`,
    );
    db.prepare(
      `INSERT INTO auth_profile_state (state_key, state_json, updated_at) VALUES ('primary', ?, ?)`,
    ).run(JSON.stringify(payload), Date.now());
    db.close();
  }

  it("returns null when no SQLite row and no legacy JSON file exists", () => {
    const oc = mkTmp();
    fs.mkdirSync(path.join(oc, "agents", "octogee-a-coach", "agent"), { recursive: true });
    expect(readCodexAuthStateText(oc, "octogee-a-coach")).toBeNull();
  });

  it("returns the legacy JSON file when SQLite has no state row (mixed-build slot or pre-migration)", () => {
    const oc = mkTmp();
    const agentDir = codexAgentDir(oc, "octogee-a-coach");
    fs.mkdirSync(agentDir, { recursive: true });
    const json = JSON.stringify({ version: 1, usageStats: {} });
    fs.writeFileSync(codexAuthStatePath(oc, "octogee-a-coach"), json);
    expect(readCodexAuthStateText(oc, "octogee-a-coach")).toBe(json);
  });

  it("returns the SQLite state row (re-stringified) when present — even if a stale JSON file is also on disk", () => {
    const oc = mkTmp();
    const agentDir = codexAgentDir(oc, "octogee-a-coach");
    const sqlitePayload = {
      version: 1,
      usageStats: {
        "openai-codex:default": { disabledReason: "auth_permanent", disabledUntil: 2_000_000_000_000 },
      },
    };
    seedSqliteState(agentDir, sqlitePayload);
    // Stale legacy file — must NOT shadow the live SQLite state.
    fs.writeFileSync(codexAuthStatePath(oc, "octogee-a-coach"), JSON.stringify({ stale: true }));
    const got = readCodexAuthStateText(oc, "octogee-a-coach");
    expect(JSON.parse(got ?? "null")).toEqual(sqlitePayload);
  });
});

describe("restoreByosubCredentials — honors SQLite auth_profile_state (the P1 gap)", () => {
  it("openclaw flagged auth_permanent in SQLite state row → restore REPLACES the dead cred", async () => {
    const oc = mkTmp();
    const agentId = "octogee-a-coach";
    const agentDir = codexAgentDir(oc, agentId);
    fs.mkdirSync(agentDir, { recursive: true });
    writeAuthProfileStore(agentDir, { stale: true });
    // No legacy auth-state.json — only the SQLite state row.
    const db = new DatabaseSync(resolveAuthDbPath(agentDir));
    db.exec(
      `CREATE TABLE IF NOT EXISTS auth_profile_state (state_key TEXT NOT NULL PRIMARY KEY, state_json TEXT NOT NULL, updated_at INTEGER NOT NULL);`,
    );
    db.prepare(
      `INSERT INTO auth_profile_state (state_key, state_json, updated_at) VALUES ('primary', ?, ?)`,
    ).run(
      JSON.stringify({
        version: 1,
        usageStats: {
          "openai-codex:default": {
            disabledReason: "auth_permanent",
            disabledUntil: Date.now() + 3_600_000,
          },
        },
      }),
      Date.now(),
    );
    db.close();

    const r = await restoreByosubCredentials({
      plan: [
        {
          agentId,
          provider: "openai" as const,
          secretName: "byosub-a-openai",
          targetPath: path.join(agentDir, "codex-home", "auth.json"),
          openclawDir: oc,
        },
      ],
      fetchSecret: async () => codexBlob(),
    });
    expect(r).toEqual({ restored: 1, failed: 0, skipped: 0 });
    const store = readAuthProfileStore(agentDir) as {
      profiles: Record<string, { access?: string }>;
    };
    expect(store.profiles["openai-codex:default"].access).toBe("acc-1");
  });
});

describe("agentIdsFromConfig", () => {
  it("returns [] when config has no agents.list", () => {
    expect(agentIdsFromConfig(undefined)).toEqual([]);
    expect(agentIdsFromConfig(null)).toEqual([]);
    expect(agentIdsFromConfig({})).toEqual([]);
    expect(agentIdsFromConfig({ agents: {} })).toEqual([]);
    expect(agentIdsFromConfig({ agents: { list: "nope" } })).toEqual([]);
  });

  it("extracts non-empty string ids only", () => {
    expect(
      agentIdsFromConfig({
        agents: {
          list: [
            { id: "octogee-ceckert-coach" },
            { id: "octogee-ops-gw-bender" },
            {},
            { id: "" },
            { id: 5 },
            null,
          ],
        },
      }),
    ).toEqual(["octogee-ceckert-coach", "octogee-ops-gw-bender"]);
  });
});
