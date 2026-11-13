import * as fs from "fs";
import * as path from "path";
import { DatabaseSync } from "node:sqlite";

/**
 * The agent store openclaw creates at gateway startup, reduced to what our
 * auth-profile writes touch: the two singleton KV tables plus the ownership
 * stamp (PRAGMA user_version + the schema_meta row).
 *
 * Fixtures must carry that stamp. An agent database without it is the exact
 * shape openclaw 2026.7.2+ refuses to boot behind, so a bare temp dir would
 * let a test pass against state the gateway rejects.
 */
export const OPENCLAW_AGENT_SCHEMA_VERSION = 16;

export function seedOpenClawAgentDb(
  agentDir: string,
  opts: { agentId?: string } = {},
): string {
  fs.mkdirSync(agentDir, { recursive: true });
  const dbPath = path.join(agentDir, "openclaw-agent.sqlite");
  const db = new DatabaseSync(dbPath);
  try {
    db.exec(
      `CREATE TABLE IF NOT EXISTS auth_profile_store (store_key TEXT NOT NULL PRIMARY KEY, store_json TEXT NOT NULL, updated_at INTEGER NOT NULL);
       CREATE TABLE IF NOT EXISTS auth_profile_state (state_key TEXT NOT NULL PRIMARY KEY, state_json TEXT NOT NULL, updated_at INTEGER NOT NULL);
       CREATE TABLE IF NOT EXISTS schema_meta (meta_key TEXT NOT NULL PRIMARY KEY, role TEXT NOT NULL, schema_version INTEGER NOT NULL, agent_id TEXT, app_version TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
       PRAGMA user_version = ${OPENCLAW_AGENT_SCHEMA_VERSION};`,
    );
    db.prepare(
      `INSERT INTO schema_meta (meta_key, role, schema_version, agent_id, created_at, updated_at)
       VALUES ('primary', 'agent', ?, ?, 0, 0)
       ON CONFLICT(meta_key) DO NOTHING`,
    ).run(OPENCLAW_AGENT_SCHEMA_VERSION, opts.agentId ?? path.basename(path.dirname(agentDir)));
  } finally {
    db.close();
  }
  return dbPath;
}

/** Seeds `<agentsDir>/<agentId>/agent` the way the gateway lays it out. */
export function seedOpenClawAgentDbForId(agentsDir: string, agentId: string): string {
  return seedOpenClawAgentDb(path.join(agentsDir, agentId, "agent"), { agentId });
}
