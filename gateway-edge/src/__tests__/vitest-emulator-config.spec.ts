import { describe, expect, it } from "vitest";
import config from "../../vitest.emulator.config.js";

interface VitestConfig {
  resolve?: { alias?: Record<string, string> };
  test?: {
    fileParallelism?: boolean;
    include?: string[];
    testTimeout?: number;
  };
}

describe("gateway-edge emulator vitest config", () => {
  it("runs only emulator specs against the shared emulator process", () => {
    const cfg = config as VitestConfig;

    expect(cfg.test).toMatchObject({
      include: ["src/**/__tests__/**/*.emulator.spec.ts"],
      fileParallelism: false,
      testTimeout: 15_000,
    });
    expect(cfg.resolve?.alias?.["@shared"]).toMatch(/\/shared$/);
  });
});
