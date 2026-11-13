import { createPlatformStatePool, platformDatabaseSettingsFromEnvironment } from "./connection.js";
import { assertPlatformDatabaseTarget } from "./deployment-target.js";
import { DEFAULT_PLATFORM_STATE_SCHEMA } from "./migrate.js";
import { createPostgresPlatformStateStore } from "./store.js";
function poolFromEnvironment(selection, environment) {
    return createPlatformStatePool(platformDatabaseSettingsFromEnvironment(environment), {
        applicationName: selection.applicationName,
        logger: selection.logger,
    });
}
function storeOwningPool(pool, logger) {
    const store = createPostgresPlatformStateStore({ pool, logger });
    return {
        ...store,
        async close() {
            try {
                await store.close();
            }
            finally {
                await pool.end();
            }
        },
    };
}
export function platformStateStoreFromEnvironment(selection) {
    const environment = selection.environment ?? process.env;
    return storeOwningPool(poolFromEnvironment(selection, environment), selection.logger);
}
export async function platformStateStoreForDeploymentTarget(selection) {
    const environment = selection.environment ?? process.env;
    const pool = poolFromEnvironment(selection, environment);
    try {
        await assertPlatformDatabaseTarget(pool, selection.deploymentTargetId, DEFAULT_PLATFORM_STATE_SCHEMA);
    }
    catch (error) {
        await pool.end().catch((closeError) => {
            selection.logger.error("platform state pool close failed", { message: String(closeError) });
        });
        throw error;
    }
    return storeOwningPool(pool, selection.logger);
}
