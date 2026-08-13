import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(__dirname, "../..");

describe("Builder GitHub credentials", () => {
  it("never materializes GitHub CLI auth in the agent runtime", () => {
    const entrypoint = readFileSync(path.join(repoRoot, "infra/gateway/entrypoint.sh"), "utf8");

    expect(entrypoint).not.toContain("github-cli-auth-hydrate");
    expect(entrypoint).not.toContain("github-cli-auth-convergence");
    expect(entrypoint).toContain("supervise_runner fleet-controller");
  });
});
