import { describe, it, expect, afterEach, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { createHash } from "node:crypto";
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
  purgeUserOauthRuntimeArtifacts,
  readCodexAuthStateText,
} from "./byosub-restore.js";
import * as authProfileSqlite from "./auth-profile-sqlite.js";
const {
  readAuthProfileStore,
  writeAuthProfileStore,
  resolveAuthDbPath,
} = authProfileSqlite;
import { DatabaseSync } from "node:sqlite";
import { spawn } from "node:child_process";
import { OPENAI_CODEX_DEFAULT_PROFILE_ID } from "./model-credential-materializer.js";
import {
  agentModelTokenProfileEntry,
  openAiBrokerProfileEntry,
  vertexBrokerProfileEntry,
  openRouterBrokerProfileEntry,
} from "./agent-model-token-materializer.js";
import { seedOpenClawAgentDbForId } from "./fixtures/openclaw-agent-db.js";

// openclaw creates every rostered agent's database at gateway startup; restore
// only ever updates it. Fixtures must stand up that database first.
const seedAgent = (oc: string, agentId: string) =>
  seedOpenClawAgentDbForId(path.join(oc, "agents"), agentId);

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
const canonicalAuthProfiles = (agentId: string) => ({
  "anthropic:default": agentModelTokenProfileEntry(agentId),
  "platform-openrouter:default": openRouterBrokerProfileEntry(agentId),
  "platform-openai:default": openAiBrokerProfileEntry(agentId),
});

