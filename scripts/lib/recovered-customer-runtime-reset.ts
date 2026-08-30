import * as fs from "node:fs";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { agentIdBelongsToSlug } from "../../shared/types/agent-models.js";
import { parseAgentId, workspaceCoachAgentId } from "../../shared/types/identity.js";

const AGENT_DB_FILE = "openclaw-agent.sqlite";
const DB_SIDECARS = ["", "-wal", "-shm"] as const;
const DURABLE_CONTENT_TABLES = [
  "transcript_events",
  "trajectory_runtime_events",
  "session_nodes",
  "session_windows",
  "conversations",
  "memory_index_chunks",
  "memory_index_sources",
  "standing_intents",
  "board_tabs",
  "board_widgets",
] as const;

export interface RecoveredCustomerRuntimeResetResult {
  removedAgentRegistrations: string[];
  removedAgentStores: string[];
  clearedWorkspaceAttestations: string[];
}

function expectedAgentIds(slug: string, agentIds: readonly string[]): string[] {
  const exact = new Set([workspaceCoachAgentId(slug)]);
  for (const agentId of agentIds) {
    if (!agentIdBelongsToSlug(agentId, slug)) {
      throw new Error(`runtime reset contains a foreign agent id: ${agentId}`);
    }
    exact.add(agentId);
  }
  return [...exact].sort();
}

function agentDatabasePath(openclawDir: string, agentId: string): string {
  return path.join(openclawDir, "agents", agentId, "agent", AGENT_DB_FILE);
}

function expectedWorkspacePath(openclawDir: string, slug: string, agentId: string): string {
  const parsed = parseAgentId(agentId);
  if (parsed.kind === "coach" && parsed.username === slug) {
    return path.join(openclawDir, "customers", slug);
  }
  if (parsed.kind === "project" && parsed.username === slug) {
    return path.join(openclawDir, "customers", slug, "projects", parsed.project);
  }
  throw new Error(`runtime reset cannot derive workspace for agent: ${agentId}`);
}

function userTables(database: DatabaseSync): Set<string> {
  const rows = database
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
    .all() as Array<{ name?: unknown }>;
  return new Set(rows.flatMap((row) => typeof row.name === "string" ? [row.name] : []));
}

function contentRows(database: DatabaseSync, tables: ReadonlySet<string>): number {
  let count = 0;
  for (const table of DURABLE_CONTENT_TABLES) {
    if (!tables.has(table)) continue;
    const row = database.prepare(`SELECT count(*) AS count FROM "${table}"`).get() as {
      count?: unknown;
    };
    if (typeof row.count !== "number") throw new Error(`invalid content count in ${table}`);
    count += row.count;
  }
  return count;
}

function agentStoreNeedsReset(databasePath: string): boolean {
  if (!fs.existsSync(databasePath)) return true;
  let database: DatabaseSync;
  try {
    database = new DatabaseSync(databasePath, { readOnly: true });
  } catch (error) {
    throw new Error(`customer agent store is unreadable: ${databasePath}`, { cause: error });
  }
  try {
    const integrity = database.prepare("PRAGMA integrity_check").get() as {
      integrity_check?: unknown;
    };
    if (integrity.integrity_check !== "ok") {
      throw new Error(`customer agent store failed integrity check: ${databasePath}`);
    }
    const tables = userTables(database);
    if (tables.has("auth_profile_store")) return false;
    if (contentRows(database, tables) > 0) {
      throw new Error(`customer agent store has durable content but no auth_profile_store: ${databasePath}`);
    }
    return true;
  } finally {
    database.close();
  }
}

