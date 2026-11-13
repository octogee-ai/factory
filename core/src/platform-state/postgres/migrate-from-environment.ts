import pg from "pg";
import { createPlatformStatePool, platformDatabaseSettingsFromEnvironment } from "./connection.js";
import { assertPlatformDatabaseTarget } from "./deployment-target.js";
import { DEFAULT_PLATFORM_STATE_SCHEMA, migratePlatformState, type PlatformStateMigrationResult } from "./migrate.js";
import type { PlatformStateLogger } from "./session.js";

export interface PlatformStateMigrationRun {
  readonly applicationName: string;
  readonly logger: PlatformStateLogger;
  readonly environment?: Readonly<Record<string, string | undefined>>;
}

export async function assertPlatformCutoverImported(
  pool: pg.Pool,
  deploymentTargetId: string,
  sourceProject: string,
  schema = DEFAULT_PLATFORM_STATE_SCHEMA,
): Promise<void> {
  await assertPlatformDatabaseTarget(pool, deploymentTargetId, schema);
  const ledgerSchema = pg.escapeIdentifier(`${schema}_cutover`);
  try {
    const result = await pool.query(
      `SELECT 1 FROM ${ledgerSchema}.import_ledger
       WHERE singleton AND target_id = $1 AND source_project = $2 AND row_count > 0 AND completed_at > 0`,
      [deploymentTargetId, sourceProject],
    );
    if (result.rowCount === 1) return;
  } catch (error) {
    if ((error as { code?: string }).code !== "42P01") throw error;
  }
  throw new Error(`no completed platform state import for ${deploymentTargetId}`);
}

export async function migratePlatformStateFromEnvironment(
  run: PlatformStateMigrationRun,
): Promise<PlatformStateMigrationResult> {
  const environment = run.environment ?? process.env;
  const deploymentTargetId = environment.DEPLOYMENT_TARGET_ID;
  if (!deploymentTargetId) throw new Error("DEPLOYMENT_TARGET_ID is required to migrate the platform database");
  const pool = createPlatformStatePool(platformDatabaseSettingsFromEnvironment(environment), {
    applicationName: run.applicationName,
    logger: run.logger,
  });
  const runtimeRole = environment.PLATFORM_DB_RUNTIME_USER;
  const cutoverSourceProject = environment.PLATFORM_DB_CUTOVER_IMPORT_SOURCE_PROJECT;
  try {
    if (cutoverSourceProject) await assertPlatformCutoverImported(pool, deploymentTargetId, cutoverSourceProject);
    return await migratePlatformState(pool, { deploymentTargetId, ...(runtimeRole ? { runtimeRole } : {}) });
  } finally {
    await pool.end();
  }
}