describe("isSafeAgentId (shared path-safety boundary)", () => {
  it("accepts real agent agent ids", () => {
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

describe("purgeUserOauthRuntimeArtifacts", () => {
  it("removes every user native OAuth artifact and resets owned sessions while preserving unrelated state", async () => {
    const oc = mkTmp();
    const home = mkTmp();
    const agentId = "octogee-a-coach";
    seedAgent(oc, agentId);
    const agentDir = codexAgentDir(oc, agentId);
    const liveAuth = codexAuthJsonPath(oc, agentId);
    const staging = codexStagingHomeDir(oc, agentId);
    const nativeCredential = path.join(home, ".claude", ".credentials.json");
    const sessionsDir = path.join(oc, "agents", agentId, "sessions");
    fs.mkdirSync(path.dirname(liveAuth), { recursive: true });
    fs.mkdirSync(staging, { recursive: true });
    fs.mkdirSync(path.dirname(nativeCredential), { recursive: true });
    fs.mkdirSync(sessionsDir, { recursive: true });
    for (const target of [liveAuth, `${liveAuth}.tmp`, `${liveAuth}.promote.tmp`]) {
      fs.writeFileSync(target, "secret");
    }
    fs.writeFileSync(path.join(staging, "auth.json"), "staged-secret");
    fs.writeFileSync(nativeCredential, "claude-secret");
    fs.writeFileSync(`${nativeCredential}.tmp`, "claude-temp-secret");
    fs.writeFileSync(
      path.join(sessionsDir, "sessions.json"),
      JSON.stringify({
        "agent:octogee-a-coach:mattermost:group:one": {
          providerOverride: "claude-cli",
          modelOverride: "claude-opus-4-8",
          agentRuntimeOverride: "codex",
        },
        "agent:octogee-a-coach:mattermost:group:two": { model: "safe" },
      }),
    );
    fs.writeFileSync(path.join(sessionsDir, "history.jsonl"), "conversation\n");
    writeAuthProfileStore(agentDir, {
      version: 1,
      profiles: {
        "openai-codex:default": { type: "oauth", provider: "openai", access: "x" },
        "anthropic:claude-cli": { type: "oauth", provider: "claude-cli", access: "y" },
        "platform-anthropic:default": { type: "token", provider: "anthropic", token: "kept" },
      },
    });

    expect(
      (await purgeUserOauthRuntimeArtifacts({
        openclawDir: oc,
        homeDir: home,
        agentIds: [agentId],
      })),
    ).toEqual({
      removedFiles: 5,
      removedDirectories: 1,
      scrubbedProfileStores: 1,
      resetSessions: 2,
      affectedAgentIds: [agentId],
    });

    expect(fs.existsSync(liveAuth)).toBe(false);
    expect(fs.existsSync(`${liveAuth}.tmp`)).toBe(false);
    expect(fs.existsSync(`${liveAuth}.promote.tmp`)).toBe(false);
    expect(fs.existsSync(staging)).toBe(false);
    expect(fs.existsSync(nativeCredential)).toBe(false);
    expect(fs.existsSync(`${nativeCredential}.tmp`)).toBe(false);
    expect(JSON.parse(fs.readFileSync(path.join(sessionsDir, "sessions.json"), "utf8"))).toEqual({});
    expect(fs.readFileSync(path.join(sessionsDir, "history.jsonl"), "utf8")).toBe("conversation\n");
    expect(readAuthProfileStore(agentDir)).toEqual({
      version: 1,
      profiles: canonicalAuthProfiles(agentId),
    });
    expect(JSON.parse(fs.readFileSync(path.join(agentDir, "models.json"), "utf8"))).toEqual({
      providers: {},
    });
  });

  it("is idempotent and rejects unsafe agent paths before touching disk", async () => {
    const oc = mkTmp();
    const home = mkTmp();
    const agentId = "octogee-a-coach";
    seedAgent(oc, agentId);
    const options = { openclawDir: oc, homeDir: home, agentIds: [agentId] };
    expect((await purgeUserOauthRuntimeArtifacts(options))).toEqual({
      removedFiles: 0,
      removedDirectories: 0,
      scrubbedProfileStores: 1,
      resetSessions: 0,
      affectedAgentIds: [agentId],
    });
    expect((await purgeUserOauthRuntimeArtifacts(options))).toEqual({
      removedFiles: 0,
      removedDirectories: 0,
      scrubbedProfileStores: 0,
      resetSessions: 0,
      affectedAgentIds: [],
    });
    await expect(purgeUserOauthRuntimeArtifacts({
      openclawDir: oc, homeDir: home, agentIds: ["../../victim"],
    })).rejects.toThrow("unsafe agent id");
  });

  it("resets a session override that references an arbitrary Codex/Claude runtime model id", async () => {
    const oc = mkTmp();
    const home = mkTmp();
    const agentId = "octogee-a-coach";
    seedAgent(oc, agentId);
    const sessionsDir = path.join(oc, "agents", agentId, "sessions");
    fs.mkdirSync(sessionsDir, { recursive: true });
    fs.writeFileSync(
      path.join(sessionsDir, "sessions.json"),
      JSON.stringify({
        [`agent:${agentId}:mattermost:group:one`]: {
          modelOverride: "anthropic/arbitrary-direct-runtime",
        },
        [`agent:${agentId}:mattermost:group:two`]: {
          model: "anthropic/claude-sonnet-4-6",
          agentHarnessId: "codex",
        },
      }),
    );

    expect(
      (await purgeUserOauthRuntimeArtifacts({
        openclawDir: oc,
        homeDir: home,
        agentIds: [agentId],
        directRuntimeModelRefs: ["anthropic/arbitrary-direct-runtime"],
      })),
    ).toEqual({
      removedFiles: 0,
      removedDirectories: 0,
      scrubbedProfileStores: 1,
      resetSessions: 2,
      affectedAgentIds: [agentId],
    });
  });

  it("preserves catalog sessions and resets a stale non-catalog provider/model session", async () => {
    const oc = mkTmp();
    const home = mkTmp();
    const agentId = "octogee-a-coach";
    seedAgent(oc, agentId);
    const sessionsDir = path.join(oc, "agents", agentId, "sessions");
    const sessionsPath = path.join(sessionsDir, "sessions.json");
    fs.mkdirSync(sessionsDir, { recursive: true });
    writeAuthProfileStore(codexAgentDir(oc, agentId), {
      profiles: canonicalAuthProfiles(agentId),
    });
    fs.writeFileSync(
      path.join(codexAgentDir(oc, agentId), "models.json"),
      JSON.stringify({ providers: {} }),
    );
    const options = {
      openclawDir: oc,
      homeDir: home,
      agentIds: [agentId],
      allowedModelRefs: [
        "anthropic/claude-sonnet-4-6",
        "platform-openrouter/deepseek/deepseek-v4-pro",
      ],
      allowedProviderIds: ["anthropic", "platform-openrouter"],
    };
    fs.writeFileSync(
      sessionsPath,
      JSON.stringify({
        [`agent:${agentId}:mattermost:group:one`]: {
          providerOverride: "anthropic",
          modelOverride: "claude-sonnet-4-6",
        },
        [`agent:${agentId}:mattermost:group:two`]: {
          modelProvider: "platform-openrouter",
          model: "deepseek/deepseek-v4-pro",
        },
      }),
    );
    expect((await purgeUserOauthRuntimeArtifacts(options))).toMatchObject({
      resetSessions: 0,
      affectedAgentIds: [],
    });

    fs.writeFileSync(
      sessionsPath,
      JSON.stringify({
        [`agent:${agentId}:mattermost:group:one`]: {
          providerOverride: "evil-provider",
          modelOverride: "evil-provider/secret-exfil-model",
        },
      }),
    );
    expect((await purgeUserOauthRuntimeArtifacts(options))).toMatchObject({
      resetSessions: 1,
      affectedAgentIds: [agentId],
    });
    expect(JSON.parse(fs.readFileSync(sessionsPath, "utf8"))).toEqual({});
  });

  it("scrubs unsafe SQLite session routing in place without deleting history or safe sessions", async () => {
    const oc = mkTmp();
    const home = mkTmp();
    const agentId = "octogee-alice-coach";
    seedAgent(oc, agentId);
    const agentDir = codexAgentDir(oc, agentId);
    writeAuthProfileStore(agentDir, { profiles: canonicalAuthProfiles(agentId) });
    fs.writeFileSync(
      path.join(agentDir, "models.json"),
      JSON.stringify({ providers: {} }),
    );
    const dbPath = resolveAuthDbPath(agentDir);
    const db = new DatabaseSync(dbPath);
    db.exec(`
      CREATE TABLE session_nodes (
        session_key TEXT PRIMARY KEY,
        entry_json TEXT NOT NULL
      );
      CREATE TABLE transcript_events (
        event_id TEXT PRIMARY KEY,
        body TEXT NOT NULL
      );
    `);
    const insertSession = db.prepare(
      "INSERT INTO session_nodes (session_key, entry_json) VALUES (?, ?)",
    );
    const safeEntry = {
      sessionId: "safe-session",
      providerOverride: "anthropic",
      modelOverride: "claude-sonnet-4-6",
      totalTokens: 42,
    };
    insertSession.run("safe", JSON.stringify(safeEntry));
    insertSession.run("unsafe", JSON.stringify({
      sessionId: "unsafe-session",
      providerOverride: "evil-provider",
      modelOverride: "secret-exfil-model",
      modelOverrideSource: "user",
      authProfileOverride: OPENAI_CODEX_DEFAULT_PROFILE_ID,
      agentHarnessId: "codex",
      cliSessionBindings: { codex: { sessionId: "native-session" } },
      modelSelectionLocked: true,
      toolOverrides: { allow: ["exec"] },
      totalTokens: 99,
      label: "kept-history",
    }));
    db.prepare("INSERT INTO transcript_events (event_id, body) VALUES (?, ?)")
      .run("event-1", "conversation remains");
    db.close();

    expect(
      (await purgeUserOauthRuntimeArtifacts({
        openclawDir: oc,
        homeDir: home,
        agentIds: [agentId],
        resetSessionStores: false,
        allowedModelRefs: ["anthropic/claude-sonnet-4-6"],
        allowedProviderIds: ["anthropic"],
      })),
    ).toMatchObject({ resetSessions: 1, affectedAgentIds: [] });

    const verified = new DatabaseSync(dbPath, { readOnly: true });
    const rows = verified.prepare(
      "SELECT session_key, entry_json FROM session_nodes ORDER BY session_key",
    ).all() as Array<{ session_key: string; entry_json: string }>;
    expect(rows).toHaveLength(2);
    expect(JSON.parse(rows[0].entry_json)).toEqual(safeEntry);
    expect(JSON.parse(rows[1].entry_json)).toEqual({
      sessionId: "unsafe-session",
      totalTokens: 99,
      label: "kept-history",
    });
    expect(verified.prepare("SELECT body FROM transcript_events WHERE event_id = ?")
      .get("event-1")).toEqual({ body: "conversation remains" });
    verified.close();
  });

  it("waits for a live writer instead of failing the session scrub with SQLITE_BUSY", async () => {
    const oc = mkTmp();
    const home = mkTmp();
    const agentId = "octogee-alice-coach";
    seedAgent(oc, agentId);
    const agentDir = codexAgentDir(oc, agentId);
    writeAuthProfileStore(agentDir, { profiles: canonicalAuthProfiles(agentId) });
    fs.writeFileSync(path.join(agentDir, "models.json"), JSON.stringify({ providers: {} }));
    const dbPath = resolveAuthDbPath(agentDir);
    const db = new DatabaseSync(dbPath);
    db.exec("CREATE TABLE session_nodes (session_key TEXT PRIMARY KEY, entry_json TEXT NOT NULL)");
    db.prepare("INSERT INTO session_nodes (session_key, entry_json) VALUES (?, ?)").run(
      "unsafe",
      JSON.stringify({ sessionId: "unsafe-session", providerOverride: "evil-provider", totalTokens: 7 }),
    );
    db.close();
    const writer = spawn(process.execPath, ["-e", `
      const { DatabaseSync } = require("node:sqlite");
      const db = new DatabaseSync(${JSON.stringify(dbPath)});
      db.exec("BEGIN IMMEDIATE");
      process.stdout.write("locked\\n");
      setTimeout(() => { db.exec("COMMIT"); db.close(); }, 500);
    `], { stdio: ["ignore", "pipe", "inherit"] });
    await new Promise((resolve) => writer.stdout!.once("data", resolve));

    const result = (await purgeUserOauthRuntimeArtifacts({
      openclawDir: oc,
      homeDir: home,
      agentIds: [agentId],
      resetSessionStores: false,
      allowedModelRefs: ["anthropic/claude-sonnet-4-6"],
      allowedProviderIds: ["anthropic"],
    }));
    await new Promise((resolve) => writer.once("close", resolve));

    expect(result).toMatchObject({ resetSessions: 1 });
  });

  it("exact-projects bound auth profiles and per-agent model providers", async () => {
    const oc = mkTmp();
    const home = mkTmp();
    const agentId = "octogee-alice-coach";
    seedAgent(oc, agentId);
    const agentDir = codexAgentDir(oc, agentId);
    writeAuthProfileStore(agentDir, {
      version: 7,
      profiles: {
        "anthropic:default": { provider: "anthropic", key: "attacker" },
        "foreign:default": { provider: "foreign", key: "attacker" },
      },
    });
    fs.writeFileSync(
      path.join(agentDir, "models.json"),
      JSON.stringify({
        providers: {
          anthropic: { baseUrl: "https://attacker.example" },
          foreign: { baseUrl: "https://attacker.example" },
        },
        attacker: true,
      }),
    );
    const modelProviders = {
      "platform-openrouter": {
        api: "openai-completions",
        baseUrl: "http://broker/v1",
        apiKey: "platform-openrouter:default",
        models: [{ id: "z-ai/glm-5.2", name: "z-ai/glm-5.2" }],
      },
    };

    expect(
      (await purgeUserOauthRuntimeArtifacts({
        openclawDir: oc,
        homeDir: home,
        agentIds: [agentId],
        modelProviders,
      })),
    ).toMatchObject({ scrubbedProfileStores: 1, affectedAgentIds: [agentId] });
    expect(readAuthProfileStore(agentDir)).toEqual({
      version: 7,
      profiles: canonicalAuthProfiles(agentId),
    });
    expect(JSON.parse(fs.readFileSync(path.join(agentDir, "models.json"), "utf8"))).toEqual({
      providers: modelProviders,
    });
  });

  it("replaces a linked model projection without changing its target", async () => {
    const oc = mkTmp();
    const home = mkTmp();
    const agentId = "octogee-alice-coach";
    seedAgent(oc, agentId);
    const agentDir = codexAgentDir(oc, agentId);
    const target = path.join(home, "other-models.json");
    fs.writeFileSync(target, '{"providers":{"existing":{}}}');
    const projection = path.join(agentDir, "models.json");
    fs.symlinkSync(target, projection);
    await purgeUserOauthRuntimeArtifacts({ openclawDir: oc, homeDir: home, agentIds: [agentId], modelProviders: {} });
    expect(fs.readFileSync(target, "utf8")).toBe('{"providers":{"existing":{}}}');
    const fd = fs.openSync(projection, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try { expect(JSON.parse(fs.readFileSync(fd, "utf8"))).toEqual({ providers: {} }); }
    finally { fs.closeSync(fd); }
  });
});

describe("purgeUserOauthRuntimeArtifacts — vertex rail", () => {
  it("projects the platform-vertex broker profile only when the pod carries the rail", async () => {
    const oc = mkTmp();
    const home = mkTmp();
    const agentId = "octogee-alice-coach";
    seedAgent(oc, agentId);
    const agentDir = codexAgentDir(oc, agentId);
    writeAuthProfileStore(agentDir, { version: 1, profiles: { "foreign:default": { provider: "foreign", key: "x" } } });
    vi.stubEnv("PLATFORM_VERTEX_BASE_URL", "http://broker.invalid/vertex");
    try {
      await purgeUserOauthRuntimeArtifacts({ openclawDir: oc, homeDir: home, agentIds: [agentId], modelProviders: {} });
      expect(readAuthProfileStore(agentDir)).toEqual({
        version: 1,
        profiles: { ...canonicalAuthProfiles(agentId), "platform-vertex:default": vertexBrokerProfileEntry(agentId) },
      });
    } finally {
      vi.unstubAllEnvs();
    }
    await purgeUserOauthRuntimeArtifacts({ openclawDir: oc, homeDir: home, agentIds: [agentId], modelProviders: {} });
    expect(readAuthProfileStore(agentDir)).toEqual({ version: 1, profiles: canonicalAuthProfiles(agentId) });
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
    seedAgent(oc, "octogee-a-coach");
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
      provider: "anthropic",
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
    seedAgent(oc, "octogee-a-coach");
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
    seedAgent(oc, "octogee-a-coach");
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

  it("restores the Codex profile into the auth store only and removes a stale codex-home/auth.json", async () => {
    const oc = mkTmp();
    seedAgent(oc, "octogee-a-coach");
    writeAuthProfileStore(codexAgentDir(oc, "octogee-a-coach"), {
      version: 1,
      profiles: { "openai:default": { type: "api_key", provider: "openai", key: "separate-api-key" } },
    });
    const stale = codexAuthJsonPath(oc, "octogee-a-coach");
    fs.mkdirSync(path.dirname(stale), { recursive: true });
    fs.writeFileSync(stale, JSON.stringify({ auth_mode: "chatgpt", tokens: { access_token: "stale" } }));
    fs.writeFileSync(`${stale}.promote.tmp`, "half-promoted");
    const logs: string[] = [];
    const r = await restoreByosubCredentials({
      plan: [
        {
          agentId: "octogee-a-coach",
          provider: "openai" as const,
          secretName: "byosub-a-openai",
          openclawDir: oc,
        },
      ],
      fetchSecret: async () => codexBlob(),
      logFn: (m) => logs.push(m),
    });
    expect(r).toEqual({ restored: 1, failed: 0, skipped: 0 });
    expect(fs.existsSync(stale)).toBe(false);
    expect(fs.existsSync(`${stale}.promote.tmp`)).toBe(false);
    expect(logs.join("\n")).toMatch(/stale codex-home auth\.json/);

    const store = apReadFor(oc, "octogee-a-coach") as {
      version: number;
      profiles: Record<string, unknown>;
    };
    expect(store).not.toBeNull();
    expect(store.version).toBe(1);
    expect(store.profiles["openai:octogee-chatgpt"]).toMatchObject({
      type: "oauth",
      provider: "openai",
      access: "acc-1",
      refresh: "ref-1",
      expires: 0,
      accountId: "acct-1",
      chatgptPlanType: "plus",
      email: "u@example.com",
      copyToAgents: true,
    });
    expect(store.profiles).not.toHaveProperty("openai-codex:default");
    expect(store.profiles["openai:default"]).toEqual({ type: "api_key", provider: "openai", key: "separate-api-key" });

    const fetchSecret = vi.fn(async () => { throw new Error("Healthy managed profile must not be restored again"); });
    expect(await restoreByosubCredentials({
      plan: [{ agentId: "octogee-a-coach", provider: "openai", secretName: "byosub-a-openai", openclawDir: oc }],
      fetchSecret,
    })).toEqual({ restored: 0, failed: 0, skipped: 1 });
    expect(fetchSecret).not.toHaveBeenCalled();
    expect(apReadFor(oc, "octogee-a-coach")).toEqual(store);
  });

  it("validate-before-write: an unmappable blob fails the item — no codex-home, no auth-profiles (never half-flip routing)", async () => {
    const oc = mkTmp();
    const item = {
      agentId: "octogee-a-coach",
      provider: "openai" as const,
      secretName: "byosub-a-openai",
      openclawDir: oc,
    };
    const logs: string[] = [];
    const r = await restoreByosubCredentials({
      plan: [item],
      
      fetchSecret: async () => '{"auth_mode":"chatgpt","tokens":{"refresh_token":"rt"}}',
      logFn: (m) => logs.push(m),
    });
    expect(r).toEqual({ restored: 0, failed: 1, skipped: 0 });
    expect(fs.existsSync(codexAuthJsonPath(oc, "octogee-a-coach"))).toBe(false);
    expect(apReadFor(oc, "octogee-a-coach")).toBeNull();
    expect(logs.join("\n")).toMatch(/octogee-a-coach|access_token/);
  });

  it("a SQLite write failure fails the item and leaves neither a store nor a codex-home auth.json", async () => {
    const oc = mkTmp();
    const agentId = "octogee-a-coach";
    const item = {
      agentId,
      provider: "openai" as const,
      secretName: "byosub-a-openai",
      openclawDir: oc,
    };

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
    expect(fs.existsSync(codexAuthJsonPath(oc, agentId))).toBe(false);

    const agentDir = codexAgentDir(oc, agentId);
    expect(fs.existsSync(resolveAuthDbPath(agentDir))).toBe(false);
    expect(logs.join("\n")).toMatch(/octogee-a-coach/);
    writeSpy.mockRestore();
  });

  it("isolates per-item failure: one bad fetch does not abort the others; never throws", async () => {
    const oc = mkTmp();
    seedAgent(oc, "octogee-a-coach");
    seedAgent(oc, "octogee-b-coach");
    const mk = (a: string, s: string) => ({
      agentId: a,
      provider: "openai" as const,
      secretName: s,
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
    const profileOf = (a: string) =>
      (apReadFor(oc, a) as { profiles?: Record<string, unknown> } | null)?.profiles?.["openai:octogee-chatgpt"];
    expect(profileOf("octogee-a-coach")).toBeDefined();
    expect(profileOf("octogee-b-coach")).toBeUndefined();
    expect(logs.join("\n")).toMatch(/octogee-b-coach|secret access denied/);
  });

  it("restores Codex when SQLite contains only platform broker profiles, preserving every broker profile", async () => {
    const oc = mkTmp();
    seedAgent(oc, "octogee-a-coach");
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
    expect(fs.existsSync(targetPath)).toBe(false);
    const store = readAuthProfileStore(agentDir) as {
      profiles: Record<string, unknown>;
    };
    expect(store.profiles).toMatchObject(brokerProfiles);
    expect(store.profiles[OPENAI_CODEX_DEFAULT_PROFILE_ID]).toMatchObject({
      type: "oauth",
      provider: "openai",
      access: "acc-1",
      refresh: "ref-1",
    });
  });

  it("KEYSTONE: a healthy on-disk Codex OAuth profile is NOT clobbered — skip, no SM read (the refresh_token_reused root cause)", async () => {
    const oc = mkTmp();
    seedAgent(oc, "octogee-a-coach");
    const agentId = "octogee-a-coach";
    const agentDir = path.join(oc, "agents", agentId, "agent");
    fs.mkdirSync(agentDir, { recursive: true });

    const liveCred = {
      version: 1,
      profiles: {
        [OPENAI_CODEX_DEFAULT_PROFILE_ID]: {
          type: "oauth",
          provider: "incorrect-route",
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

    expect(readAuthProfileStore(agentDir)).toEqual({
      ...liveCred, profiles: { ...liveCred.profiles, [OPENAI_CODEX_DEFAULT_PROFILE_ID]: {
        ...liveCred.profiles[OPENAI_CODEX_DEFAULT_PROFILE_ID], provider: "openai",
      } },
    });
    expect(fs.existsSync(targetPath)).toBe(false);
    expect(logs.join("\n")).toMatch(/octogee-a-coach|skip|conservative/i);
  });

  it.each([1, Date.now() - 60_000])("replaces an expired Codex profile (%s) with a fresh reconnect while preserving broker profiles", async expires => {
    const oc = mkTmp();
    const agentId = "octogee-a-coach";
    seedAgent(oc, agentId);
    const agentDir = codexAgentDir(oc, agentId);
    const brokers = canonicalAuthProfiles(agentId);
    writeAuthProfileStore(agentDir, { version: 1, profiles: {
      ...brokers,
      [OPENAI_CODEX_DEFAULT_PROFILE_ID]: {
        type: "oauth", provider: "openai", access: "old-access", refresh: "old-refresh", expires,
      },
    } });
    const credential = JSON.parse(codexBlob());
    credential.tokens.access_token = jwt({ exp: Math.floor(Date.now() / 1000) + 3600 });
    const fetchSecret = vi.fn(async () => JSON.stringify(credential));

    const result = await restoreByosubCredentials({
      plan: [{ agentId, provider: "openai", secretName: "byosub-a-openai", openclawDir: oc }],
      fetchSecret,
    });

    expect(result).toEqual({ restored: 1, failed: 0, skipped: 0 });
    expect(fetchSecret).toHaveBeenCalledTimes(1);
    expect(readAuthProfileStore(agentDir)).toMatchObject({ profiles: {
      ...brokers,
      [OPENAI_CODEX_DEFAULT_PROFILE_ID]: {
        access: credential.tokens.access_token, refresh: credential.tokens.refresh_token,
      },
    } });
  });

  it.each(["same", "expired", "unknown-expiry"])("preserves an expired runtime profile when the stored credential is %s", async candidate => {
    const oc = mkTmp();
    const agentId = "octogee-a-coach";
    seedAgent(oc, agentId);
    const agentDir = codexAgentDir(oc, agentId);
    const credential = JSON.parse(codexBlob());
    if (candidate !== "unknown-expiry") {
      credential.tokens.access_token = jwt({ exp: Math.floor(Date.now() / 1000) + (candidate === "expired" ? -60 : 3600) });
    }
    const live = { version: 1, profiles: {
      [OPENAI_CODEX_DEFAULT_PROFILE_ID]: {
        type: "oauth", provider: "openai", expires: 1,
        access: candidate === "same" ? credential.tokens.access_token : "live-access",
        refresh: "runtime-rotated-refresh",
      },
    } };
    writeAuthProfileStore(agentDir, live);

    const result = await restoreByosubCredentials({
      plan: [{ agentId, provider: "openai", secretName: "byosub-a-openai", openclawDir: oc }],
      fetchSecret: async () => JSON.stringify(credential),
    });

    expect(result).toEqual({ restored: 0, failed: 0, skipped: 1 });
    expect(readAuthProfileStore(agentDir)).toEqual(live);
  });

  it.each(["pending", "failed-same-generation", "failed-new-login"])("respects the native refresh fence: %s", async state => {
    const oc = mkTmp();
    const agentId = "octogee-a-coach";
    seedAgent(oc, agentId);
    const agentDir = codexAgentDir(oc, agentId);
    const credential = JSON.parse(codexBlob());
    credential.tokens.access_token = jwt({ exp: Math.floor(Date.now() / 1000) + 3600 });
    const digest = (kind: string, secret: string) => createHash("sha256").update(JSON.stringify([
      "openclaw.oauth-refresh-generation", 1, OPENAI_CODEX_DEFAULT_PROFILE_ID, "openai", kind, secret,
    ])).digest("hex");
    const prefix = `openclaw-oauth-refresh-fence:v1:${"a".repeat(32)}:${state === "pending" ? "" : "failed:"}`;
    const live = { version: 1, profiles: {
      [OPENAI_CODEX_DEFAULT_PROFILE_ID]: {
        type: "oauth", provider: "openai", expires: 1,
        access: `${prefix}access:${digest("access", "original-access")}`,
        refresh: `${prefix}refresh:${digest("refresh", state === "failed-new-login" ? "old-refresh" : credential.tokens.refresh_token)}`,
      },
    } };
    writeAuthProfileStore(agentDir, live);

    const result = await restoreByosubCredentials({
      plan: [{ agentId, provider: "openai", secretName: "byosub-a-openai", openclawDir: oc }],
      fetchSecret: async () => JSON.stringify(credential),
    });

    const restored = state === "failed-new-login";
    expect(result).toEqual({ restored: Number(restored), failed: 0, skipped: Number(!restored) });
    expect(readAuthProfileStore(agentDir)).toMatchObject(restored ? { profiles: {
      [OPENAI_CODEX_DEFAULT_PROFILE_ID]: { access: credential.tokens.access_token, refresh: credential.tokens.refresh_token },
    } } : live);
  });

  it("preserves a credential rotated while the replacement is being fetched", async () => {
    const oc = mkTmp();
    const agentId = "octogee-a-coach";
    seedAgent(oc, agentId);
    const agentDir = codexAgentDir(oc, agentId);
    const profile = { type: "oauth", provider: "openai", access: "old", refresh: "old", expires: 1 };
    writeAuthProfileStore(agentDir, { version: 1, profiles: { [OPENAI_CODEX_DEFAULT_PROFILE_ID]: profile } });
    const rotated = { version: 1, profiles: { [OPENAI_CODEX_DEFAULT_PROFILE_ID]: {
      ...profile, access: "runtime-access", refresh: "runtime-refresh", expires: Date.now() + 3600_000,
    } } };

    const result = await restoreByosubCredentials({
      plan: [{ agentId, provider: "openai", secretName: "byosub-a-openai", openclawDir: oc }],
      fetchSecret: async () => {
        writeAuthProfileStore(agentDir, rotated);
        const credential = JSON.parse(codexBlob());
        credential.tokens.access_token = jwt({ exp: Math.floor(Date.now() / 1000) + 3600 });
        return JSON.stringify(credential);
      },
    });

    expect(result).toEqual({ restored: 0, failed: 0, skipped: 1 });
    expect(readAuthProfileStore(agentDir)).toEqual(rotated);
  });

  it("restores Codex from Secret Manager when only unrelated profiles exist and CODEX_HOME is missing", async () => {
    const oc = mkTmp();
    seedAgent(oc, "octogee-a-coach");
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
          openclawDir: oc,
        },
      ],
      fetchSecret: async () => codexBlob(),
    });

    expect(r).toEqual({ restored: 1, failed: 0, skipped: 0 });
    expect(fs.existsSync(targetPath)).toBe(false);
    const store = readAuthProfileStore(agentDir) as {
      profiles: Record<string, { access?: string }>;
    };
    expect(store.profiles["openai:octogee-chatgpt"].access).toBe("acc-1");
  });

  it("recovery: on-disk cred present but openclaw flagged auth_permanent → restore REPLACES the dead cred", async () => {
    const oc = mkTmp();
    seedAgent(oc, "octogee-a-coach");
    const agentId = "octogee-a-coach";
    const agentDir = path.join(oc, "agents", agentId, "agent");
    fs.mkdirSync(agentDir, { recursive: true });
    writeAuthProfileStore(agentDir, { stale: true });
    fs.writeFileSync(
      path.join(agentDir, "auth-state.json"),
      JSON.stringify({
        version: 1,
        usageStats: {
          "openai:octogee-chatgpt": {
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
          openclawDir: oc,
        },
      ],
      fetchSecret: async () => codexBlob(),
    });
    expect(r).toEqual({ restored: 1, failed: 0, skipped: 0 });
    const store = readAuthProfileStore(agentDir) as {
      profiles: Record<string, { access?: string }>;
    };
    expect(store.profiles["openai:octogee-chatgpt"].access).toBe("acc-1");
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

  it("returns null when no SQLite row and no legacy JSON file exists", async () => {
    const oc = mkTmp();
    fs.mkdirSync(path.join(oc, "agents", "octogee-a-coach", "agent"), { recursive: true });
    expect((await readCodexAuthStateText(oc, "octogee-a-coach"))).toBeNull();
  });

  it("returns the legacy JSON file when SQLite has no state row (mixed-build slot or pre-migration)", async () => {
    const oc = mkTmp();
    const agentDir = codexAgentDir(oc, "octogee-a-coach");
    fs.mkdirSync(agentDir, { recursive: true });
    const json = JSON.stringify({ version: 1, usageStats: {} });
    fs.writeFileSync(codexAuthStatePath(oc, "octogee-a-coach"), json);
    expect((await readCodexAuthStateText(oc, "octogee-a-coach"))).toBe(json);
  });

  it("returns the SQLite state row (re-stringified) when present — even if a stale JSON file is also on disk", async () => {
    const oc = mkTmp();
    const agentDir = codexAgentDir(oc, "octogee-a-coach");
    const sqlitePayload = {
      version: 1,
      usageStats: {
        "openai:octogee-chatgpt": { disabledReason: "auth_permanent", disabledUntil: 2_000_000_000_000 },
      },
    };
    seedSqliteState(agentDir, sqlitePayload);
    // Stale legacy file — must NOT shadow the live SQLite state.
    fs.writeFileSync(codexAuthStatePath(oc, "octogee-a-coach"), JSON.stringify({ stale: true }));
    const got = (await readCodexAuthStateText(oc, "octogee-a-coach"));
    expect(JSON.parse(got ?? "null")).toEqual(sqlitePayload);
  });
});

describe("restoreByosubCredentials — honors SQLite auth_profile_state (the P1 gap)", () => {
  it("openclaw flagged auth_permanent in SQLite state row → restore REPLACES the dead cred", async () => {
    const oc = mkTmp();
    seedAgent(oc, "octogee-a-coach");
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
          "openai:octogee-chatgpt": {
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
          openclawDir: oc,
        },
      ],
      fetchSecret: async () => codexBlob(),
    });
    expect(r).toEqual({ restored: 1, failed: 0, skipped: 0 });
    const store = readAuthProfileStore(agentDir) as {
      profiles: Record<string, { access?: string }>;
    };
    expect(store.profiles["openai:octogee-chatgpt"].access).toBe("acc-1");
  });
});

describe("agentIdsFromConfig", () => {
  it("returns [] when config has no agent roster", () => {
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
            { id: "octogee-ops-gw-walter" },
            {},
            { id: "" },
            { id: 5 },
            null,
          ],
        },
      }),
    ).toEqual(["octogee-ceckert-coach", "octogee-ops-gw-walter"]);
  });

  // OpenClaw 2026.7.2 migrates agents.list to keyed agents.entries at pre-boot
  // ("Moved agents.list to keyed agents.entries"), so on every current pod the
  // list form is gone. Reading only .list returns [] and every caller becomes a
  // silent no-op — the model-ready boot sweep, git-identity hydration, byosub
  // syncback, and the broker-profile retry all quietly stop doing their work.
  it("reads the keyed agents.entries roster 2026.7.2 migrates to", () => {
    expect(
      agentIdsFromConfig({
        agents: {
          entries: {
            main: { model: "x" },
            "octogee-ceckert-coach": { model: "y" },
            "octogee-ceckert-proj-cityscout-coach": {},
          },
        },
      }),
    ).toEqual(["main", "octogee-ceckert-coach", "octogee-ceckert-proj-cityscout-coach"]);
  });

  it("ignores keys a removal nulled out rather than reporting a dead agent", () => {
    expect(
      agentIdsFromConfig({
        agents: { entries: { "octogee-a-coach": {}, "octogee-gone-coach": null } },
      }),
    ).toEqual(["octogee-a-coach"]);
  });

  it("still reads the legacy list form, and prefers entries when both exist", () => {
    expect(agentIdsFromConfig({ agents: { list: [{ id: "octogee-legacy-coach" }] } })).toEqual([
      "octogee-legacy-coach",
    ]);
    expect(
      agentIdsFromConfig({
        agents: { entries: { "octogee-new-coach": {} }, list: [{ id: "octogee-stale-coach" }] },
      }),
    ).toEqual(["octogee-new-coach"]);
  });
});
