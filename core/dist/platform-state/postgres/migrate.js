import pg from "pg";
import { claimPlatformDatabaseTarget } from "./deployment-target.js";
import { PLATFORM_STATE_MIGRATIONS } from "./migrations.js";
export const DEFAULT_PLATFORM_STATE_SCHEMA = "platform";
const LATEST_VERSION = PLATFORM_STATE_MIGRATIONS[PLATFORM_STATE_MIGRATIONS.length - 1].version;
function targetVersion(through) {
    if (through === undefined)
        return LATEST_VERSION;
    if (!PLATFORM_STATE_MIGRATIONS.some((migration) => migration.version === through)) {
        throw new RangeError(`platform state has no migration version ${through}`);
    }
    return through;
}
async function grantRuntimeAccess(client, schema, role) {
    const grantee = pg.escapeIdentifier(role);
    await client.query(`GRANT USAGE ON SCHEMA ${schema} TO ${grantee}`);
    await client.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA ${schema} TO ${grantee}`);
    await client.query(`REVOKE ALL ON TABLE ${schema}.platform_state_migrations FROM ${grantee}`);
    await client.query(`REVOKE INSERT, UPDATE, DELETE ON TABLE ${schema}.platform_deployment_target FROM ${grantee}`);
    await client.query(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA ${schema} TO ${grantee}`);
}
export async function migratePlatformState(pool, options = {}) {
    const schema = options.schema ?? DEFAULT_PLATFORM_STATE_SCHEMA;
    const target = targetVersion(options.through);
    const identifier = pg.escapeIdentifier(schema);
    const client = await pool.connect();
    let broken;
    const onConnectionError = (error) => {
        broken = error;
    };
    client.on("error", onConnectionError);
    try {
        await client.query("BEGIN");
        await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`octogee-platform-state-migrate:${schema}`]);
        await client.query(`CREATE SCHEMA IF NOT EXISTS ${identifier}`);
        await client.query(`SET LOCAL search_path TO ${identifier}`);
        await client.query("CREATE TABLE IF NOT EXISTS platform_state_migrations (version integer PRIMARY KEY, name text NOT NULL, applied_at bigint NOT NULL)");
        await client.query("CREATE TABLE IF NOT EXISTS platform_deployment_target (singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton), target_id text NOT NULL CHECK (target_id <> ''))");
        const existing = await client.query("SELECT version FROM platform_state_migrations");
        const done = new Set(existing.rows.map((row) => row.version));
        const applied = [];
        for (const migration of PLATFORM_STATE_MIGRATIONS) {
            if (migration.version > target || done.has(migration.version))
                continue;
            await client.query(migration.sql);
            await client.query("INSERT INTO platform_state_migrations (version, name, applied_at) VALUES ($1, $2, (extract(epoch FROM clock_timestamp()) * 1000)::bigint)", [migration.version, migration.name]);
            applied.push(migration.version);
        }
        if (options.deploymentTargetId !== undefined) {
            await claimPlatformDatabaseTarget(client, options.deploymentTargetId);
        }
        if (options.runtimeRole !== undefined)
            await grantRuntimeAccess(client, identifier, options.runtimeRole);
        await client.query("COMMIT");
        return { applied, version: Math.max(0, ...done, ...applied) };
    }
    catch (error) {
        if (broken === undefined) {
            try {
                await client.query("ROLLBACK");
            }
            catch (rollbackError) {
                broken = rollbackError instanceof Error ? rollbackError : new Error(String(rollbackError));
            }
        }
        throw error;
    }
    finally {
        client.off("error", onConnectionError);
        client.release(broken);
    }
}
