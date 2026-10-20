/**
 * Thrown when a write targets an agent dir openclaw has not initialized yet.
 *
 * Creating the file ourselves is what wedges the gateway: a bare
 * `CREATE TABLE IF NOT EXISTS auth_profile_*` leaves user_version 0 with
 * application tables present, which openclaw 2026.7.2+ classifies as a legacy
 * store awaiting the v16 media migration and refuses to boot behind.
 */
export declare class AgentDatabaseNotInitializedError extends Error {
    readonly agentDir: string;
    constructor(agentDir: string);
}
/** Resolves the SQLite database path that stores auth profiles for an agent dir. */
export declare function resolveAuthDbPath(agentDir: string): string;
export declare const SHARED_MAIN_AGENT_ID = "main";
export declare function sharedStateDbPath(agentDir: string): string | null;
export declare function sharedAuthStoreUsable(openclawDir: string): boolean;
/** Reads the raw persisted secrets-store payload, or null if absent. */
export declare function readAuthProfileStore(agentDir: string): unknown | null;
/** Reads the raw persisted runtime-state payload, or null if absent. */
export declare function readAuthProfileState(agentDir: string): unknown | null;
/**
 * Writes the auth-profile secrets-store row into the agent database openclaw
 * owns. Last-writer-wins on the singleton "primary" key. Throws
 * AgentDatabaseNotInitializedError when openclaw has not created the store yet.
 */
export declare function writeAuthProfileStore(agentDir: string, payload: unknown): void;
/**
 * Deletes the auth-profile secrets-store row. Leaves the runtime-state row
 * intact (openclaw owns it). No-op when the database file does not exist.
 */
export declare function deleteAuthProfileStore(agentDir: string): void;
