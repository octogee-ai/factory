import { describe, expect, it } from "vitest";
import config from "../../vitest.config.js";

interface VitestConfig {
  test?: { exclude?: string[] };
}

describe("gateway-edge vitest config", () => {
  it("excludes build output and package dependencies from test discovery", () => {
    const cfg = config as VitestConfig;

    expect(cfg.test?.exclude).toEqual(["dist/**", "node_modules/**"]);
  });
});
