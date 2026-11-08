import { describe, expect, it, vi } from "vitest";
import {
  createPlatformStatePool,
  platformDatabasePoolConfig,
  platformDatabaseSettingsFromEnvironment,
} from "../connection.js";

const ENVIRONMENT = {
  PLATFORM_DB_HOST: "db.internal",
  PLATFORM_DB_NAME: "platform",
  PLATFORM_DB_USER: "platform",
  PLATFORM_DB_PASSWORD: "local-password",
  PLATFORM_DB_SSLMODE: "require",
};

const settingsWith = (overrides: Record<string, string | undefined>) =>
  platformDatabaseSettingsFromEnvironment({ ...ENVIRONMENT, ...overrides });

describe("platform database settings", () => {
  it("reads plain connection settings and needs no cloud project or credentials", () => {
    expect(platformDatabaseSettingsFromEnvironment(ENVIRONMENT)).toEqual({
      host: "db.internal",
      port: 5432,
      database: "platform",
      user: "platform",
      password: "local-password",
      sslMode: "require",
      poolMax: 10,
    });
  });

  it("takes an explicit port and pool size", () => {
    const settings = settingsWith({ PLATFORM_DB_PORT: "6543", PLATFORM_DB_POOL_MAX: "4" });

    expect(settings.port).toBe(6543);
    expect(settings.poolMax).toBe(4);
  });

  it.each(["PLATFORM_DB_HOST", "PLATFORM_DB_NAME", "PLATFORM_DB_USER", "PLATFORM_DB_PASSWORD", "PLATFORM_DB_SSLMODE"])(
    "refuses to start without %s and names it",
    (name) => {
      expect(() => settingsWith({ [name]: undefined })).toThrow(name);
      expect(() => settingsWith({ [name]: "" })).toThrow(name);
    },
  );

  it("rejects a TLS mode it does not define", () => {
    expect(() => settingsWith({ PLATFORM_DB_SSLMODE: "prefer" })).toThrow(/PLATFORM_DB_SSLMODE.*disable, require, verify-full/);
  });

  it.each([
    ["PLATFORM_DB_PORT", "not-a-port"],
    ["PLATFORM_DB_PORT", "70000"],
    ["PLATFORM_DB_POOL_MAX", "0"],
    ["PLATFORM_DB_POOL_MAX", "2.5"],
  ])("rejects %s=%s", (name, value) => {
    expect(() => settingsWith({ [name]: value })).toThrow(name);
  });

  it("refuses a CA certificate under a mode that would ignore it", () => {
    expect(() => settingsWith({ PLATFORM_DB_CA_CERT: "pem" })).toThrow(/PLATFORM_DB_CA_CERT.*verify-full/);
  });
});

describe("platform database pool configuration", () => {
  it("never hands node-pg a connection string, so sslmode is not reinterpreted", () => {
    const config = platformDatabasePoolConfig(settingsWith({}), "api");

    expect(config).not.toHaveProperty("connectionString");
    expect(config).toMatchObject({
      host: "db.internal",
      port: 5432,
      database: "platform",
      user: "platform",
      password: "local-password",
      max: 10,
      application_name: "api",
    });
  });

  it("bounds lock waits, statements and idle transactions on every session", () => {
    expect(platformDatabasePoolConfig(settingsWith({}), "api")).toMatchObject({
      lock_timeout: 5_000,
      statement_timeout: 60_000,
      idle_in_transaction_session_timeout: 30_000,
    });
  });

  it("disable connects without TLS", () => {
    expect(platformDatabasePoolConfig(settingsWith({ PLATFORM_DB_SSLMODE: "disable" }), "api").ssl).toBe(false);
  });

  it("require encrypts without verifying the server certificate", () => {
    expect(platformDatabasePoolConfig(settingsWith({ PLATFORM_DB_SSLMODE: "require" }), "api").ssl).toEqual({
      rejectUnauthorized: false,
    });
  });

  it("verify-full checks the certificate against the configured host, including an IP address", () => {
    const settings = settingsWith({ PLATFORM_DB_HOST: "10.1.2.3", PLATFORM_DB_SSLMODE: "verify-full" });

    const ssl = platformDatabasePoolConfig(settings, "api").ssl;

    expect(ssl).toMatchObject({ rejectUnauthorized: true, host: "10.1.2.3" });
    expect(ssl).not.toHaveProperty("servername");
  });

  it("verify-full verifies against the supplied CA", () => {
    const settings = settingsWith({ PLATFORM_DB_SSLMODE: "verify-full", PLATFORM_DB_CA_CERT: "pem" });

    expect(platformDatabasePoolConfig(settings, "api").ssl).toMatchObject({ rejectUnauthorized: true, ca: "pem" });
  });

  it("verify-full without a CA verifies against the system roots", () => {
    expect(platformDatabasePoolConfig(settingsWith({ PLATFORM_DB_SSLMODE: "verify-full" }), "api").ssl).not.toHaveProperty("ca");
  });
});

describe("platform state pool", () => {
  it("logs idle connection failures instead of crashing the process", async () => {
    const logger = { warn: vi.fn(), error: vi.fn() };
    const pool = createPlatformStatePool(settingsWith({ PLATFORM_DB_SSLMODE: "disable" }), { applicationName: "api", logger });

    pool.emit("error", new Error("server closed the connection"), undefined as never);

    expect(logger.error).toHaveBeenCalledWith("platform state database connection failed", {
      message: "server closed the connection",
    });
    await pool.end();
  });
});
