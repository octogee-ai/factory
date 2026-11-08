import pg from "pg";
import { PLATFORM_STATE_MIGRATIONS } from "./migrations.js";

export const DEFAULT_PLATFORM_STATE_SCHEMA = "platform";

export interface MigratePlatformStateOptions {
  readonly schema?: string;
  readonly through?: number;
}

export interface PlatformStateMigrationResult {
  readonly applied: readonly number[];
  readonly version: number;
}

const LATEST_VERSION = PLATFORM_STATE_MIGRATIONS[PLATFORM_STATE_MIGRATIONS.length - 1].version;

function targetVersion(through: number | undefined): number {
  if (through === undefined) return LATEST_VERSION;
  if (!PLATFORM_STATE_MIGRATIONS.some((migration) => migration.version === through)) {
    throw new RangeError(`platform state has no migration version ${through}`);
  }
  return through;
}

export async function migratePlatformState(
  pool: pg.Pool,
  options: MigratePlatformStateOptions = {},
): Promise<PlatformStateMigrationResult> {
  const schema = options.schema ?? DEFAULT_PLATFORM_STATE_SCHEMA;
  const target = targetVersion(options.through);
  const identifier = pg.escapeIdentifier(schema);
  const client = await pool.connect();
  let broken: Error | undefined;
  const onConnectionError = (error: Error) => {
    broken = error;
  };
  client.on("error", onConnectionError);
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`octogee-platform-state-migrate:${schema}`]);
    await client.query(`CREATE SCHEMA IF NOT EXISTS ${identifier}`);
    await client.query(`SET LOCAL search_path TO ${identifier}`);
    await client.query(
      "CREATE TABLE IF NOT EXISTS platform_state_migrations (version integer PRIMARY KEY, name text NOT NULL, applied_at bigint NOT NULL)",
    );
    const existing = await client.query<{ version: number }>("SELECT version FROM platform_state_migrations");
    const done = new Set(existing.rows.map((row) => row.version));
    const applied: number[] = [];
    for (const migration of PLATFORM_STATE_MIGRATIONS) {
      if (migration.version > target || done.has(migration.version)) continue;
      await client.query(migration.sql);
      await client.query(
        "INSERT INTO platform_state_migrations (version, name, applied_at) VALUES ($1, $2, (extract(epoch FROM clock_timestamp()) * 1000)::bigint)",
        [migration.version, migration.name],
      );
      applied.push(migration.version);
    }
    await client.query("COMMIT");
    return { applied, version: Math.max(0, ...done, ...applied) };
  } catch (error) {
    if (broken === undefined) {
      try {
        await client.query("ROLLBACK");
      } catch (rollbackError) {
        broken = rollbackError instanceof Error ? rollbackError : new Error(String(rollbackError));
      }
    }
    throw error;
  } finally {
    client.off("error", onConnectionError);
    client.release(broken);
  }
}
