export interface PlatformStateMigration {
    readonly version: number;
    readonly name: string;
    readonly sql: string;
}
export declare const PLATFORM_STATE_MIGRATIONS: readonly PlatformStateMigration[];
