import * as fs from "fs";
import * as path from "path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";

/**
 * SQLite persistence helpers for openclaw v2026.6.5+ auth-profile storage.
 *
 * Upstream moved auth-profiles.json / auth-state.json into a single
 * {agentDir}/openclaw-agent.sqlite database with two singleton-row KV tables
 * (auth_profile_store, auth_profile_state). Our BYOS injection model writes
 * the store row directly; our codex-sync-back cron reads it. The runtime
 * stays outside the gateway pod, so we use node:sqlite (same driver upstream
 * uses) rather than depending on openclaw's exported TypeScript API.
 */

const AUTH_DB_FILE = "openclaw-agent.sqlite";
const PRIMARY_ROW_KEY = "primary";

// Mirror upstream openclaw-agent-db (`src/state/openclaw-agent-db.ts`).
// Dir 0700, DB + sidecars 0600 — secrets must not be readable by other
// processes on the gateway pod.
const AGENT_DIR_MODE = 0o700;
const DB_FILE_MODE = 0o600;
const DB_SIDECAR_SUFFIXES = ["", "-shm", "-wal"] as const;

// Match upstream OPENCLAW_SQLITE_BUSY_TIMEOUT_MS (30s). With this set on
// every open, node:sqlite handles BUSY internally — our outer retry loop
// becomes belt-and-suspenders for edge cases where the connection itself
// fails to open (e.g. another process holding -shm during teardown).
const BUSY_TIMEOUT_MS = 30_000;

const SCHEMA_DDL = `
  CREATE TABLE IF NOT EXISTS auth_profile_store (
    store_key TEXT NOT NULL PRIMARY KEY,
    store_json TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS auth_profile_state (
    state_key TEXT NOT NULL PRIMARY KEY,
    state_json TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );
`;

const BUSY_RETRY_ATTEMPTS = 3;
const BUSY_RETRY_BACKOFF_MS = 50;

/** Resolves the SQLite database path that stores auth profiles for an agent dir. */
export function resolveAuthDbPath(agentDir: string): string {
  return path.join(agentDir, AUTH_DB_FILE);
}

