import * as fs from "node:fs/promises";
import * as path from "node:path";
const SQLITE_SUFFIX = ".sqlite";
const SQLITE_VOLATILE_SIDECAR_SUFFIX = /(?:-wal|-shm|-journal)$/iu;
const SQLITE_VOLATILE_LOCK_SHAPE = /\.sqlite\.(?:generation-lock|generation-writer|reindex-lock)\.sqlite$/iu;
const SQLITE_VOLATILE_TEMP_SHAPE = /\.sqlite\.(?:backup|memory-reindex|tmp)-[0-9a-f-]{36}$/iu;
const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const DOCTOR_MIGRATION_BACKUP_DIR_SHAPE = /\.sqlite\.(?:pre-startup-migration-([0-9a-f-]{36})\.postgres|auth-profile-migration-([0-9a-f-]{36}))\.bak$/iu;
export function isDoctorMigrationBackupDir(name) {
    const match = DOCTOR_MIGRATION_BACKUP_DIR_SHAPE.exec(name);
    return match !== null && UUID_SHAPE.test((match[1] ?? match[2]));
}
export function isSqliteVolatileArtifactPath(candidate) {
    const base = candidate.replace(SQLITE_VOLATILE_SIDECAR_SUFFIX, "");
    if (SQLITE_VOLATILE_LOCK_SHAPE.test(base))
        return true;
    return SQLITE_VOLATILE_TEMP_SHAPE.test(base) && UUID_SHAPE.test(base.slice(-36));
}
export function isSqliteStorePath(candidate) {
    return candidate.endsWith(SQLITE_SUFFIX) && !isSqliteVolatileArtifactPath(candidate);
}
export async function listSqliteStores(root) {
    const stat = await fs.stat(root).catch(() => null);
    if (!stat)
        return [];
    if (stat.isFile())
        return isSqliteStorePath(root) ? [root] : [];
    if (!stat.isDirectory())
        return [];
    const stores = [];
    await collectSqliteStores(root, stores);
    return stores.sort();
}
async function collectSqliteStores(dir, stores) {
    for (const dirent of await fs.readdir(dir, { withFileTypes: true })) {
        const abs = path.join(dir, dirent.name);
        if (dirent.isDirectory()) {
            if (!isDoctorMigrationBackupDir(dirent.name))
                await collectSqliteStores(abs, stores);
            continue;
        }
        if (dirent.isFile() && isSqliteStorePath(dirent.name))
            stores.push(abs);
    }
}
export function isCodexDatabase(relative) {
    const parts = relative.split("/");
    return parts.length === 5 && parts[0] === "agents" && !!parts[1] && parts[2] === "agent" && parts[3] === "codex-home" &&
        /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,100}\.sqlite$/u.test(parts[4]) && parts[4] !== "openclaw-agent.sqlite";
}
