import { createServiceLogger } from "@octogee/shared/server/service-logger";
import { assertPlatformDatabaseTarget } from "./platform-state/postgres/deployment-target.js";
import { DEFAULT_PLATFORM_STATE_SCHEMA } from "./platform-state/postgres/migrate.js";
import {
  createPlatformStatePool,
  platformDatabaseSettingsFromEnvironment,
} from "./platform-state/postgres/connection.js";
import { createPostgresSecretStore, createSecretStoreKeyRing } from "./postgres-secret-store.js";
import * as secretManager from "./secret-manager.js";
import type { SecretStore, SecretWrite } from "./secret-store-types.js";

export { isSecretNotFound, SecretNotFoundError } from "./secret-store-types.js";
export type { SecretStore, SubscriptionSecretVersionResult } from "./secret-store-types.js";

type Environment = Readonly<Record<string, string | undefined>>;

const logger = createServiceLogger("runtime-secret-store");

function createRuntimePostgresSecretStore(environment: Environment) {
  const keys = createSecretStoreKeyRing(
    environment.SECRET_STORE_ROOT_KEY ?? environment.ENCRYPTION_ROOT_KEY,
    environment.SECRET_STORE_PREVIOUS_ROOT_KEY,
  );
  const pool = createPlatformStatePool(platformDatabaseSettingsFromEnvironment(environment), {
    applicationName: "runtime-secret-store",
    logger,
  });
  return { store: createPostgresSecretStore(pool, keys), pool };
}

export async function rotateRuntimeSecretStoreKey(targetId: string, environment: Environment = process.env) {
  const { pool, store } = createRuntimePostgresSecretStore(environment);
  try {
    await assertPlatformDatabaseTarget(pool, targetId, DEFAULT_PLATFORM_STATE_SCHEMA);
    return await store.rotate();
  } finally {
    await pool.end();
  }
}

export function createRuntimeSecretStore(environment: Environment = process.env): SecretStore {
  const backend = environment.SECRET_STORE_BACKEND ?? "postgres";
  if (backend === "secret-manager") return secretManager;
  if (backend === "postgres") return createRuntimePostgresSecretStore(environment).store;
  throw new Error(`invalid SECRET_STORE_BACKEND: ${backend}`);
}

let store: SecretStore | undefined;
function current(): SecretStore {
  store ??= createRuntimeSecretStore();
  return store;
}

export function writeSecret(input: SecretWrite) {
  return current().writeSecret(input);
}

export function addSecretVersionIfExists(name: string, value: string) {
  return current().addSecretVersionIfExists(name, value);
}

export function addSecretVersionKeepingLatest(name: string, value: string) {
  return current().addSecretVersionKeepingLatest(name, value);
}

export function readSecret(name: string, version?: string) {
  return current().readSecret(name, version);
}

export function readSecretWithLabels(name: string, version?: string) {
  return current().readSecretWithLabels(name, version);
}

export function archiveSecret(name: string) {
  return current().archiveSecret(name);
}

export function deleteSecret(name: string) {
  return current().deleteSecret(name);
}

export function provisionGatewayAuthSecret(input: Parameters<SecretStore["provisionGatewayAuthSecret"]>[0]) {
  return current().provisionGatewayAuthSecret(input);
}
