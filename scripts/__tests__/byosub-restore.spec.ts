import { describe, it, expect, afterEach, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  planByosubRestores,
  restoreByosubCredentials,
  restoreByosubForAgents,
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
} from "../lib/byosub-restore.js";
import * as authProfileSqlite from "../lib/auth-profile-sqlite.js";
const {
  readAuthProfileStore,
  writeAuthProfileStore,
  resolveAuthDbPath,
} = authProfileSqlite;
import { DatabaseSync } from "node:sqlite";
import { OPENAI_CODEX_DEFAULT_PROFILE_ID } from "../lib/model-credential-materializer.js";

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

  it("is exactly the path planByosubRestores writes to (no drift between writer + restorer)", () => {
    const [item] = planByosubRestores({
      agentIds: ["octogee-a-coach"],
      byosub: { "octogee-a-coach": { provider: "openai", secretName: "s" } },
      openclawDir: OC,
    });
    expect(item.targetPath).toBe(codexAuthJsonPath(OC, "octogee-a-coach"));
  });
});

describe("planByosubRestores", () => {
  it("returns [] for undefined/empty byosub", () => {
    expect(
      planByosubRestores({ agentIds: ["octogee-a-coach"], byosub: undefined, openclawDir: OC }),
    ).toEqual([]);
    expect(
      planByosubRestores({ agentIds: ["octogee-a-coach"], byosub: {}, openclawDir: OC }),
    ).toEqual([]);
  });

  it("plans an openai restore into the per-agent codex-home (not ~/.codex)", () => {
    const plan = planByosubRestores({
      agentIds: ["octogee-ceckert-coach", "octogee-ops-gw-bender"],
      byosub: {
        "octogee-ceckert-coach": { provider: "openai", secretName: "byosub-uid1-openai" },
      },
      openclawDir: OC,
    });
    expect(plan).toEqual([
      {
        agentId: "octogee-ceckert-coach",
        provider: "openai",
        secretName: "byosub-uid1-openai",
        targetPath: codexAuth("octogee-ceckert-coach"),
        openclawDir: OC,
      },
    ]);
  });

  it("plans independently for many customers on one shared gateway", () => {
    const plan = planByosubRestores({
      agentIds: ["octogee-a-coach", "octogee-b-coach", "octogee-ops-x"],
      byosub: {
        "octogee-a-coach": { provider: "openai", secretName: "byosub-a-openai" },
        "octogee-b-coach": { provider: "openai", secretName: "byosub-b-openai" },
      },
      openclawDir: OC,
    });
    expect(plan.map((p) => p.agentId).sort()).toEqual([
      "octogee-a-coach",
      "octogee-b-coach",
    ]);
    expect(plan.find((p) => p.agentId === "octogee-b-coach")!.targetPath).toBe(
      codexAuth("octogee-b-coach"),
    );
  });

  it("skips + logs a ref whose agent is not present on this gateway", () => {
    const logs: string[] = [];
    const plan = planByosubRestores({
      agentIds: ["octogee-a-coach"],
      byosub: { "octogee-ghost-coach": { provider: "openai", secretName: "s" } },
      openclawDir: OC,
      logFn: (m) => logs.push(m),
    });
    expect(plan).toEqual([]);
    expect(logs.join("\n")).toMatch(/octogee-ghost-coach.*not present|not on this gateway/i);
  });

  it("plans anthropic as a claude-cli SQLite-store restore (no auth.json file — openclaw's claude-cli runtime reads the store)", () => {
    const plan = planByosubRestores({
      agentIds: ["octogee-a-coach"],
      byosub: { "octogee-a-coach": { provider: "anthropic", secretName: "byosub-a-anthropic" } },
      openclawDir: OC,
    });
    expect(plan).toEqual([
      {
        agentId: "octogee-a-coach",
        provider: "anthropic",
        secretName: "byosub-a-anthropic",
        openclawDir: OC,
      },
    ]);
  });

  it("skips + logs an unknown provider", () => {
    const logs: string[] = [];
    const plan = planByosubRestores({
      agentIds: ["octogee-a-coach"],
      byosub: { "octogee-a-coach": { provider: "grok" as never, secretName: "s" } },
      openclawDir: OC,
      logFn: (m) => logs.push(m),
    });
    expect(plan).toEqual([]);
    expect(logs.join("\n")).toMatch(/unknown provider|grok/i);
  });

  it("rejects path-traversal / unsafe agent ids (Firestore-sourced keys)", () => {
    const logs: string[] = [];
    const longId = "x".repeat(200);

const byosub = JSON.parse(
      `{"../../etc":{"provider":"openai","secretName":"s1"},` +
        `"a/b":{"provider":"openai","secretName":"s2"},` +
        `"foo bar":{"provider":"openai","secretName":"s3"},` +
        `"Up$er":{"provider":"openai","secretName":"s4"},` +
        `"${longId}":{"provider":"openai","secretName":"s5"},` +
        `"__proto__":{"provider":"openai","secretName":"s6"}}`,
    );
    const plan = planByosubRestores({
      agentIds: ["../../etc", "a/b", "foo bar", "Up$er", longId, "__proto__"],
      byosub,
      openclawDir: OC,
      logFn: (m) => logs.push(m),
    });
    
    expect(plan).toEqual([]);
    expect(logs.join("\n")).toMatch(/unsafe|invalid agent id/i);
    
    expect(({} as Record<string, unknown>).secretName).toBeUndefined();
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
        authProfilesPresent: false,
        authStateText: null,
        profileId: P,
        now: NOW,
      }),
    ).toBe("write");
    
    expect(
      shouldRestoreCodexCredential({
        authProfilesPresent: false,
        authStateText: authPermanent,
        profileId: P,
        now: NOW,
      }),
    ).toBe("write");
  });

  it("steady state (healthy on-disk cred, no auth_permanent) → SKIP — never clobber openclaw's rotated token", () => {
    expect(
      shouldRestoreCodexCredential({
        authProfilesPresent: true,
        authStateText: null,
        profileId: P,
        now: NOW,
      }),
    ).toBe("skip");
    expect(
      shouldRestoreCodexCredential({
        authProfilesPresent: true,
        authStateText: JSON.stringify({ version: 1, usageStats: { [P]: { errorCount: 0 } } }),
        profileId: P,
        now: NOW,
      }),
    ).toBe("skip");
  });

  it("recovery (on-disk cred present but openclaw flagged auth_permanent) → write — replace the dead cred", () => {
    expect(
      shouldRestoreCodexCredential({
        authProfilesPresent: true,
        authStateText: authPermanent,
        profileId: P,
        now: NOW,
      }),
    ).toBe("write");
  });

  it("an elapsed auth_permanent window is healthy again → SKIP (openclaw will retry; don't clobber)", () => {
    expect(
      shouldRestoreCodexCredential({
        authProfilesPresent: true,
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
    const agentId = "octogee-a-coach";
    const item = {
      agentId,
      provider: "anthropic" as const,
      secretName: "byosub-a-anthropic",
      openclawDir: oc,
    };
    const r = await restoreByosubCredentials({
      plan: [item],
      fetchSecret: async () => "sk-ant-oat01-livetoken",
    });
    expect(r).toEqual({ restored: 1, failed: 0, skipped: 0 });
    // No codex-home auth.json — the claude-cli credential lives only in the store.
    expect(
      fs.existsSync(path.join(oc, "agents", agentId, "agent", "codex-home", "auth.json")),
    ).toBe(false);
    const store = apReadFor(oc, agentId) as {
      version: number;
      profiles: Record<string, { type: string; provider: string; access: string }>;
    };
    expect(store.version).toBe(1);
    expect(store.profiles["anthropic:claude-cli"]).toMatchObject({
      type: "oauth",
      provider: "claude-cli",
      access: "sk-ant-oat01-livetoken",
    });
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

  it("KEYSTONE: a healthy on-disk auth-profile SQLite row is NOT clobbered — skip, no SM read (the refresh_token_reused root cause)", async () => {
    const oc = mkTmp();
    const agentId = "octogee-a-coach";
    const agentDir = path.join(oc, "agents", agentId, "agent");
    fs.mkdirSync(agentDir, { recursive: true });

    const liveCred = { version: 1, profiles: { rotated: "RT1" } };
    writeAuthProfileStore(agentDir, liveCred);

    let fetched = false;
    const logs: string[] = [];
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
      fetchSecret: async () => {
        fetched = true;
        return codexBlob();
      },
      logFn: (m) => logs.push(m),
    });
    expect(r).toEqual({ restored: 0, failed: 0, skipped: 1 });
    expect(fetched).toBe(false);

    expect(readAuthProfileStore(agentDir)).toEqual(liveCred);
    expect(fs.existsSync(path.join(agentDir, "codex-home", "auth.json"))).toBe(false);
    expect(logs.join("\n")).toMatch(/octogee-a-coach|skip|conservative/i);
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

describe("restoreByosubForAgents (shared plan+restore composition)", () => {
  it("no-op when nothing to plan → {restored:0,failed:0,planned:0}, no fs", async () => {
    const oc = mkTmp();
    let fetched = false;
    const r = await restoreByosubForAgents({
      agentIds: ["octogee-a-coach"],
      byosub: undefined,
      openclawDir: oc,
      fetchSecret: async () => {
        fetched = true;
        return "x";
      },
    });
    expect(r).toEqual({ restored: 0, failed: 0, skipped: 0, planned: 0 });
    expect(fetched).toBe(false);
  });

  it("plans + restores the per-agent codex-home for a present oauth agent", async () => {
    const oc = mkTmp();
    const r = await restoreByosubForAgents({
      agentIds: ["octogee-tester-70-coach"],
      byosub: {
        "octogee-tester-70-coach": { provider: "openai", secretName: "byosub-uid-openai" },
      },
      openclawDir: oc,
      fetchSecret: async () => codexBlob(),
    });
    expect(r).toEqual({ restored: 1, failed: 0, skipped: 0, planned: 1 });
    expect(
      JSON.parse(fs.readFileSync(codexAuthJsonPath(oc, "octogee-tester-70-coach"), "utf-8"))
        .auth_mode,
    ).toBe("chatgpt");

    const store = apReadFor(oc, "octogee-tester-70-coach") as {
      profiles: Record<string, { provider?: string }>;
    };
    expect(store.profiles["openai-codex:default"].provider).toBe("openai-codex");
  });

  it("never throws on a bad secret — {failed:1, planned:1}", async () => {
    const oc = mkTmp();
    const r = await restoreByosubForAgents({
      agentIds: ["octogee-tester-70-coach"],
      byosub: {
        "octogee-tester-70-coach": { provider: "openai", secretName: "boom" },
      },
      openclawDir: oc,
      fetchSecret: async () => {
        throw new Error("secret denied");
      },
    });
    expect(r).toEqual({ restored: 0, failed: 1, skipped: 0, planned: 1 });
  });
});
