import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { scanTree } from "../ci/factory-deny-list-scan.js";
import { DENY_LIST_MODULE } from "../lib/factory-deny-list.js";

const scriptsDir = fileURLToPath(new URL("..", import.meta.url));
const script = join(scriptsDir, "ci/factory-deny-list-scan.ts");
const run = (root: string) => execFileSync(process.execPath, [join(scriptsDir, "node_modules/tsx/dist/cli.mjs"), script, root], { encoding: "utf8", stdio: "pipe" });

function tree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "deny-scan-"));
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(root, dirname(path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  return root;
}

describe("factory deny-list scan", () => {
  it("reports a clean tree, skipping node_modules, .git, and the deny list module itself", () => {
    const root = tree({
      "README.md": "clean",
      "node_modules/dep/index.js": "octogee-test",
      ".git/config": "mail chris@gmail.com",
      [DENY_LIST_MODULE]: "octogee-test 94934561284",
    });
    expect(scanTree(root)).toEqual({ files: 2, hits: [] });
    expect(run(root)).toContain("deny list: clean across 2 files");
  });

  it("fails with the file and line of every hit", () => {
    const root = tree({ "docs/a.md": "fine\nsee octogee-test", "b.md": "costs $5" });
    const hits = scanTree(root).hits.sort((x, y) => (x.file < y.file ? -1 : 1));
    expect(hits).toEqual([
      { file: "b.md", line: 1, rule: "price", text: "$5" },
      { file: "docs/a.md", line: 2, rule: "TEST environment identity", text: "octogee-test" },
    ]);
    expect(() => run(root)).toThrow(/docs\/a\.md:2 TEST environment identity: "octogee-test"/);
  });
});
