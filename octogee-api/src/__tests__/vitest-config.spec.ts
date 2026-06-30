import { describe, expect, it } from "vitest";
import unitConfig from "../../vitest.config.js";
import emulatorConfig from "../../vitest.emulator.config.js";

interface VitestConfig {
  test?: {
    setupFiles?: string[];
    fileParallelism?: boolean;
    testTimeout?: number;
    exclude?: string[];
    include?: string[];
  };
}

describe("octogee-api vitest configs", () => {
  it("loads Firebase offline setup and keeps route reuse serial", () => {
    const cfg = unitConfig as VitestConfig;

    expect(cfg.test?.setupFiles).toEqual(["./src/test-setup/firebase-offline.ts"]);
    expect(cfg.test?.fileParallelism).toBe(false);
    expect(cfg.test?.testTimeout).toBe(15_000);
    expect(cfg.test?.exclude).toContain("../gateway-edge/**");
  });

  it("runs emulator specs serially with the emulator glob", () => {
    const cfg = emulatorConfig as VitestConfig;

    expect(cfg.test?.include).toEqual(["src/__tests__/**/*.emulator.spec.ts"]);
    expect(cfg.test?.fileParallelism).toBe(false);
    expect(cfg.test?.testTimeout).toBe(15_000);
  });
});
