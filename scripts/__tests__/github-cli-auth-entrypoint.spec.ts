import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(__dirname, "../..");

describe("Builder GitHub CLI hydration", () => {
  it("hydrates before repository reconciliation and keeps converging", () => {
    const entrypoint = readFileSync(path.join(repoRoot, "infra/gateway/entrypoint.sh"), "utf8");

    const healthIndex = entrypoint.indexOf("OpenClaw gateway healthy");
    const hydrateIndex = entrypoint.indexOf(
      'timeout -k 5s 130s "$TSX" /octogee/scripts/entrypoints/github-cli-auth-hydrate.ts',
    );
    const reconcileIndex = entrypoint.indexOf("supervise_runner fleet-controller");
    expect(hydrateIndex).toBeGreaterThan(healthIndex);
    expect(reconcileIndex).toBeGreaterThan(hydrateIndex);
    expect(entrypoint).toContain(
      'supervise_runner github-cli-auth-convergence 60000 "$TSX" /octogee/scripts/entrypoints/github-cli-auth-hydrate.ts',
    );
    expect(entrypoint).toContain('if [ "$GATEWAY_CLASS_EFFECTIVE" = "builder" ]; then');
  });
});
