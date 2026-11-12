import pg from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";
import { assertPlatformDatabaseTarget } from "../deployment-target.js";
import { DEFAULT_PLATFORM_STATE_SCHEMA, migratePlatformState } from "../migrate.js";
import { platformStateStoreForDeploymentTarget } from "../store-from-environment.js";
import { dsn, newPool, newSchemaName } from "./fixtures/harness.js";

function databaseEnvironment(connectionString: string): Record<string, string> {
  const url = new URL(connectionString);
  return {
    PLATFORM_DB_HOST: url.hostname,
    PLATFORM_DB_PORT: url.port,
    PLATFORM_DB_NAME: url.pathname.slice(1),
    PLATFORM_DB_USER: decodeURIComponent(url.username),
    PLATFORM_DB_PASSWORD: decodeURIComponent(url.password),
    PLATFORM_DB_SSLMODE: "disable",
  };
}

describe.skipIf(!dsn)("platform database deployment target", () => {
  const cleanups: (() => Promise<void>)[] = [];

  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  });

  function isolated(schema = newSchemaName()): { pool: pg.Pool; schema: string } {
    const pool = newPool();
    cleanups.push(async () => {
      await pool.query(`DROP SCHEMA IF EXISTS ${pg.escapeIdentifier(schema)} CASCADE`);
      await pool.end();
    });
    return { pool, schema };
  }

  async function recordedTarget(pool: pg.Pool, schema: string): Promise<string[]> {
    const { rows } = await pool.query<{ target_id: string }>(
      `SELECT target_id FROM ${pg.escapeIdentifier(schema)}.platform_deployment_target`,
    );
    return rows.map((row) => row.target_id);
  }

  it("binds the database to the target that first migrates it and accepts that target again", async () => {
    const { pool, schema } = isolated();
    await migratePlatformState(pool, { schema, deploymentTargetId: "test-central" });
    await migratePlatformState(pool, { schema, deploymentTargetId: "test-central" });
    expect(await recordedTarget(pool, schema)).toEqual(["test-central"]);
    await expect(assertPlatformDatabaseTarget(pool, "test-central", schema)).resolves.toBeUndefined();
  });

  it("refuses to migrate a database bound to another target and keeps its binding", async () => {
    const { pool, schema } = isolated();
    await migratePlatformState(pool, { schema, deploymentTargetId: "prod-central" });
    await expect(migratePlatformState(pool, { schema, deploymentTargetId: "test-central" })).rejects.toThrow(
      'platform database belongs to deployment target "prod-central", not "test-central"',
    );
    expect(await recordedTarget(pool, schema)).toEqual(["prod-central"]);
  });

  it("rejects a connection to a database bound to another target", async () => {
    const { pool, schema } = isolated();
    await migratePlatformState(pool, { schema, deploymentTargetId: "prod-central" });
    await expect(assertPlatformDatabaseTarget(pool, "test-central", schema)).rejects.toThrow(
      'platform database belongs to deployment target "prod-central", not "test-central"',
    );
  });

  it("rejects a database no migration has bound to a target", async () => {
    const { pool, schema } = isolated();
    await migratePlatformState(pool, { schema });
    await expect(assertPlatformDatabaseTarget(pool, "test-central", schema)).rejects.toThrow(
      'platform database has no deployment target; expected "test-central"',
    );
  });

  it("allows only one binding per database", async () => {
    const { pool, schema } = isolated();
    await migratePlatformState(pool, { schema, deploymentTargetId: "test-central" });
    await expect(
      pool.query(`INSERT INTO ${pg.escapeIdentifier(schema)}.platform_deployment_target (singleton, target_id) VALUES (false, 'other')`),
    ).rejects.toThrow(/check constraint/);
  });

  it("gives a TEST command no store when its settings reach another target's database", async () => {
    const { pool, schema } = isolated(DEFAULT_PLATFORM_STATE_SCHEMA);
    await migratePlatformState(pool, { schema, deploymentTargetId: "prod-central" });
    await expect(platformStateStoreForDeploymentTarget({
      applicationName: "deployment-target-test",
      logger: { warn: vi.fn(), error: vi.fn() },
      environment: databaseEnvironment(dsn as string),
      deploymentTargetId: "test-central",
    })).rejects.toThrow('platform database belongs to deployment target "prod-central", not "test-central"');
  });

  it("opens the store when the settings reach the selected target's database", async () => {
    const { pool, schema } = isolated(DEFAULT_PLATFORM_STATE_SCHEMA);
    await migratePlatformState(pool, { schema, deploymentTargetId: "test-central" });
    const store = await platformStateStoreForDeploymentTarget({
      applicationName: "deployment-target-test",
      logger: { warn: vi.fn(), error: vi.fn() },
      environment: databaseEnvironment(dsn as string),
      deploymentTargetId: "test-central",
    });
    try {
      await expect(store.users.records.get("no-such-user")).resolves.toBeNull();
    } finally {
      await store.close();
    }
  });
});
