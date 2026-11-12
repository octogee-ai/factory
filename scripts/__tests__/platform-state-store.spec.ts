import { afterEach, describe, expect, it, vi } from "vitest";
import { operatorPlatformStateStore } from "../lib/platform-state-store.js";

describe("operatorPlatformStateStore", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("refuses to run without a database and names the wrapper that opens one", async () => {
    vi.stubEnv("PLATFORM_DB_HOST", "");
    await expect(operatorPlatformStateStore("test-central")).rejects.toThrow(
      /test-central.*npm run --prefix scripts with-platform-state -- --env=<test\|prod> -- <command>/s,
    );
  });

  it("requires every database setting once a database host is given", async () => {
    vi.stubEnv("PLATFORM_DB_HOST", "127.0.0.1");
    vi.stubEnv("PLATFORM_DB_SSLMODE", "");
    await expect(operatorPlatformStateStore("test-central")).rejects.toThrow(/PLATFORM_DB_\w+ is required/);
  });
});
