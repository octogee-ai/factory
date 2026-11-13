import pg from "pg";
import { type PlatformStateMigrationResult } from "./migrate.js";
import type { PlatformStateLogger } from "./session.js";
export interface PlatformStateMigrationRun {
    readonly applicationName: string;
    readonly logger: PlatformStateLogger;
    readonly environment?: Readonly<Record<string, string | undefined>>;
}
export declare function assertPlatformCutoverImported(pool: pg.Pool, deploymentTargetId: string, sourceProject: string, schema?: string): Promise<void>;
export declare function migratePlatformStateFromEnvironment(run: PlatformStateMigrationRun): Promise<PlatformStateMigrationResult>;
