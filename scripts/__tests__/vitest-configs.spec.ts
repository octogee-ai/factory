import path from "node:path";
import { describe, expect, it } from "vitest";
import unitConfig from "../vitest.config.js";
import emulatorConfig from "../vitest.emulator.config.js";

interface ScriptsVitestConfig {
  resolve?: { alias?: Record<string, string> };
  test?: {
    include?: string[];
    exclude?: string[];
    fileParallelism?: boolean;
    testTimeout?: number;
  };
}

describe("scripts vitest configs", () => {
  it("keeps unit tests on non-emulator specs with shared aliases", () => {
    const cfg = unitConfig as ScriptsVitestConfig;
    const alias = cfg.resolve?.alias as Record<string, string>;

    expect(alias["@shared"]).toBe(path.resolve(__dirname, "../../shared"));
    expect(cfg.test?.include).toEqual(["__tests__/**/*.spec.ts"]);
    expect(cfg.test?.exclude).toContain("**/*.emulator.spec.ts");
  });

  it("runs emulator specs serially with the longer timeout", () => {
    const cfg = emulatorConfig as ScriptsVitestConfig;
    const alias = cfg.resolve?.alias as Record<string, string>;

    expect(alias["@shared"]).toBe(path.resolve(__dirname, "../../shared"));
    expect(cfg.test?.include).toEqual(["__tests__/**/*.emulator.spec.ts"]);
    expect(cfg.test?.fileParallelism).toBe(false);
    expect(cfg.test?.testTimeout).toBe(15_000);
  });
});
