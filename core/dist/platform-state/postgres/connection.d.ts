import pg from "pg";
import type { PlatformStateLogger } from "./session.js";
declare const SSL_MODES: readonly ["disable", "require", "verify-full"];
export type PlatformDatabaseSslMode = (typeof SSL_MODES)[number];
export interface PlatformDatabaseSettings {
    readonly host: string;
    readonly port: number;
    readonly database: string;
    readonly user: string;
    readonly password: string;
    readonly sslMode: PlatformDatabaseSslMode;
    readonly caCertificate?: string;
    readonly poolMax: number;
}
export interface PlatformStatePoolOptions {
    readonly applicationName: string;
    readonly logger: PlatformStateLogger;
}
type Environment = Readonly<Record<string, string | undefined>>;
export declare function platformDatabaseSettingsFromEnvironment(environment?: Environment): PlatformDatabaseSettings;
export declare function platformDatabasePoolConfig(settings: PlatformDatabaseSettings, applicationName: string): pg.PoolConfig;
export declare function createPlatformStatePool(settings: PlatformDatabaseSettings, options: PlatformStatePoolOptions): pg.Pool;
export {};
