import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(__dirname, "../..");

describe("operator GitHub CLI hydration", () => {
  it("bounds non-critical connector hydration before the OpenClaw gateway starts", () => {
    const entrypoint = readFileSync(path.join(repoRoot, "infra/gateway/entrypoint.sh"), "utf8");

    expect(entrypoint).toContain('timeout -k 5s 20s "$TSX" /octogee/scripts/entrypoints/github-cli-auth-hydrate.ts');
  });
});
