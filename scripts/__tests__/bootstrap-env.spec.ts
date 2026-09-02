import { accessSync, constants } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(__dirname, "../..");
const bootstrap = path.join(repoRoot, "scripts/bootstrap-env.sh");

describe("deprecated environment bootstrap entrypoint", () => {
  it("redirects TEST and PROD operators before performing any setup", () => {
    accessSync(bootstrap, constants.X_OK);

    for (const environment of ["test", "prod"]) {
      const result = spawnSync(bootstrap, [`--env=${environment}`], {
        cwd: repoRoot,
        encoding: "utf8",
      });

      expect(result.status).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("does not mutate an environment");
      expect(result.stderr).toContain("exactly two managed environments: TEST and PROD");
      expect(result.stderr).toContain("docs/handbook/30-env-lifecycle.md");
      expect(result.stderr).toContain("Do not run teardown-env.sh merely to inspect the recipe");
    }
  });
});
