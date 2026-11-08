import { createPlatformStatePool, platformDatabaseSettingsFromEnvironment } from "./connection.js";
import { migratePlatformState, type PlatformStateMigrationResult } from "./migrate.js";
import type { PlatformStateLogger } from "./session.js";

export interface PlatformStateMigrationRun {
  readonly applicationName: string;
  readonly logger: PlatformStateLogger;
  readonly environment?: Readonly<Record<string, string | undefined>>;
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
  try {
    return await migratePlatformState(pool, { deploymentTargetId, ...(runtimeRole ? { runtimeRole } : {}) });
  } finally {
    await pool.end();
  }
}
