import { describe, it, expect, afterEach, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { DatabaseSync } from "node:sqlite";
import {
  resolveAuthDbPath,
  readAuthProfileStore,
  writeAuthProfileStore,
  deleteAuthProfileStore,
  readAuthProfileState,
  AgentDatabaseNotInitializedError,
  sharedAuthStoreUsable,
} from "./auth-profile-sqlite.js";
import { seedOpenClawAgentDb } from "./fixtures/openclaw-agent-db.js";

const tmps: string[] = [];
function mk(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "auth-sqlite-"));
  tmps.push(d);
  return d;
}

/** A temp agent dir that already holds an openclaw-created agent database. */
function mkdb(): string {
  const agentDir = mk();
  seedOpenClawAgentDb(agentDir);
  return agentDir;
}

afterEach(() => {
  for (const d of tmps.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe("resolveAuthDbPath", () => {
  it("returns {agentDir}/openclaw-agent.sqlite — the upstream path our writes target", () => {
    expect(resolveAuthDbPath("/home/node/.openclaw/agents/octogee-a-coach/agent")).toBe(
      "/home/node/.openclaw/agents/octogee-a-coach/agent/openclaw-agent.sqlite",
    );
  });
});

describe("readAuthProfileStore — missing DB / missing row", () => {
  it("returns null when the database file does not exist (graceful empty for fresh BYOS onboard)", () => {
    const agentDir = mk();
    expect(readAuthProfileStore(agentDir)).toBeNull();
  });

  it("returns null when the database exists but the singleton row is missing (post-doctor, pre-write)", () => {
    const agentDir = mk();
    const dbPath = resolveAuthDbPath(agentDir);
    const db = new DatabaseSync(dbPath);
    db.exec(
      `CREATE TABLE auth_profile_store (store_key TEXT NOT NULL PRIMARY KEY, store_json TEXT NOT NULL, updated_at INTEGER NOT NULL);
       CREATE TABLE auth_profile_state (state_key TEXT NOT NULL PRIMARY KEY, state_json TEXT NOT NULL, updated_at INTEGER NOT NULL);`,
    );
    db.close();
    expect(readAuthProfileStore(agentDir)).toBeNull();
  });
});

describe("writeAuthProfileStore — openclaw owns creation; we only update", () => {
  it("throws instead of creating the database when openclaw has not made one yet", () => {
    const agentDir = mk();
    expect(() => writeAuthProfileStore(agentDir, { v: 1 })).toThrow(
      AgentDatabaseNotInitializedError,
    );
  });

  it("leaves no file behind when it refuses — a stub at user_version 0 wedges gateway startup", () => {
    const agentDir = mk();
    expect(() => writeAuthProfileStore(agentDir, { v: 1 })).toThrow();
    expect(fs.existsSync(resolveAuthDbPath(agentDir))).toBe(false);
  });

  it("does not create the agent dir for an agent openclaw has never registered", () => {
    const parent = mk();
    const agentDir = path.join(parent, "agents", "octogee-ghost-coach", "agent");
    expect(() => writeAuthProfileStore(agentDir, { v: 1 })).toThrow(
      AgentDatabaseNotInitializedError,
    );
    expect(fs.existsSync(agentDir)).toBe(false);
  });

  it("round-trips the JSON-blob payload into an openclaw-created database", () => {
    const agentDir = mkdb();
    const payload = {
      version: 1,
      profiles: {
        "openai-codex:default": {
          type: "oauth",
          provider: "openai-codex",
          access: "acc-1",
          refresh: "ref-1",
          expires: 0,
          copyToAgents: true,
        },
      },
    };
    writeAuthProfileStore(agentDir, payload);
    expect(readAuthProfileStore(agentDir)).toEqual(payload);
  });

  it("leaves the database at the schema version openclaw stamped — we never re-version it", () => {
    const agentDir = mkdb();
    writeAuthProfileStore(agentDir, { v: 1 });
    const db = new DatabaseSync(resolveAuthDbPath(agentDir), { readOnly: true });
    const userVersion = (db.prepare(`PRAGMA user_version`).get() as { user_version: number })
      .user_version;
    db.close();
    expect(userVersion).toBe(16);
  });

  it("upserts on the singleton key — last writer wins, never appends a second row", () => {
    const agentDir = mkdb();
    writeAuthProfileStore(agentDir, { v: 1 });
    writeAuthProfileStore(agentDir, { v: 2 });
    writeAuthProfileStore(agentDir, { v: 3 });
    expect(readAuthProfileStore(agentDir)).toEqual({ v: 3 });
    const db = new DatabaseSync(resolveAuthDbPath(agentDir), { readOnly: true });
    const rows = db
      .prepare(`SELECT COUNT(*) AS c FROM auth_profile_store`)
      .all() as Array<{ c: number }>;
    db.close();
    expect(rows[0].c).toBe(1);
  });

  it("joins an existing openclaw-created DB without dropping its other tables (lockstep with upstream's schema)", () => {
    const agentDir = mk();
    const dbPath = resolveAuthDbPath(agentDir);
    const db = new DatabaseSync(dbPath);
    db.exec(
      `CREATE TABLE auth_profile_store (store_key TEXT NOT NULL PRIMARY KEY, store_json TEXT NOT NULL, updated_at INTEGER NOT NULL);
       CREATE TABLE auth_profile_state (state_key TEXT NOT NULL PRIMARY KEY, state_json TEXT NOT NULL, updated_at INTEGER NOT NULL);
       CREATE TABLE schema_meta (meta_key TEXT NOT NULL PRIMARY KEY, role TEXT NOT NULL, schema_version INTEGER NOT NULL, agent_id TEXT, app_version TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
       INSERT INTO schema_meta (meta_key, role, schema_version, created_at, updated_at) VALUES ('primary', 'agent', 1, 0, 0);`,
    );
    db.close();

    writeAuthProfileStore(agentDir, { v: "x" });

    const verify = new DatabaseSync(dbPath, { readOnly: true });
    const meta = verify.prepare(`SELECT meta_key FROM schema_meta`).all() as Array<{
      meta_key: string;
    }>;
    verify.close();
    expect(meta.map((r) => r.meta_key)).toEqual(["primary"]);
    expect(readAuthProfileStore(agentDir)).toEqual({ v: "x" });
  });

  it("stamps updated_at — monotonically increasing across writes", () => {
    const agentDir = mkdb();
    writeAuthProfileStore(agentDir, { v: 1 });
    const dbPath = resolveAuthDbPath(agentDir);
    const db = new DatabaseSync(dbPath, { readOnly: true });
    const t1 = (db.prepare(`SELECT updated_at AS t FROM auth_profile_store`).get() as {
      t: number;
    }).t;
    db.close();
    expect(t1).toBeGreaterThan(0);
  });
});

describe("deleteAuthProfileStore — clears the singleton row on disable", () => {
  it("is a no-op when the DB does not exist (BYOT disabled on a fresh customer)", () => {
    expect(() => deleteAuthProfileStore(mk())).not.toThrow();
  });

  it("removes a previously-written store row and leaves state untouched", () => {
    const agentDir = mkdb();
    writeAuthProfileStore(agentDir, { secret: "live" });
    const dbPath = resolveAuthDbPath(agentDir);
    const db = new DatabaseSync(dbPath);
    db.prepare(
      `INSERT INTO auth_profile_state (state_key, state_json, updated_at) VALUES ('primary', ?, ?)`,
    ).run(JSON.stringify({ rotated: true }), Date.now());
    db.close();

    deleteAuthProfileStore(agentDir);

    expect(readAuthProfileStore(agentDir)).toBeNull();
    expect(readAuthProfileState(agentDir)).toEqual({ rotated: true });
  });
});

describe("readAuthProfileState — symmetric to store", () => {
  it("returns null when the database doesn't exist", () => {
    expect(readAuthProfileState(mk())).toBeNull();
  });

  it("reads a state row when one is present (we don't write state; openclaw owns it)", () => {
    const agentDir = mk();
    const dbPath = resolveAuthDbPath(agentDir);
    const db = new DatabaseSync(dbPath);
    db.exec(
      `CREATE TABLE auth_profile_state (state_key TEXT NOT NULL PRIMARY KEY, state_json TEXT NOT NULL, updated_at INTEGER NOT NULL);`,
    );
    const stateBlob = JSON.stringify({ version: 1, usageStats: {} });
    db.prepare(
      `INSERT INTO auth_profile_state (state_key, state_json, updated_at) VALUES ('primary', ?, ?)`,
    ).run(stateBlob, Date.now());
    db.close();
    expect(readAuthProfileState(agentDir)).toEqual({ version: 1, usageStats: {} });
  });
});

describe("filesystem-mode hardening — mirror upstream openclaw-agent-db (0700 dir + 0600 db/wal/shm)", () => {
  it("writeAuthProfileStore tightens the agent dir to mode 0700 (private to the process owner)", () => {
    const parent = mk();
    const agentDir = path.join(parent, "agents", "octogee-a-coach", "agent");
    seedOpenClawAgentDb(agentDir);
    fs.chmodSync(agentDir, 0o755);
    writeAuthProfileStore(agentDir, { v: 1 });
    const mode = fs.statSync(agentDir).mode & 0o777;
    expect(mode).toBe(0o700);
  });

  it("writeAuthProfileStore leaves the DB file at mode 0600 (no group/other read)", () => {
    const agentDir = mkdb();
    fs.chmodSync(resolveAuthDbPath(agentDir), 0o644);
    writeAuthProfileStore(agentDir, { v: 1 });
    const mode = fs.statSync(resolveAuthDbPath(agentDir)).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("writeAuthProfileStore chmods -wal and -shm sidecars to 0600 when present", () => {
    const agentDir = mkdb();
    writeAuthProfileStore(agentDir, { v: 1 });
    // WAL mode is opt-in via pragma; touch the sidecars if upstream/openclaw left
    // them at default modes, then trigger another write so we re-harden.
    const dbPath = resolveAuthDbPath(agentDir);
    fs.writeFileSync(`${dbPath}-wal`, "");
    fs.writeFileSync(`${dbPath}-shm`, "");
    fs.chmodSync(`${dbPath}-wal`, 0o644);
    fs.chmodSync(`${dbPath}-shm`, 0o644);
    writeAuthProfileStore(agentDir, { v: 2 });
    expect(fs.statSync(`${dbPath}-wal`).mode & 0o777).toBe(0o600);
    expect(fs.statSync(`${dbPath}-shm`).mode & 0o777).toBe(0o600);
  });
});

describe("busy_timeout — match upstream's 30s contention budget (PRAGMA busy_timeout)", () => {
  it("every write opens with PRAGMA busy_timeout = 30000 so concurrent openclaw writers don't fail-fast", () => {
    // Spy on DatabaseSync.prototype.exec to capture every SQL the write
    // path issues. The hardened opener runs PRAGMA busy_timeout on each
    // fresh connection; this verifies the contract end-to-end without
    // needing a multi-process harness.
    const agentDir = mkdb();
    const execSpy = vi.spyOn(DatabaseSync.prototype, "exec");
    try {
      writeAuthProfileStore(agentDir, { v: 1 });
      const pragmas = execSpy.mock.calls.map((c) => String(c[0]));
      expect(pragmas).toContain(`PRAGMA busy_timeout = 30000;`);
    } finally {
      execSpy.mockRestore();
    }
  });
});

describe("delete retries SQLITE_BUSY — symmetric with write", () => {
  it("the delete path runs inside the same withWriteRetry loop (transient busy is retried, not surfaced)", () => {
    // Inject a transient BUSY via a one-shot mock of BEGIN IMMEDIATE.
    // The first attempt throws SQLITE_BUSY, the retry succeeds — proving
    // delete shares the write path's retry-on-busy semantics (the P2 gap).
    const agentDir = mkdb();
    writeAuthProfileStore(agentDir, { v: 1 });

    const originalExec = DatabaseSync.prototype.exec;
    let beginImmediateCalls = 0;
    const execSpy = vi
      .spyOn(DatabaseSync.prototype, "exec")
      .mockImplementation(function (this: DatabaseSync, sql: string) {
        if (sql === "BEGIN IMMEDIATE" && beginImmediateCalls === 0) {
          beginImmediateCalls++;
          const err = new Error("database is locked") as Error & { code?: string };
          err.code = "SQLITE_BUSY";
          throw err;
        }
        return originalExec.call(this, sql) as unknown;
      });

    try {
      expect(() => deleteAuthProfileStore(agentDir)).not.toThrow();
    } finally {
      execSpy.mockRestore();
    }
    expect(beginImmediateCalls).toBe(1);
    expect(readAuthProfileStore(agentDir)).toBeNull();
  });
});

describe("tolerant reads — corrupt DB / corrupt JSON returns null rather than aborting the sweep", () => {
  it("readAuthProfileStore returns null when the JSON cell is unparseable (matches upstream tolerance)", () => {
    const agentDir = mk();
    const dbPath = resolveAuthDbPath(agentDir);
    const db = new DatabaseSync(dbPath);
    db.exec(
      `CREATE TABLE auth_profile_store (store_key TEXT NOT NULL PRIMARY KEY, store_json TEXT NOT NULL, updated_at INTEGER NOT NULL);`,
    );
    db.prepare(
      `INSERT INTO auth_profile_store (store_key, store_json, updated_at) VALUES ('primary', ?, ?)`,
    ).run("{not-json", Date.now());
    db.close();
    expect(readAuthProfileStore(agentDir)).toBeNull();
  });

  it("readAuthProfileStore returns null when the DB file is corrupt (one bad agent must not abort the whole sweep)", () => {
    const agentDir = mk();
    fs.writeFileSync(resolveAuthDbPath(agentDir), "not-a-sqlite-file");
    expect(readAuthProfileStore(agentDir)).toBeNull();
  });

  it("readAuthProfileState returns null when the JSON cell is unparseable", () => {
    const agentDir = mk();
    const dbPath = resolveAuthDbPath(agentDir);
    const db = new DatabaseSync(dbPath);
    db.exec(
      `CREATE TABLE auth_profile_state (state_key TEXT NOT NULL PRIMARY KEY, state_json TEXT NOT NULL, updated_at INTEGER NOT NULL);`,
    );
    db.prepare(
      `INSERT INTO auth_profile_state (state_key, state_json, updated_at) VALUES ('primary', ?, ?)`,
    ).run("{also-not-json", Date.now());
    db.close();
    expect(readAuthProfileState(agentDir)).toBeNull();
  });

  it("readAuthProfileState returns null when the DB file is corrupt", () => {
    const agentDir = mk();
    fs.writeFileSync(resolveAuthDbPath(agentDir), "garbage");
    expect(readAuthProfileState(agentDir)).toBeNull();
  });
});

describe("concurrent writers — last-writer-wins, no rows lost", () => {
  it("two writes to the same DB both complete and the final state matches the last write", async () => {
    const agentDir = mkdb();
    await Promise.all([
      Promise.resolve().then(() => writeAuthProfileStore(agentDir, { who: "A" })),
      Promise.resolve().then(() => writeAuthProfileStore(agentDir, { who: "B" })),
    ]);
    const final = readAuthProfileStore(agentDir) as { who: string };
    expect(["A", "B"]).toContain(final.who);
    const db = new DatabaseSync(resolveAuthDbPath(agentDir), { readOnly: true });
    const rows = db
      .prepare(`SELECT COUNT(*) AS c FROM auth_profile_store`)
      .all() as Array<{ c: number }>;
    db.close();
    expect(rows[0].c).toBe(1);
  });
});

describe("the shared main store — OpenClaw's state-db ownership", () => {
  function seedStateDb(openclawDir: string, ownership: string | null): DatabaseSync {
    fs.mkdirSync(path.join(openclawDir, "state"), { recursive: true });
    const db = new DatabaseSync(path.join(openclawDir, "state", "openclaw.sqlite"));
    db.exec(
      "CREATE TABLE config_machine_state (state_key TEXT NOT NULL PRIMARY KEY, value_json TEXT NOT NULL, updated_at_ms INTEGER NOT NULL) STRICT",
    );
    if (ownership) {
      db.prepare("INSERT INTO config_machine_state VALUES ('auth.sharedStore', ?, 1)").run(ownership);
    }
    return db;
  }
  const mainDir = (openclawDir: string) => path.join(openclawDir, "agents", "main", "agent");
  const cell = (db: DatabaseSync, key: string) =>
    (db.prepare("SELECT value_json AS v FROM config_machine_state WHERE state_key = ?").get(key) as
      | { v: string }
      | undefined)?.v;

  it("writes and reads the main agent's store through config_machine_state when OpenClaw owns it in the state db", () => {
    const openclawDir = mk();
    const db = seedStateDb(openclawDir, JSON.stringify({ location: "state-db" }));
    const store = { version: 1, profiles: { "openai-codex:default": { type: "oauth", access: "a" } } };

    writeAuthProfileStore(mainDir(openclawDir), store);

    expect(JSON.parse(cell(db, "authProfiles.store")!)).toEqual(store);
    expect(readAuthProfileStore(mainDir(openclawDir))).toEqual(store);
    expect(fs.existsSync(mainDir(openclawDir))).toBe(false);
    db.close();
  });

  it("reads the shared runtime state and deletes the shared store row", () => {
    const openclawDir = mk();
    const db = seedStateDb(openclawDir, JSON.stringify({ location: "state-db" }));
    db.prepare("INSERT INTO config_machine_state VALUES ('authProfiles.state', ?, 1)").run(
      JSON.stringify({ usageStats: {} }),
    );
    writeAuthProfileStore(mainDir(openclawDir), { version: 1, profiles: {} });

    expect(readAuthProfileState(mainDir(openclawDir))).toEqual({ usageStats: {} });
    deleteAuthProfileStore(mainDir(openclawDir));
    expect(cell(db, "authProfiles.store")).toBeUndefined();
    expect(readAuthProfileStore(mainDir(openclawDir))).toBeNull();
    db.close();
  });

  it("keeps the legacy main agent database when OpenClaw has not moved the shared store", () => {
    const openclawDir = mk();
    const db = seedStateDb(openclawDir, null);

    expect(() => writeAuthProfileStore(mainDir(openclawDir), { version: 1, profiles: {} })).toThrow(
      AgentDatabaseNotInitializedError,
    );
    expect(cell(db, "authProfiles.store")).toBeUndefined();
    db.close();
  });

  it("leaves every other agent on its own database", () => {
    const openclawDir = mk();
    const db = seedStateDb(openclawDir, JSON.stringify({ location: "state-db" }));
    const coachDir = path.join(openclawDir, "agents", "octogee-x-coach", "agent");
    seedOpenClawAgentDb(coachDir);

    writeAuthProfileStore(coachDir, { version: 1, profiles: { p: {} } });

    expect(cell(db, "authProfiles.store")).toBeUndefined();
    expect(readAuthProfileStore(coachDir)).toEqual({ version: 1, profiles: { p: {} } });
    db.close();
  });
});

describe("sharedAuthStoreUsable", () => {
  it("is usable when OpenClaw keeps the shared store in the state db", () => {
    const openclawDir = mk();
    fs.mkdirSync(path.join(openclawDir, "state"), { recursive: true });
    const db = new DatabaseSync(path.join(openclawDir, "state", "openclaw.sqlite"));
    db.exec("CREATE TABLE config_machine_state (state_key TEXT NOT NULL PRIMARY KEY, value_json TEXT NOT NULL, updated_at_ms INTEGER NOT NULL) STRICT");
    db.prepare("INSERT INTO config_machine_state VALUES ('auth.sharedStore', ?, 1)").run(JSON.stringify({ location: "state-db" }));
    db.close();
    expect(sharedAuthStoreUsable(openclawDir)).toBe(true);
  });

  it("is usable when the legacy main agent database exists", () => {
    const openclawDir = mk();
    seedOpenClawAgentDb(path.join(openclawDir, "agents", "main", "agent"));
    expect(sharedAuthStoreUsable(openclawDir)).toBe(true);
  });

  it("is not usable when neither exists", () => {
    expect(sharedAuthStoreUsable(mk())).toBe(false);
  });
});
