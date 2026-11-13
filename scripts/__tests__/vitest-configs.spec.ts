import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { configDefaults } from "vitest/config";
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

async function unitExcludesOn(platform: NodeJS.Platform): Promise<string[]> {
  const original = Object.getOwnPropertyDescriptor(process, "platform")!;
  Object.defineProperty(process, "platform", { ...original, value: platform });
  try {
    vi.resetModules();
    const { default: cfg } = await import("../vitest.config.js");
    return (cfg as ScriptsVitestConfig).test?.exclude ?? [];
  } finally {
    Object.defineProperty(process, "platform", original);
  }
}

describe("scripts vitest configs", () => {
  it("keeps unit tests on non-emulator specs with shared aliases", () => {
    const cfg = unitConfig as ScriptsVitestConfig;
    const alias = cfg.resolve?.alias as Record<string, string>;

    expect(alias["@shared"]).toBe(path.resolve(__dirname, "../../shared"));
    expect(cfg.test?.include).toEqual(["__tests__/**/*.spec.ts"]);
    expect(cfg.test?.exclude).toContain("**/*.emulator.spec.ts");
  });

  it("runs Linux-host specs on Linux and skips them on other hosts", async () => {
    const linux = await unitExcludesOn("linux");
    const darwin = await unitExcludesOn("darwin");

    expect(linux).toEqual([...configDefaults.exclude, "**/*.emulator.spec.ts"]);
    expect(darwin).toEqual(expect.arrayContaining([...linux, "__tests__/rsync-staged-symlinks.spec.ts"]));
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
