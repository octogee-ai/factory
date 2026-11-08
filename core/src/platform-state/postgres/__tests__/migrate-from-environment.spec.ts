import pg from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";
import { migratePlatformState } from "../migrate.js";
import { migratePlatformStateFromEnvironment } from "../migrate-from-environment.js";

vi.mock("../migrate.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../migrate.js")>()),
  migratePlatformState: vi.fn(),
}));

const SETTINGS = {
  DEPLOYMENT_TARGET_ID: "test-central",
  PLATFORM_DB_HOST: "127.0.0.1",
  PLATFORM_DB_NAME: "platform",
  PLATFORM_DB_USER: "platform_migrator",
  PLATFORM_DB_PASSWORD: "localonly",
  PLATFORM_DB_SSLMODE: "disable",
};
const RESULT = { applied: [1], version: 1 };

function run(environment: Record<string, string | undefined>) {
  return migratePlatformStateFromEnvironment({
    applicationName: "migrate-test",
    logger: { warn: vi.fn(), error: vi.fn() },
    environment,
  });
}

describe("migratePlatformStateFromEnvironment", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.mocked(migratePlatformState).mockReset();
  });

  it("grants the configured runtime role", async () => {
    vi.spyOn(pg.Pool.prototype, "end").mockResolvedValue(undefined);
    vi.mocked(migratePlatformState).mockResolvedValue(RESULT);

    await expect(run({ ...SETTINGS, PLATFORM_DB_RUNTIME_USER: "platform_state" })).resolves.toEqual(RESULT);

    expect(migratePlatformState).toHaveBeenCalledWith(expect.any(pg.Pool), {
      deploymentTargetId: "test-central",
      runtimeRole: "platform_state",
    });
  });

  it("grants nothing when one account owns and uses the schema", async () => {
    vi.spyOn(pg.Pool.prototype, "end").mockResolvedValue(undefined);
    vi.mocked(migratePlatformState).mockResolvedValue(RESULT);

    await run({ ...SETTINGS, PLATFORM_DB_RUNTIME_USER: "" });

    expect(migratePlatformState).toHaveBeenCalledWith(expect.any(pg.Pool), { deploymentTargetId: "test-central" });
  });

  it("refuses to migrate without knowing the deployment target", async () => {
    await expect(run({ ...SETTINGS, DEPLOYMENT_TARGET_ID: "" })).rejects.toThrow(/DEPLOYMENT_TARGET_ID is required/);
    expect(migratePlatformState).not.toHaveBeenCalled();
  });

  it("ends the pool when the migration fails and reports the failure", async () => {
    const end = vi.spyOn(pg.Pool.prototype, "end").mockResolvedValue(undefined);
    vi.mocked(migratePlatformState).mockRejectedValue(new Error("migration failed"));

    await expect(run(SETTINGS)).rejects.toThrow("migration failed");

    expect(end).toHaveBeenCalledOnce();
  });

  it("names a missing database setting", async () => {
    await expect(run({ DEPLOYMENT_TARGET_ID: "test-central" })).rejects.toThrow(/PLATFORM_DB_\w+ is required/);
    expect(migratePlatformState).not.toHaveBeenCalled();
  });
});
