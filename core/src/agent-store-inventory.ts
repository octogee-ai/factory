import * as fs from "node:fs/promises";
import * as path from "node:path";
const SQLITE_SUFFIX = ".sqlite";
const SQLITE_VOLATILE_SIDECAR_SUFFIX = /(?:-wal|-shm|-journal)$/iu;
const SQLITE_VOLATILE_LOCK_SHAPE = /\.sqlite\.(?:generation-lock|generation-writer|reindex-lock)\.sqlite$/iu;
const SQLITE_VOLATILE_TEMP_SHAPE = /\.sqlite\.(?:backup|memory-reindex|tmp)-[0-9a-f-]{36}$/iu;
const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

export function isSqliteVolatileArtifactPath(candidate: string): boolean {
  const base = candidate.replace(SQLITE_VOLATILE_SIDECAR_SUFFIX, "");
  if (SQLITE_VOLATILE_LOCK_SHAPE.test(base)) return true;
  return SQLITE_VOLATILE_TEMP_SHAPE.test(base) && UUID_SHAPE.test(base.slice(-36));
}

export function isSqliteStorePath(candidate: string): boolean {
  return candidate.endsWith(SQLITE_SUFFIX) && !isSqliteVolatileArtifactPath(candidate);
}

export async function listSqliteStores(root: string): Promise<string[]> {
  const stat = await fs.stat(root).catch(() => null);
  if (!stat) return [];
  if (stat.isFile()) return isSqliteStorePath(root) ? [root] : [];
  if (!stat.isDirectory()) return [];
  const stores: string[] = [];
  await collectSqliteStores(root, stores);
  return stores.sort();
}

async function collectSqliteStores(dir: string, stores: string[]): Promise<void> {
  for (const dirent of await fs.readdir(dir, { withFileTypes: true })) {
    const abs = path.join(dir, dirent.name);
    if (dirent.isDirectory()) {
      await collectSqliteStores(abs, stores);
      continue;
    }
    if (dirent.isFile() && isSqliteStorePath(dirent.name)) stores.push(abs);
  }
}


export function isCodexDatabase(relative: string): boolean {
  const parts = relative.split("/");
  return parts.length === 5 && parts[0] === "agents" && !!parts[1] && parts[2] === "agent" && parts[3] === "codex-home" &&
    /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,100}\.sqlite$/u.test(parts[4]!) && parts[4] !== "openclaw-agent.sqlite";
}
