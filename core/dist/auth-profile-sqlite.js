import * as fs from "fs";
import * as path from "path";
import { DatabaseSync } from "node:sqlite";
/**
 * SQLite persistence helpers for openclaw v2026.6.5+ auth-profile storage.
 *
 * Upstream moved auth-profiles.json / auth-state.json into a single
 * {agentDir}/openclaw-agent.sqlite database with two singleton-row KV tables
 * (auth_profile_store, auth_profile_state). Our BYOS injection model writes
 * the store row directly; our BYOS health checks read it. The runtime
 * stays outside the gateway pod, so we use node:sqlite (same driver upstream
 * uses) rather than depending on openclaw's exported TypeScript API.
 *
 * OpenClaw solely owns creating that database. It is a versioned, ownership-
 * stamped 41-table agent store (PRAGMA user_version + a schema_meta row), and
 * only openclaw can produce one — the DDL is generated and moves every release.
 * These helpers therefore only ever UPDATE a database openclaw already made:
 * writing to an absent path throws AgentDatabaseNotInitializedError so the
 * caller retries on its next sweep, once the gateway has created the store.
 */
const AUTH_DB_FILE = "openclaw-agent.sqlite";
const PRIMARY_ROW_KEY = "primary";
// Mirror upstream openclaw-agent-db (`src/state/openclaw-agent-db.ts`).
// Dir 0700, DB + sidecars 0600 — secrets must not be readable by other
// processes on the gateway pod.
const AGENT_DIR_MODE = 0o700;
const DB_FILE_MODE = 0o600;
const DB_SIDECAR_SUFFIXES = ["", "-shm", "-wal"];
// Match upstream OPENCLAW_SQLITE_BUSY_TIMEOUT_MS (30s). With this set on
// every open, node:sqlite handles BUSY internally — our outer retry loop
// becomes belt-and-suspenders for edge cases where the connection itself
// fails to open (e.g. another process holding -shm during teardown).
const BUSY_TIMEOUT_MS = 30_000;
/**
 * Thrown when a write targets an agent dir openclaw has not initialized yet.
 *
 * Creating the file ourselves is what wedges the gateway: a bare
 * `CREATE TABLE IF NOT EXISTS auth_profile_*` leaves user_version 0 with
 * application tables present, which openclaw 2026.7.2+ classifies as a legacy
 * store awaiting the v16 media migration and refuses to boot behind.
 */
