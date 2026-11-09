import pg from "pg";
import { deploymentTargetSettings } from "../../deployment-environment.js";
import { createPlatformStatePool, platformDatabaseSettingsFromEnvironment } from "./connection.js";
import { assertPlatformDatabaseTarget } from "./deployment-target.js";
import { DEFAULT_PLATFORM_STATE_SCHEMA, migratePlatformState } from "./migrate.js";
export async function assertPlatformCutoverImported(pool, deploymentTargetId, schema = DEFAULT_PLATFORM_STATE_SCHEMA) {
    await assertPlatformDatabaseTarget(pool, deploymentTargetId, schema);
    const sourceProject = deploymentTargetSettings(deploymentTargetId).firebaseProjectId;
    const ledgerSchema = pg.escapeIdentifier(`${schema}_cutover`);
    try {
        const result = await pool.query(`SELECT 1 FROM ${ledgerSchema}.import_ledger
       WHERE singleton AND target_id = $1 AND source_project = $2 AND row_count > 0 AND completed_at > 0`, [deploymentTargetId, sourceProject]);
        if (result.rowCount === 1)
            return;
    }
    catch (error) {
        if (error.code !== "42P01")
            throw error;
    }
    throw new Error(`no completed platform state import for ${deploymentTargetId}`);
}
export async function migratePlatformStateFromEnvironment(run) {
    const environment = run.environment ?? process.env;
    const deploymentTargetId = environment.DEPLOYMENT_TARGET_ID;
    if (!deploymentTargetId)
        throw new Error("DEPLOYMENT_TARGET_ID is required to migrate the platform database");
    const pool = createPlatformStatePool(platformDatabaseSettingsFromEnvironment(environment), {
        applicationName: run.applicationName,
        logger: run.logger,
    });
    const runtimeRole = environment.PLATFORM_DB_RUNTIME_USER;
    try {
        if (environment.PLATFORM_DB_REQUIRE_CUTOVER_IMPORT === "true")
            await assertPlatformCutoverImported(pool, deploymentTargetId);
        return await migratePlatformState(pool, { deploymentTargetId, ...(runtimeRole ? { runtimeRole } : {}) });
    }
    finally {
        await pool.end();
    }
}
