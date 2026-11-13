import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { walk } from "../ops/audit-coverage.js";

let tmp: string | null = null;

function makeTempRepo(): string {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "octogee-audit-"));
  return tmp;
}

describe("audit-coverage CLI helpers", () => {
  afterEach(() => {
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
    tmp = null;
  });

  it("walks TypeScript sources while skipping generated and dependency directories", () => {
    const root = makeTempRepo();
    fs.mkdirSync(path.join(root, "src"), { recursive: true });
    fs.mkdirSync(path.join(root, "node_modules", "pkg"), { recursive: true });
    fs.mkdirSync(path.join(root, "dist"), { recursive: true });
    fs.writeFileSync(path.join(root, "src", "keep.ts"), "export const keep = true;\n");
    fs.writeFileSync(path.join(root, "src", "view.tsx"), "export const View = () => null;\n");
    fs.writeFileSync(path.join(root, "src", "types.d.ts"), "export interface TypeOnly {}\n");
    fs.writeFileSync(path.join(root, "node_modules", "pkg", "skip.ts"), "export const skip = true;\n");
    fs.writeFileSync(path.join(root, "dist", "skip.ts"), "export const skip = true;\n");

    expect(walk(root, root).sort()).toEqual(["src/keep.ts", "src/view.tsx"]);
  });
});
