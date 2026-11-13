import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const writeLayer = resolve(import.meta.dirname, "../lib/ops-agent-evidence-layer.sh");

const tree = (contents: Record<string, string>, mtime: number): string => {
  const root = mkdtempSync(resolve(tmpdir(), "octogee-ops-agent-layer-tree-"));
  for (const [path, value] of Object.entries(contents)) {
    const file = resolve(root, path);
    mkdirSync(resolve(file, ".."), { recursive: true });
    writeFileSync(file, value);
    utimesSync(file, mtime, mtime);
  }
  utimesSync(root, mtime, mtime);
  return root;
};

const layer = (root: string): Buffer => {
  const output = resolve(mkdtempSync(resolve(tmpdir(), "octogee-ops-agent-layer-out-")), "layer.tar.gz");
  const result = spawnSync("bash", [writeLayer, root, "octogee/source/openclaw", output], { encoding: "utf8" });
  expect(result.status, result.stderr).toBe(0);
  return readFileSync(output);
};

describe("ops-agent evidence layer", () => {
  const files = { "src/b.ts": "export const b = 2;\n", "src/a.ts": "export const a = 1;\n", ".octogee-source-commit": "abc\n" };

  it("produces byte-identical layers for the same tree regardless of file times", () => {
    expect(layer(tree(files, 1_000_000)).equals(layer(tree(files, 2_000_000)))).toBe(true);
  });

  it("changes when tree content changes", () => {
    expect(layer(tree(files, 1_000_000)).equals(layer(tree({ ...files, "src/a.ts": "export const a = 3;\n" }, 1_000_000)))).toBe(false);
  });

  it("places root-owned entries under the requested path", () => {
    const output = resolve(mkdtempSync(resolve(tmpdir(), "octogee-ops-agent-layer-out-")), "layer.tar.gz");
    execFileSync("bash", [writeLayer, tree(files, 1_000_000), "octogee/source/openclaw", output]);
    const entries = execFileSync("python3", ["-c", "import sys,tarfile\nfor e in tarfile.open(sys.argv[1]): print(e.uid, e.gid, e.mtime, e.name)", output], { encoding: "utf8" })
      .trim().split("\n");
    expect(entries).toContain("0 0 0 octogee/source/openclaw/src/a.ts");
    expect(entries.every(entry => entry.startsWith("0 0 0 octogee"))).toBe(true);
  });
});
