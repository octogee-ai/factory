import type { PlatformStateStore } from "../store.js";
import type pg from "pg";
import { createPlatformStatePool, platformDatabaseSettingsFromEnvironment } from "./connection.js";
import { assertPlatformDatabaseTarget } from "./deployment-target.js";
import { DEFAULT_PLATFORM_STATE_SCHEMA } from "./migrate.js";
import type { PlatformStateLogger } from "./session.js";
import { createPostgresPlatformStateStore } from "./store.js";

export interface PlatformStateStoreSelection {
  readonly applicationName: string;
  readonly logger: PlatformStateLogger;
  readonly environment?: Readonly<Record<string, string | undefined>>;
}

export interface PlatformStateStoreTargetSelection extends PlatformStateStoreSelection {
  readonly deploymentTargetId: string;
}

function poolFromEnvironment(
  selection: PlatformStateStoreSelection,
  environment: Readonly<Record<string, string | undefined>>,
): pg.Pool {
  return createPlatformStatePool(platformDatabaseSettingsFromEnvironment(environment), {
    applicationName: selection.applicationName,
    logger: selection.logger,
  });
}

function storeOwningPool(pool: pg.Pool, logger: PlatformStateLogger): PlatformStateStore {
  const store = createPostgresPlatformStateStore({ pool, logger });
  return {
    ...store,
    async close() {
      try {
        await store.close();
      } finally {
        await pool.end();
      }
    },
  };
}

export function platformStateStoreFromEnvironment(selection: PlatformStateStoreSelection): PlatformStateStore {
  const environment = selection.environment ?? process.env;
  return storeOwningPool(poolFromEnvironment(selection, environment), selection.logger);
}

export async function platformStateStoreForDeploymentTarget(
  selection: PlatformStateStoreTargetSelection,
): Promise<PlatformStateStore> {
  const environment = selection.environment ?? process.env;
  const pool = poolFromEnvironment(selection, environment);
  try {
    await assertPlatformDatabaseTarget(pool, selection.deploymentTargetId, DEFAULT_PLATFORM_STATE_SCHEMA);
  } catch (error) {
    await pool.end().catch((closeError: unknown) => {
      selection.logger.error("platform state pool close failed", { message: String(closeError) });
    });
    throw error;
  }
  return storeOwningPool(pool, selection.logger);
}
