import * as path from "node:path";
import { readAuthProfileStore as readSqliteStore, readAuthProfileState as readSqliteState, writeAuthProfileStore as writeSqliteStore, deleteAuthProfileStore as deleteSqliteStore, resolveAuthDbPath, sharedStateDbPath, } from "./auth-profile-sqlite.js";
import { readPostgresAgentAnchor, queryAgentStore, writeAgentStore } from "./agent-postgres.js";
export { AgentDatabaseNotInitializedError, resolveAuthDbPath, SHARED_MAIN_AGENT_ID, sharedAuthStoreUsable } from "./auth-profile-sqlite.js";
async function readProfile(agentDir, state) {
    const anchor = sharedStateDbPath(agentDir) ? null : readPostgresAgentAnchor(resolveAuthDbPath(agentDir));
    if (!anchor)
        return state ? readSqliteState(agentDir) : readSqliteStore(agentDir);
    const rows = state
        ? await queryAgentStore(anchor, "SELECT state_json AS payload FROM $schema.auth_profile_state WHERE state_key = $1", ["primary"])
        : await queryAgentStore(anchor, "SELECT store_json AS payload FROM $schema.auth_profile_store WHERE store_key = $1", ["primary"]);
    const payload = rows[0]?.payload;
    return typeof payload === "string" ? JSON.parse(payload) : payload ?? null;
}
export async function readAuthProfileStore(agentDir) {
    return readProfile(agentDir, false);
}
export async function readAuthProfileState(agentDir) {
    return readProfile(agentDir, true);
}
export async function writeAuthProfileStore(agentDir, payload) {
    const anchor = sharedStateDbPath(agentDir) ? null : readPostgresAgentAnchor(resolveAuthDbPath(agentDir));
    if (!anchor)
        return writeSqliteStore(agentDir, payload);
    await writeAgentStore(anchor, async (client, schema) => {
        await client.query(`INSERT INTO ${schema}.auth_profile_store (store_key, store_json, updated_at)
      VALUES ($1, $2, $3) ON CONFLICT (store_key) DO UPDATE SET store_json = excluded.store_json, updated_at = excluded.updated_at`, ["primary", JSON.stringify(payload), Date.now()]);
    });
}
export async function deleteAuthProfileStore(agentDir) {
    const anchor = sharedStateDbPath(agentDir) ? null : readPostgresAgentAnchor(path.join(agentDir, "openclaw-agent.sqlite"));
    if (!anchor)
        return deleteSqliteStore(agentDir);
    await writeAgentStore(anchor, async (client, schema) => {
        await client.query(`DELETE FROM ${schema}.auth_profile_store WHERE store_key = $1`, ["primary"]);
    });
}
