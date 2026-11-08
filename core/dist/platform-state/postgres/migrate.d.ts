import pg from "pg";
export declare const DEFAULT_PLATFORM_STATE_SCHEMA = "platform";
export interface MigratePlatformStateOptions {
    readonly schema?: string;
    readonly through?: number;
    readonly deploymentTargetId?: string;
}
export interface PlatformStateMigrationResult {
    readonly applied: readonly number[];
    readonly version: number;
}
export declare function migratePlatformState(pool: pg.Pool, options?: MigratePlatformStateOptions): Promise<PlatformStateMigrationResult>;
