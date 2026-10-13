export declare function isSqliteVolatileArtifactPath(candidate: string): boolean;
export declare function isSqliteStorePath(candidate: string): boolean;
export declare function listSqliteStores(root: string): Promise<string[]>;
export declare function isCodexDatabase(relative: string): boolean;
