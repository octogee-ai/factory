export { AgentDatabaseNotInitializedError, resolveAuthDbPath, SHARED_MAIN_AGENT_ID, sharedAuthStoreUsable } from "./auth-profile-sqlite.js";
export declare function readAuthProfileStore(agentDir: string): Promise<unknown | null>;
export declare function readAuthProfileState(agentDir: string): Promise<unknown | null>;
export declare function writeAuthProfileStore(agentDir: string, payload: unknown): Promise<void>;
export declare function deleteAuthProfileStore(agentDir: string): Promise<void>;
