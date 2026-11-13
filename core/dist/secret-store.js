import { createServiceLogger } from "@octogee/shared/server/service-logger";
import { assertPlatformDatabaseTarget } from "./platform-state/postgres/deployment-target.js";
import { DEFAULT_PLATFORM_STATE_SCHEMA } from "./platform-state/postgres/migrate.js";
import { createPlatformStatePool, platformDatabaseSettingsFromEnvironment, } from "./platform-state/postgres/connection.js";
import { createPostgresSecretStore, createSecretStoreKeyRing } from "./postgres-secret-store.js";
import * as secretManager from "./secret-manager.js";
export { isSecretNotFound, SecretNotFoundError } from "./secret-store-types.js";
const logger = createServiceLogger("runtime-secret-store");
function createRuntimePostgresSecretStore(environment) {
    const keys = createSecretStoreKeyRing(environment.SECRET_STORE_ROOT_KEY ?? environment.ENCRYPTION_ROOT_KEY, environment.SECRET_STORE_PREVIOUS_ROOT_KEY);
    const pool = createPlatformStatePool(platformDatabaseSettingsFromEnvironment(environment), {
        applicationName: "runtime-secret-store",
        logger,
    });
    return { store: createPostgresSecretStore(pool, keys), pool };
}
export async function rotateRuntimeSecretStoreKey(targetId, environment = process.env) {
    const { pool, store } = createRuntimePostgresSecretStore(environment);
    try {
        await assertPlatformDatabaseTarget(pool, targetId, DEFAULT_PLATFORM_STATE_SCHEMA);
        return await store.rotate();
    }
    finally {
        await pool.end();
    }
}
export function createRuntimeSecretStore(environment = process.env) {
    const backend = environment.SECRET_STORE_BACKEND ?? "postgres";
    if (backend === "secret-manager")
        return secretManager;
    if (backend === "postgres")
        return createRuntimePostgresSecretStore(environment).store;
    throw new Error(`invalid SECRET_STORE_BACKEND: ${backend}`);
}
let store;
function current() {
    store ??= createRuntimeSecretStore();
    return store;
}
export function writeSecret(input) {
    return current().writeSecret(input);
}
export function addSecretVersionIfExists(name, value) {
    return current().addSecretVersionIfExists(name, value);
}
export function addSecretVersionKeepingLatest(name, value) {
    return current().addSecretVersionKeepingLatest(name, value);
}
export function readSecret(name, version) {
    return current().readSecret(name, version);
}
export function readSecretWithLabels(name, version) {
    return current().readSecretWithLabels(name, version);
}
export function archiveSecret(name) {
    return current().archiveSecret(name);
}
export function deleteSecret(name) {
    return current().deleteSecret(name);
}
export function provisionGatewayAuthSecret(input) {
    return current().provisionGatewayAuthSecret(input);
}
