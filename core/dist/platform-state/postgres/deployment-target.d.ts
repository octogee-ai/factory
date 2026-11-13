import pg from "pg";
export declare function assertPlatformDatabaseTarget(pool: pg.Pool, selected: string, schema: string): Promise<void>;
export declare function claimPlatformDatabaseTarget(client: pg.PoolClient, selected: string): Promise<void>;
