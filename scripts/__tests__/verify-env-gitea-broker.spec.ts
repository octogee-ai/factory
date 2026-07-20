import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const testDir = dirname(fileURLToPath(import.meta.url));
const script = readFileSync(resolve(testDir, "../verify-env.sh"), "utf8");

describe("verify-env Gitea gateway contract", () => {
  it("runs the authenticated read-only broker probe and rejects the retired admin token", () => {
    expect(script).toContain("/octogee/scripts/entrypoints/gitea-broker-probe.ts");
    expect(script).toContain("!process.env.GIT_API_TOKEN");
    expect(script).not.toContain("fetch(u+'/health')");
    expect(script).not.toContain("const t=process.env.GIT_API_TOKEN||''");
  });
});
