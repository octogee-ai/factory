/** Resolves the SQLite database path that stores auth profiles for an agent dir. */
export declare function resolveAuthDbPath(agentDir: string): string;
/** Reads the raw persisted secrets-store payload, or null if absent. */
export declare function readAuthProfileStore(agentDir: string): unknown | null;
/** Reads the raw persisted runtime-state payload, or null if absent. */
export declare function readAuthProfileState(agentDir: string): unknown | null;
/**
 * Writes the auth-profile secrets-store row, bootstrapping the DB + schema
 * on first call. Last-writer-wins on the singleton "primary" key.
 */
export declare function writeAuthProfileStore(agentDir: string, payload: unknown): void;
/**
 * Deletes the auth-profile secrets-store row. Leaves the runtime-state row
 * intact (openclaw owns it). No-op when the database file does not exist.
 */
export declare function deleteAuthProfileStore(agentDir: string): void;
