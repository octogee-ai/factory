import { existsSync } from "node:fs";
import * as path from "node:path";
import { readAuthProfileStore as readSqliteStore, readAuthProfileState as readSqliteState, writeAuthProfileStore as writeSqliteStore, deleteAuthProfileStore as deleteSqliteStore, readAgentAuthProfileStore, readAgentAuthProfileState, writeAgentAuthProfileStore, deleteAgentAuthProfileStore, resolveAuthDbPath, sharedStateDbCandidatePath, sharedStateDbPath, sharedAuthStoreUsable as sharedSqliteAuthStoreUsable, } from "./auth-profile-sqlite.js";
import { readPostgresAgentAnchor, queryAgentStore, writeAgentStore } from "./agent-postgres.js";
export { AgentDatabaseNotInitializedError, resolveAuthDbPath, SHARED_MAIN_AGENT_ID } from "./auth-profile-sqlite.js";
function authJsonPayload(value) {
    if (typeof value !== "string")
        return value;
    try {
        return JSON.parse(value);
    }
    catch {
        throw new Error("PostgreSQL auth profile payload is not valid JSON");
    }
}
function sharedAuthOwnership(row) {
    if (!row)
        return "legacy-main";
    const value = authJsonPayload(row.payload);
    if (value !== null && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === 1 &&
        (value.location === "legacy-main" || value.location === "state-db")) {
        return value.location;
    }
    throw new Error("Invalid PostgreSQL shared auth ownership");
}
async function sharedPostgresOwner(agentDir) {
    const statePath = sharedStateDbCandidatePath(agentDir), anchor = statePath ? readPostgresAgentAnchor(statePath) : null;
    if (!anchor)
        return null;
    const [meta] = await queryAgentStore(anchor, "SELECT store_id FROM $schema.openclaw_schema_meta WHERE store = 'state'");
    if (meta?.store_id !== anchor.storeId)
        throw new Error("PostgreSQL state store identity differs from its anchor");
    const [row] = await queryAgentStore(anchor, "SELECT value_json AS payload FROM $schema.config_machine_state WHERE state_key = $1", ["auth.sharedStore"]);
    return { anchor, location: sharedAuthOwnership(row) };
}
async function authProfileOwner(agentDir) {
    const shared = await sharedPostgresOwner(agentDir);
    if (shared?.location === "state-db")
        return { kind: "state", anchor: shared.anchor };
    if (!shared && sharedStateDbPath(agentDir))
        return { kind: "sqlite", agentOnly: false };
    const anchor = readPostgresAgentAnchor(resolveAuthDbPath(agentDir));
    return anchor ? { kind: "agent", anchor } : { kind: "sqlite", agentOnly: shared !== null };
}
export async function sharedAuthStoreUsable(openclawDir) {
    const main = path.join(openclawDir, "agents", "main", "agent"), shared = await sharedPostgresOwner(main);
    if (shared)
        return shared.location === "state-db" || existsSync(resolveAuthDbPath(main));
    return sharedSqliteAuthStoreUsable(openclawDir);
}
async function readProfile(agentDir, state) {
    const owner = await authProfileOwner(agentDir);
    if (owner.kind === "sqlite" && owner.agentOnly)
        return state ? readAgentAuthProfileState(agentDir) : readAgentAuthProfileStore(agentDir);
    if (owner.kind === "sqlite")
        return state ? readSqliteState(agentDir) : readSqliteStore(agentDir);
    let key = "primary", sql = state
        ? "SELECT state_json AS payload FROM $schema.auth_profile_state WHERE state_key = $1"
        : "SELECT store_json AS payload FROM $schema.auth_profile_store WHERE store_key = $1";
    if (owner.kind === "state") {
        sql = "SELECT value_json AS payload FROM $schema.config_machine_state WHERE state_key = $1";
        key = state ? "authProfiles.state" : "authProfiles.store";
    }
    const rows = await queryAgentStore(owner.anchor, sql, [key]);
    const payload = rows[0]?.payload;
    return authJsonPayload(payload) ?? null;
}
async function assertSharedPostgresWriteOwner(client, schema, anchor) {
    const { rows: [meta] } = await client.query(`SELECT store_id FROM ${schema}.openclaw_schema_meta WHERE store = 'state'`);
    if (meta?.store_id !== anchor.storeId)
        throw new Error("PostgreSQL state store identity differs from its anchor");
    const { rows: [row] } = await client.query(`SELECT value_json AS payload FROM ${schema}.config_machine_state WHERE state_key = $1 FOR UPDATE`, ["auth.sharedStore"]);
    if (sharedAuthOwnership(row) !== "state-db")
        throw new Error("PostgreSQL shared auth ownership changed before write");
}
export async function readAuthProfileStore(agentDir) {
    return readProfile(agentDir, false);
}
export async function readAuthProfileState(agentDir) {
    return readProfile(agentDir, true);
}
export async function writeAuthProfileStore(agentDir, payload) {
    const owner = await authProfileOwner(agentDir);
    if (owner.kind === "sqlite")
        return owner.agentOnly ? writeAgentAuthProfileStore(agentDir, payload) : writeSqliteStore(agentDir, payload);
    await writeAgentStore(owner.anchor, async (client, schema) => {
        if (owner.kind === "state") {
            await assertSharedPostgresWriteOwner(client, schema, owner.anchor);
            await client.query(`INSERT INTO ${schema}.config_machine_state (state_key, value_json, updated_at_ms)
        VALUES ($1, $2, $3) ON CONFLICT (state_key) DO UPDATE SET value_json = excluded.value_json, updated_at_ms = excluded.updated_at_ms`, ["authProfiles.store", JSON.stringify(payload), Date.now()]);
            return;
        }
        await client.query(`INSERT INTO ${schema}.auth_profile_store (store_key, store_json, updated_at)
      VALUES ($1, $2, $3) ON CONFLICT (store_key) DO UPDATE SET store_json = excluded.store_json, updated_at = excluded.updated_at`, ["primary", JSON.stringify(payload), Date.now()]);
    });
}
export async function deleteAuthProfileStore(agentDir) {
    const owner = await authProfileOwner(agentDir);
    if (owner.kind === "sqlite")
        return owner.agentOnly ? deleteAgentAuthProfileStore(agentDir) : deleteSqliteStore(agentDir);
    await writeAgentStore(owner.anchor, async (client, schema) => {
        if (owner.kind === "state") {
            await assertSharedPostgresWriteOwner(client, schema, owner.anchor);
            await client.query(`DELETE FROM ${schema}.config_machine_state WHERE state_key = $1`, ["authProfiles.store"]);
            return;
        }
        await client.query(`DELETE FROM ${schema}.auth_profile_store WHERE store_key = $1`, ["primary"]);
    });
}
