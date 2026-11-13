import { describe, expect, it } from "vitest";
import config from "../vitest.config.js";

interface VitestConfig {
  test?: { include?: string[] };
}

describe("core vitest config", () => {
  it("discovers only source-local specs", () => {
    const cfg = config as VitestConfig;

    expect(cfg.test?.include).toEqual(["src/**/*.spec.ts"]);
  });
});