export class AgentDatabaseNotInitializedError extends Error {
    agentDir;
    constructor(agentDir) {
        super(`auth-profile-sqlite: ${resolveAuthDbPath(agentDir)} does not exist yet — ` +
            `openclaw creates the agent database at gateway startup; retry after it is up`);
        this.name = "AgentDatabaseNotInitializedError";
        this.agentDir = agentDir;
    }
}
const BUSY_RETRY_ATTEMPTS = 3;
const BUSY_RETRY_BACKOFF_MS = 50;
/** Resolves the SQLite database path that stores auth profiles for an agent dir. */
export function resolveAuthDbPath(agentDir) {
    return path.join(agentDir, AUTH_DB_FILE);
}
export const SHARED_MAIN_AGENT_ID = "main";
const SHARED_STORE_STATE_KEY = "authProfiles.store";
const SHARED_STATE_STATE_KEY = "authProfiles.state";
const SHARED_STORE_OWNERSHIP_KEY = "auth.sharedStore";
function sharedStateDbPath(agentDir) {
    const resolved = path.resolve(agentDir);
    const agentIdDir = path.dirname(resolved);
    const agentsDir = path.dirname(agentIdDir);
    if (path.basename(resolved) !== "agent" ||
        path.basename(agentIdDir) !== SHARED_MAIN_AGENT_ID ||
        path.basename(agentsDir) !== "agents") {
        return null;
    }
    const dbPath = path.join(path.dirname(agentsDir), "state", "openclaw.sqlite");
    if (!fs.existsSync(dbPath))
        return null;
    const db = openHardenedDatabase(dbPath, { readOnly: true });
    try {
        const row = db
            .prepare("SELECT value_json AS v FROM config_machine_state WHERE state_key = ?")
            .get(SHARED_STORE_OWNERSHIP_KEY);
        const ownership = parseJsonCell(row?.v);
        return ownership?.location === "state-db" ? dbPath : null;
    }
    finally {
        db.close();
    }
}
export function sharedAuthStoreUsable(openclawDir) {
    const mainDir = path.join(openclawDir, "agents", SHARED_MAIN_AGENT_ID, "agent");
    return sharedStateDbPath(mainDir) !== null || fs.existsSync(resolveAuthDbPath(mainDir));
}
function readSharedCell(dbPath, stateKey) {
    let db;
    try {
        db = openHardenedDatabase(dbPath, { readOnly: true });
    }
    catch {
        return null;
    }
    try {
        const row = db
            .prepare("SELECT value_json AS v FROM config_machine_state WHERE state_key = ?")
            .get(stateKey);
        return parseJsonCell(row?.v);
    }
    catch {
        return null;
    }
    finally {
        db.close();
    }
}
function parseJsonCell(raw) {
    if (typeof raw !== "string" || raw.length === 0)
        return null;
    // Tolerant by contract — a corrupt cell on one agent must not abort the
    // whole sweep. Mirrors upstream's `parseJsonCell` in
    // src/agents/auth-profiles/sqlite.ts which also returns null on parse error.
    try {
        return JSON.parse(raw);
    }
    catch {
        return null;
    }
}
function isSqliteBusyError(err) {
    const code = err?.code;
    return code === "SQLITE_BUSY" || code === "ERR_SQLITE_BUSY";
}
const SLEEP_BUFFER = new Int32Array(new SharedArrayBuffer(4));
function sleepSync(ms) {
    Atomics.wait(SLEEP_BUFFER, 0, 0, ms);
}
/**
 * Mirrors upstream openclaw-agent-db ensureOpenClawAgentDatabasePermissions —
 * tightens the dir + DB + sidecar modes after every open/write so the auth
 * DB can't end up world-readable when our restore path creates it before
 * OpenClaw boots.
 */
