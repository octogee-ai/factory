import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(__dirname, "../..");

describe("operator GitHub CLI hydration", () => {
  it("bounds non-critical connector hydration after the OpenClaw gateway is healthy", () => {
    const entrypoint = readFileSync(path.join(repoRoot, "infra/gateway/entrypoint.sh"), "utf8");

    const healthIndex = entrypoint.indexOf("OpenClaw gateway healthy");
    const hydrateIndex = entrypoint.indexOf(
      'timeout -k 5s 20s "$TSX" /octogee/scripts/entrypoints/github-cli-auth-hydrate.ts',
    );
    expect(hydrateIndex).toBeGreaterThan(healthIndex);
  });
});
