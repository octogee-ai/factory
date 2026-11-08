import pg from "pg";
import type { PlatformStateLogger } from "./session.js";

const SSL_MODES = ["disable", "require", "verify-full"] as const;
const DEFAULT_PORT = 5432;
const MAX_PORT = 65_535;
const DEFAULT_POOL_MAX = 10;
const CONNECTION_TIMEOUT_MS = 10_000;
const LOCK_TIMEOUT_MS = 5_000;
const STATEMENT_TIMEOUT_MS = 60_000;
const IDLE_IN_TRANSACTION_TIMEOUT_MS = 30_000;

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

function present(environment: Environment, name: string): string | undefined {
  const value = environment[name];
  return value === undefined || value === "" ? undefined : value;
}

function required(environment: Environment, name: string): string {
  const value = present(environment, name);
  if (value === undefined) throw new Error(`${name} is required for the PostgreSQL platform state store`);
  return value;
}

function positiveInteger(environment: Environment, name: string, fallback: number, maximum: number): number {
  const value = present(environment, name);
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > maximum) {
    throw new Error(`${name} must be an integer from 1 to ${maximum}, got ${JSON.stringify(value)}`);
  }
  return parsed;
}

function sslModeOf(environment: Environment): PlatformDatabaseSslMode {
  const value = required(environment, "PLATFORM_DB_SSLMODE");
  const mode = SSL_MODES.find((candidate) => candidate === value);
  if (mode === undefined) {
    throw new Error(`PLATFORM_DB_SSLMODE must be one of ${SSL_MODES.join(", ")}, got ${JSON.stringify(value)}`);
  }
  return mode;
}

export function platformDatabaseSettingsFromEnvironment(environment: Environment = process.env): PlatformDatabaseSettings {
  const sslMode = sslModeOf(environment);
  const caCertificate = present(environment, "PLATFORM_DB_CA_CERT");
  if (caCertificate !== undefined && sslMode !== "verify-full") {
    throw new Error(`PLATFORM_DB_CA_CERT only applies with PLATFORM_DB_SSLMODE=verify-full, got ${sslMode}`);
  }
  return {
    host: required(environment, "PLATFORM_DB_HOST"),
    port: positiveInteger(environment, "PLATFORM_DB_PORT", DEFAULT_PORT, MAX_PORT),
    database: required(environment, "PLATFORM_DB_NAME"),
    user: required(environment, "PLATFORM_DB_USER"),
    password: required(environment, "PLATFORM_DB_PASSWORD"),
    sslMode,
    ...(caCertificate === undefined ? {} : { caCertificate }),
    poolMax: positiveInteger(environment, "PLATFORM_DB_POOL_MAX", DEFAULT_POOL_MAX, Number.MAX_SAFE_INTEGER),
  };
}

function sslOptions(settings: PlatformDatabaseSettings): pg.PoolConfig["ssl"] {
  switch (settings.sslMode) {
    case "disable":
      return false;
    case "require":
      return { rejectUnauthorized: false };
    case "verify-full":
      return settings.caCertificate === undefined
        ? { rejectUnauthorized: true, host: settings.host }
        : { rejectUnauthorized: true, host: settings.host, ca: settings.caCertificate };
  }
}

export function platformDatabasePoolConfig(settings: PlatformDatabaseSettings, applicationName: string): pg.PoolConfig {
  return {
    host: settings.host,
    port: settings.port,
    database: settings.database,
    user: settings.user,
    password: settings.password,
    ssl: sslOptions(settings),
    max: settings.poolMax,
    application_name: applicationName,
    connectionTimeoutMillis: CONNECTION_TIMEOUT_MS,
    lock_timeout: LOCK_TIMEOUT_MS,
    statement_timeout: STATEMENT_TIMEOUT_MS,
    idle_in_transaction_session_timeout: IDLE_IN_TRANSACTION_TIMEOUT_MS,
  };
}

export function createPlatformStatePool(settings: PlatformDatabaseSettings, options: PlatformStatePoolOptions): pg.Pool {
  const pool = new pg.Pool(platformDatabasePoolConfig(settings, options.applicationName));
  pool.on("error", (error) => options.logger.error("platform state database connection failed", { message: error.message }));
  return pool;
}
