import { type PlatformStateMigrationResult } from "./migrate.js";
import type { PlatformStateLogger } from "./session.js";
export interface PlatformStateMigrationRun {
    readonly applicationName: string;
    readonly logger: PlatformStateLogger;
    readonly environment?: Readonly<Record<string, string | undefined>>;
}
export declare function migratePlatformStateFromEnvironment(run: PlatformStateMigrationRun): Promise<PlatformStateMigrationResult>;
