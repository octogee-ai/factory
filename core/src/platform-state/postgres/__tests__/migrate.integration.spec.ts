import pg from "pg";
import { afterEach, describe, expect, it } from "vitest";
import { migratePlatformState } from "../migrate.js";
import { PLATFORM_STATE_MIGRATIONS } from "../migrations.js";
import { dsn, newPool, newSchemaName } from "./fixtures/harness.js";

const LATEST = PLATFORM_STATE_MIGRATIONS[PLATFORM_STATE_MIGRATIONS.length - 1].version;
const ALL_VERSIONS = PLATFORM_STATE_MIGRATIONS.map((migration) => migration.version);

describe.skipIf(!dsn)("migratePlatformState", () => {
  const cleanups: (() => Promise<void>)[] = [];

  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  });

  function isolated(): { pool: pg.Pool; schema: string } {
    const pool = newPool();
    const schema = newSchemaName();
    cleanups.push(async () => {
      await pool.query(`DROP SCHEMA IF EXISTS ${pg.escapeIdentifier(schema)} CASCADE`);
      await pool.end();
    });
    return { pool, schema };
  }

  async function tables(pool: pg.Pool, schema: string): Promise<string[]> {
    const { rows } = await pool.query<{ table_name: string }>(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = $1 ORDER BY table_name",
      [schema],
    );
    return rows.map((row) => row.table_name);
  }

  it("applies every migration once and records each in the migrations table", async () => {
    const { pool, schema } = isolated();

    const first = await migratePlatformState(pool, { schema });
    const second = await migratePlatformState(pool, { schema });

    expect(first).toEqual({ applied: ALL_VERSIONS, version: LATEST });
    expect(second).toEqual({ applied: [], version: LATEST });
    const { rows } = await pool.query(
      `SELECT version, name FROM ${pg.escapeIdentifier(schema)}.platform_state_migrations ORDER BY version`,
    );
    expect(rows).toEqual(PLATFORM_STATE_MIGRATIONS.map(({ version, name }) => ({ version, name })));
  });

  it("creates every platform table, the change log outbox, and its retention watermark", async () => {
    const { pool, schema } = isolated();

    await migratePlatformState(pool, { schema });

    const created = await tables(pool, schema);
    expect(created).toHaveLength(40);
    expect(created).toEqual(
      expect.arrayContaining([
        "operations",
        "operation_audits",
        "gateway_recovery_receipts",
        "gateways",
        "builders",
        "builder_agents",
        "agent_stores",
        "workspaces",
        "workspace_project_members",
        "gateway_tickets",
        "change_log",
        "change_log_retention",
        "platform_state_migrations",
      ]),
    );
    const { rows: triggers } = await pool.query(
      `SELECT count(*)::int AS count FROM information_schema.triggers WHERE trigger_schema = $1 AND trigger_name LIKE '%\\_change'`,
      [schema],
    );
    expect(triggers[0].count).toBeGreaterThan(0);
  });

  it("stops at the requested version and resumes from it", async () => {
    const { pool, schema } = isolated();

    const partial = await migratePlatformState(pool, { schema, through: 1 });
    expect(partial).toEqual({ applied: [1], version: 1 });
    expect(await tables(pool, schema)).not.toContain("change_log");

    const rest = await migratePlatformState(pool, { schema });
    expect(rest).toEqual({ applied: ALL_VERSIONS.slice(1), version: LATEST });
    expect(await tables(pool, schema)).toContain("change_log");
  });

  it("rejects an unknown target version without touching the database", async () => {
    const { pool, schema } = isolated();

    await expect(migratePlatformState(pool, { schema, through: 99 })).rejects.toThrow(RangeError);
    expect(await tables(pool, schema)).toEqual([]);
  });

  it("serializes concurrent migrators so the schema is applied exactly once", async () => {
    const { pool, schema } = isolated();

    const results = await Promise.all([
      migratePlatformState(pool, { schema }),
      migratePlatformState(pool, { schema }),
      migratePlatformState(pool, { schema }),
    ]);

    expect(results.map((result) => result.applied.length).sort()).toEqual([0, 0, ALL_VERSIONS.length]);
    expect(results.every((result) => result.version === LATEST)).toBe(true);
  });

  it("rolls back a failed migration so nothing half-applied is recorded", async () => {
    const { pool, schema } = isolated();
    await migratePlatformState(pool, { schema, through: 1 });
    await pool.query(`CREATE TABLE ${pg.escapeIdentifier(schema)}.change_log (blocker integer)`);

    await expect(migratePlatformState(pool, { schema })).rejects.toThrow(/change_log/);

    const { rows } = await pool.query(
      `SELECT version FROM ${pg.escapeIdentifier(schema)}.platform_state_migrations ORDER BY version`,
    );
    expect(rows).toEqual([{ version: 1 }]);
    const { rows: functions } = await pool.query(
      "SELECT count(*)::int AS count FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = $1 AND p.proname = 'record_change'",
      [schema],
    );
    expect(functions[0].count).toBe(0);
  });
});