function staleWorkspaceAttestation(workspacePath: string): boolean {
  let entries: string[];
  try {
    entries = fs.readdirSync(workspacePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
    throw error;
  }
  return entries.every((entry) => entry === ".git");
}

function assertStateTable(database: DatabaseSync, table: string): void {
  const row = database
    .prepare("SELECT type FROM sqlite_master WHERE name = ?")
    .get(table) as { type?: unknown } | undefined;
  if (row?.type !== "table") throw new Error(`OpenClaw state database is missing ${table}`);
}

function removeStoreFiles(databasePath: string): void {
  for (const suffix of DB_SIDECARS) fs.rmSync(`${databasePath}${suffix}`, { force: true });
}

function storedDatabasePath(openclawDir: string, storedPath: string): string {
  return path.resolve(path.isAbsolute(storedPath) ? storedPath : path.join(openclawDir, storedPath));
}

export function resetRecoveredCustomerRuntime(options: {
  openclawDir: string;
  uid: string;
  slug: string;
  agentIds: readonly string[];
  log?: (message: string) => void;
}): RecoveredCustomerRuntimeResetResult {
  if (!options.uid || !options.slug) throw new Error("runtime reset customer identity is required");
  const openclawDir = path.resolve(options.openclawDir);
  const agentIds = expectedAgentIds(options.slug, options.agentIds);
  const databasePaths = new Map(
    agentIds.map((agentId) => [agentId, path.resolve(agentDatabasePath(openclawDir, agentId))]),
  );
  const resetAgentIds = agentIds.filter((agentId) =>
    agentStoreNeedsReset(databasePaths.get(agentId)!),
  );
  const workspacePaths = new Map(
    agentIds.map((agentId) => [
      agentId,
      path.resolve(expectedWorkspacePath(openclawDir, options.slug, agentId)),
    ]),
  );
  const staleWorkspaces = new Set(
    [...workspacePaths.values()].filter(staleWorkspaceAttestation),
  );
  const stateDatabasePath = path.join(openclawDir, "state", "openclaw.sqlite");
  const result: RecoveredCustomerRuntimeResetResult = {
    removedAgentRegistrations: [],
    removedAgentStores: [],
    clearedWorkspaceAttestations: [],
  };

  if (fs.existsSync(stateDatabasePath)) {
    const state = new DatabaseSync(stateDatabasePath);
    try {
      state.exec("PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON");
      for (const table of [
        "agent_databases",
        "agent_database_leases",
        "workspace_setup_state",
        "workspace_path_aliases",
        "workspace_generated_bootstrap_hashes",
      ]) assertStateTable(state, table);

      const registryRows = state
        .prepare("SELECT agent_id, path FROM agent_databases")
        .all() as Array<{ agent_id?: unknown; path?: unknown }>;
      const resetSet = new Set(resetAgentIds);
      const removableRegistrations: Array<{ agentId: string; storedPath: string }> = [];
      for (const row of registryRows) {
        if (typeof row.agent_id !== "string" || !resetSet.has(row.agent_id)) continue;
        if (typeof row.path !== "string" || !row.path) {
          throw new Error(`invalid agent database registration for ${row.agent_id}`);
        }
        const expectedPath = databasePaths.get(row.agent_id)!;
        if (storedDatabasePath(openclawDir, row.path) !== expectedPath) {
          throw new Error(`unexpected agent database path for ${row.agent_id}`);
        }
        removableRegistrations.push({ agentId: row.agent_id, storedPath: row.path });
      }

      for (const agentId of resetAgentIds) {
        const lease = state
          .prepare("SELECT 1 FROM agent_database_leases WHERE agent_id = ? LIMIT 1")
          .get(agentId);
        if (lease) throw new Error(`customer agent database is actively leased: ${agentId}`);
      }

      const setupRows = state
        .prepare("SELECT workspace_key, workspace_path FROM workspace_setup_state")
        .all() as Array<{ workspace_key?: unknown; workspace_path?: unknown }>;
      const staleSetupRows = setupRows.flatMap((row) => {
        if (typeof row.workspace_key !== "string" || typeof row.workspace_path !== "string") return [];
        const resolvedPath = path.resolve(row.workspace_path);
        return staleWorkspaces.has(resolvedPath)
          ? [{ workspaceKey: row.workspace_key, workspacePath: resolvedPath }]
          : [];
      });

      state.exec("BEGIN IMMEDIATE");
      try {
        const removeRegistration = state.prepare(
          "DELETE FROM agent_databases WHERE agent_id = ? AND path = ?",
        );
        for (const row of removableRegistrations) {
          removeRegistration.run(row.agentId, row.storedPath);
        }
        const removeHashes = state.prepare(
          "DELETE FROM workspace_generated_bootstrap_hashes WHERE workspace_key = ?",
        );
        const removeAliases = state.prepare(
          "DELETE FROM workspace_path_aliases WHERE workspace_key = ? OR workspace_path = ?",
        );
        const removeSetup = state.prepare(
          "DELETE FROM workspace_setup_state WHERE workspace_key = ? AND workspace_path = ?",
        );
        for (const row of staleSetupRows) {
          removeHashes.run(row.workspaceKey);
          removeAliases.run(row.workspaceKey, row.workspacePath);
          removeSetup.run(row.workspaceKey, row.workspacePath);
        }
        state.exec("COMMIT");
      } catch (error) {
        state.exec("ROLLBACK");
        throw error;
      }
      result.removedAgentRegistrations = removableRegistrations.map((row) => row.agentId).sort();
      result.clearedWorkspaceAttestations = staleSetupRows
        .map((row) => row.workspacePath)
        .sort();
    } finally {
      state.close();
    }
  }

  for (const agentId of resetAgentIds) {
    const databasePath = databasePaths.get(agentId)!;
    removeStoreFiles(databasePath);
    result.removedAgentStores.push(agentId);
  }
  result.removedAgentStores.sort();
  options.log?.(
    `[runtime-reset:${options.slug}] reset ${result.removedAgentStores.length} agent store(s), ` +
      `${result.removedAgentRegistrations.length} registration(s), and ` +
      `${result.clearedWorkspaceAttestations.length} stale workspace attestation(s)`,
  );
  return result;
}
