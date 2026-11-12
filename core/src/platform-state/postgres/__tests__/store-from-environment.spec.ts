import pg from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";
import { platformStateStoreForDeploymentTarget, platformStateStoreFromEnvironment } from "../store-from-environment.js";

const DATABASE_SETTINGS = {
  PLATFORM_DB_HOST: "127.0.0.1",
  PLATFORM_DB_NAME: "platform",
  PLATFORM_DB_USER: "platform",
  PLATFORM_DB_PASSWORD: "localonly",
  PLATFORM_DB_SSLMODE: "disable",
};

function selectStore(environment: Record<string, string | undefined>) {
  return () =>
    platformStateStoreFromEnvironment({
      applicationName: "store-selection-test",
      logger: { warn: vi.fn(), error: vi.fn() },
      environment,
    });
}

describe("platformStateStoreFromEnvironment", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("builds a PostgreSQL store from the database settings", () => {
    expect(selectStore(DATABASE_SETTINGS)().users).toBeDefined();
  });

  it("names the missing database setting", () => {
    expect(selectStore({})).toThrow(/PLATFORM_DB_\w+ is required/);
  });

  it("ends the pool it created when the store closes", async () => {
    const end = vi.spyOn(pg.Pool.prototype, "end").mockResolvedValue(undefined);
    await selectStore(DATABASE_SETTINGS)().close();
    expect(end).toHaveBeenCalledOnce();
  });
});

describe("platformStateStoreForDeploymentTarget", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function selectForTarget(environment: Record<string, string | undefined>) {
    return () =>
      platformStateStoreForDeploymentTarget({
        applicationName: "store-selection-test",
        logger: { warn: vi.fn(), error: vi.fn() },
        environment,
        deploymentTargetId: "test-central",
      });
  }

  it("closes its pool when the database belongs to another target", async () => {
    vi.spyOn(pg.Pool.prototype, "query").mockImplementation(async () => ({ rows: [{ target_id: "prod-central" }] }) as never);
    const end = vi.spyOn(pg.Pool.prototype, "end").mockResolvedValue(undefined);
    await expect(selectForTarget(DATABASE_SETTINGS)()).rejects.toThrow('platform database belongs to deployment target "prod-central", not "test-central"');
    expect(end).toHaveBeenCalledOnce();
  });

  it("reports why the database could not be read even when closing the pool also fails", async () => {
    vi.spyOn(pg.Pool.prototype, "query").mockImplementation(async () => {
      throw new Error("connection refused");
    });
    vi.spyOn(pg.Pool.prototype, "end").mockRejectedValue(new Error("already closing"));
    await expect(selectForTarget(DATABASE_SETTINGS)()).rejects.toThrow("connection refused");
  });
});