function ensureAuthDbPermissions(agentDir) {
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
function openHardenedDatabase(dbPath, opts = {}) {
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
function readJsonRow(agentDir, table, column, keyColumn) {
    const dbPath = resolveAuthDbPath(agentDir);
    if (!fs.existsSync(dbPath))
        return null;
    // Read path is tolerant — corrupt DB, missing table, bad JSON cell all
    // resolve to null so a single bad agent never aborts the cross-agent
    // sweeps (restore + codex-auth-health). Mirrors upstream's tolerant
    // readPersistedAuthProfileStoreRaw / StateRaw.
    let db;
    try {
        db = openHardenedDatabase(dbPath, { readOnly: true });
    }
    catch {
        return null;
    }
    try {
        const row = db
            .prepare(`SELECT ${column} AS v FROM ${table} WHERE ${keyColumn} = ?`)
            .get(PRIMARY_ROW_KEY);
        return parseJsonCell(row?.v);
    }
    catch {
        return null;
    }
    finally {
        db.close();
    }
}
/** Reads the raw persisted secrets-store payload, or null if absent. */
export function readAuthProfileStore(agentDir) {
    const shared = sharedStateDbPath(agentDir);
    if (shared)
        return readSharedCell(shared, SHARED_STORE_STATE_KEY);
    return readJsonRow(agentDir, "auth_profile_store", "store_json", "store_key");
}
/** Reads the raw persisted runtime-state payload, or null if absent. */
export function readAuthProfileState(agentDir) {
    const shared = sharedStateDbPath(agentDir);
    if (shared)
        return readSharedCell(shared, SHARED_STATE_STATE_KEY);
    return readJsonRow(agentDir, "auth_profile_state", "state_json", "state_key");
}
function withWriteRetry(dbPath, op, label) {
    let lastErr;
    for (let attempt = 0; attempt < BUSY_RETRY_ATTEMPTS; attempt++) {
        const db = openHardenedDatabase(dbPath);
        try {
            db.exec("BEGIN IMMEDIATE");
            try {
                op(db);
                db.exec("COMMIT");
                return;
            }
            catch (err) {
                try {
                    db.exec("ROLLBACK");
                }
                catch {
                    // ROLLBACK on a non-active transaction is harmless; rethrow the real cause
                }
                throw err;
            }
        }
        catch (err) {
            lastErr = err;
            if (!isSqliteBusyError(err))
                throw err;
            sleepSync(BUSY_RETRY_BACKOFF_MS * (attempt + 1));
        }
        finally {
            db.close();
        }
    }
    throw new Error(`auth-profile-sqlite: ${label} held busy after ${BUSY_RETRY_ATTEMPTS} attempts — ${lastErr?.message ?? "unknown"}`);
}
/**
 * Writes the auth-profile secrets-store row into the agent database openclaw
 * owns. Last-writer-wins on the singleton "primary" key. Throws
 * AgentDatabaseNotInitializedError when openclaw has not created the store yet.
 */
export function writeAuthProfileStore(agentDir, payload) {
    const shared = sharedStateDbPath(agentDir);
    if (shared) {
        const json = JSON.stringify(payload);
        withWriteRetry(shared, (db) => {
            const now = Date.now();
            db.prepare(`INSERT INTO config_machine_state (state_key, value_json, updated_at_ms)
           VALUES (?, ?, ?)
           ON CONFLICT(state_key) DO UPDATE SET
             value_json = excluded.value_json,
             updated_at_ms = excluded.updated_at_ms`).run(SHARED_STORE_STATE_KEY, json, now);
        }, "writeAuthProfileStore shared BEGIN IMMEDIATE");
        return;
    }
    const dbPath = resolveAuthDbPath(agentDir);
    if (!fs.existsSync(dbPath)) {
        throw new AgentDatabaseNotInitializedError(agentDir);
    }
    ensureAuthDbPermissions(agentDir);
    const json = JSON.stringify(payload);
    withWriteRetry(dbPath, (db) => {
        const now = Date.now();
        db.prepare(`INSERT INTO auth_profile_store (store_key, store_json, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(store_key) DO UPDATE SET
           store_json = excluded.store_json,
           updated_at = excluded.updated_at`).run(PRIMARY_ROW_KEY, json, now);
    }, "writeAuthProfileStore BEGIN IMMEDIATE");
    // Post-write re-harden — node:sqlite's WAL/SHM sidecars may have been
    // freshly created with the process umask. Same belt-and-suspenders
    // upstream does after every transaction.
    ensureAuthDbPermissions(agentDir);
}
/**
 * Deletes the auth-profile secrets-store row. Leaves the runtime-state row
 * intact (openclaw owns it). No-op when the database file does not exist.
 */
export function deleteAuthProfileStore(agentDir) {
    const shared = sharedStateDbPath(agentDir);
    if (shared) {
        withWriteRetry(shared, (db) => {
            db.prepare("DELETE FROM config_machine_state WHERE state_key = ?").run(SHARED_STORE_STATE_KEY);
        }, "deleteAuthProfileStore shared BEGIN IMMEDIATE");
        return;
    }
    const dbPath = resolveAuthDbPath(agentDir);
    if (!fs.existsSync(dbPath))
        return;
    withWriteRetry(dbPath, (db) => {
        db.prepare(`DELETE FROM auth_profile_store WHERE store_key = ?`).run(PRIMARY_ROW_KEY);
    }, "deleteAuthProfileStore BEGIN IMMEDIATE");
    ensureAuthDbPermissions(agentDir);
}
