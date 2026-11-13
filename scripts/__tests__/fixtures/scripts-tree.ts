import { existsSync, mkdirSync, mkdtempSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "../../..");
const EXTENSION_FILES = ["secrets.sh", "env.sh"];

export type ScriptExtensions = Record<string, Record<string, string>>;

export function scriptsTreeWith(extensions: ScriptExtensions = {}, parent = mkdtempSync(path.join(tmpdir(), "octogee-scripts-tree-"))): string {
  const tree = path.join(parent, "tree");
  mkdirSync(path.join(tree, "scripts"), { recursive: true });
  for (const entry of readdirSync(repoRoot)) {
    if (entry !== "scripts") symlinkSync(path.join(repoRoot, entry), path.join(tree, entry));
  }
  for (const entry of readdirSync(path.join(repoRoot, "scripts"), { withFileTypes: true })) {
    const source = path.join(repoRoot, "scripts", entry.name);
    if (entry.isDirectory() && EXTENSION_FILES.some((file) => existsSync(path.join(source, file)))) continue;
    symlinkSync(source, path.join(tree, "scripts", entry.name));
  }
  for (const [name, files] of Object.entries(extensions)) {
    mkdirSync(path.join(tree, "scripts", name));
    for (const [file, contents] of Object.entries(files)) writeFileSync(path.join(tree, "scripts", name, file), contents);
  }
  return tree;
}