function parseJsonCell(raw: string | null | undefined): unknown {
  if (typeof raw !== "string" || raw.length === 0) return null;
  // Tolerant by contract — a corrupt cell on one agent must not abort the
  // whole sweep. Mirrors upstream's `parseJsonCell` in
  // src/agents/auth-profiles/sqlite.ts which also returns null on parse error.
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function isSqliteBusyError(err: unknown): boolean {
  const code = (err as { code?: string } | null)?.code;
  return code === "SQLITE_BUSY" || code === "ERR_SQLITE_BUSY";
}

const SLEEP_BUFFER = new Int32Array(new SharedArrayBuffer(4));
function sleepSync(ms: number): void {
  Atomics.wait(SLEEP_BUFFER, 0, 0, ms);
}

/**
 * Mirrors upstream openclaw-agent-db ensureOpenClawAgentDatabasePermissions —
 * tightens the dir + DB + sidecar modes after every open/write so the auth
 * DB can't end up world-readable when our restore path creates it before
 * OpenClaw boots.
 */
function ensureAuthDbPermissions(agentDir: string): void {
  fs.mkdirSync(agentDir, { recursive: true, mode: AGENT_DIR_MODE });
  fs.chmodSync(agentDir, AGENT_DIR_MODE);
  const dbPath = resolveAuthDbPath(agentDir);
  for (const suffix of DB_SIDECAR_SUFFIXES) {
    const candidate = `${dbPath}${suffix}`;
    if (fs.existsSync(candidate)) {
      fs.chmodSync(candidate, DB_FILE_MODE);
    }
  }
}

function openHardenedDatabase(dbPath: string, opts: { readOnly?: boolean } = {}): DatabaseSync {
  // node:sqlite's DatabaseSync rejects an explicit `undefined` second arg —
  // it must be omitted, or be an object. So we build the call shape with no
  // options when we want defaults.
  const db = opts.readOnly
    ? new DatabaseSync(dbPath, { readOnly: true })
    : new DatabaseSync(dbPath);
  // PRAGMA busy_timeout is per-connection; set on every open. Symmetrical
  // with upstream openclaw-agent-db's PRAGMA on every connection.
  db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS};`);
  return db;
}

function readJsonRow(
  agentDir: string,
  table: "auth_profile_store" | "auth_profile_state",
  column: "store_json" | "state_json",
  keyColumn: "store_key" | "state_key",
): unknown {
  const dbPath = resolveAuthDbPath(agentDir);
  if (!fs.existsSync(dbPath)) return null;
  // Read path is tolerant — corrupt DB, missing table, bad JSON cell all
  // resolve to null so a single bad agent never aborts the cross-agent
  // sweeps (restore + codex-auth-health). Mirrors upstream's tolerant
  // readPersistedAuthProfileStoreRaw / StateRaw.
  let db: DatabaseSync;
  try {
    db = openHardenedDatabase(dbPath, { readOnly: true });
  } catch {
    return null;
  }
  try {
    const row = db
      .prepare(`SELECT ${column} AS v FROM ${table} WHERE ${keyColumn} = ?`)
      .get(PRIMARY_ROW_KEY) as { v: string } | undefined;
    return parseJsonCell(row?.v);
  } catch {
    return null;
  } finally {
    db.close();
  }
}

/** Reads the raw persisted secrets-store payload, or null if absent. */
export function readAuthProfileStore(agentDir: string): unknown | null {
  return readJsonRow(agentDir, "auth_profile_store", "store_json", "store_key");
}

/** Reads the raw persisted runtime-state payload, or null if absent. */
export function readAuthProfileState(agentDir: string): unknown | null {
  return readJsonRow(agentDir, "auth_profile_state", "state_json", "state_key");
}

type WriteOp = (db: DatabaseSync) => void;

function withWriteRetry(dbPath: string, op: WriteOp, label: string): void {
  let lastErr: unknown;
  for (let attempt = 0; attempt < BUSY_RETRY_ATTEMPTS; attempt++) {
    const db = openHardenedDatabase(dbPath);
    try {
      db.exec(SCHEMA_DDL);
      db.exec("BEGIN IMMEDIATE");
      try {
        op(db);
        db.exec("COMMIT");
        return;
      } catch (err) {
        try {
          db.exec("ROLLBACK");
        } catch {
          // ROLLBACK on a non-active transaction is harmless; rethrow the real cause
        }
        throw err;
      }
    } catch (err) {
      lastErr = err;
      if (!isSqliteBusyError(err)) throw err;
      sleepSync(BUSY_RETRY_BACKOFF_MS * (attempt + 1));
    } finally {
      db.close();
    }
  }
  throw new Error(
    `auth-profile-sqlite: ${label} held busy after ${BUSY_RETRY_ATTEMPTS} attempts — ${
      (lastErr as Error | undefined)?.message ?? "unknown"
    }`,
  );
}

/**
 * Writes the auth-profile secrets-store row, bootstrapping the DB + schema
 * on first call. Last-writer-wins on the singleton "primary" key.
 */
export function writeAuthProfileStore(agentDir: string, payload: unknown): void {
  ensureAuthDbPermissions(agentDir);
  const dbPath = resolveAuthDbPath(agentDir);
  const json = JSON.stringify(payload);
  withWriteRetry(
    dbPath,
    (db) => {
      const now: SQLInputValue = Date.now();
      db.prepare(
        `INSERT INTO auth_profile_store (store_key, store_json, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(store_key) DO UPDATE SET
           store_json = excluded.store_json,
           updated_at = excluded.updated_at`,
      ).run(PRIMARY_ROW_KEY, json, now);
    },
    "writeAuthProfileStore BEGIN IMMEDIATE",
  );
  // Post-write re-harden — node:sqlite's WAL/SHM sidecars may have been
  // freshly created with the process umask. Same belt-and-suspenders
  // upstream does after every transaction.
  ensureAuthDbPermissions(agentDir);
}

/**
 * Deletes the auth-profile secrets-store row. Leaves the runtime-state row
 * intact (openclaw owns it). No-op when the database file does not exist.
 */
export function deleteAuthProfileStore(agentDir: string): void {
  const dbPath = resolveAuthDbPath(agentDir);
  if (!fs.existsSync(dbPath)) return;
  withWriteRetry(
    dbPath,
    (db) => {
      db.prepare(`DELETE FROM auth_profile_store WHERE store_key = ?`).run(
        PRIMARY_ROW_KEY,
      );
    },
    "deleteAuthProfileStore BEGIN IMMEDIATE",
  );
  ensureAuthDbPermissions(agentDir);
}
