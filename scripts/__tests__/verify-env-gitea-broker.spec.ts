import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const testDir = dirname(fileURLToPath(import.meta.url));
const script = readFileSync(resolve(testDir, "../verify-env.sh"), "utf8");

describe("verify-env Gitea gateway contract", () => {
  it("checks the broker URL and rejects the retired admin token in the shell-bearing container", () => {
    expect(script).toContain("process.env.GITEA_ADMIN_BROKER_URL");
    expect(script).toContain("!process.env.GIT_API_TOKEN");
    expect(script).not.toContain("const t=process.env.GIT_API_TOKEN||''");
  });
});
