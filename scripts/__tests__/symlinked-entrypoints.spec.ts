import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const scriptsDir = resolve(import.meta.dirname, "..");
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function linkedScripts(): { root: string; scripts: string } {
  const root = mkdtempSync(join(tmpdir(), "octogee-linked-scripts-"));
  roots.push(root);
  const scripts = join(root, "scripts");
  symlinkSync(scriptsDir, scripts, "dir");
  return { root, scripts };
}

describe("package scripts reached through a symlinked scripts directory", () => {
  it.each([
    { script: "ops/sync-local-file-deps.mjs", args: ["--not-an-option"], error: "[file-deps] Unknown argument" },
    { script: "ops/verify-committed-dist.mjs", args: [], error: "[committed-dist]" },
    { script: "ops/overlay.mjs", args: [], error: "usage: overlay.mjs" },
  ])("$script runs instead of exiting cleanly without doing anything", ({ script, args, error }) => {
    const { root, scripts } = linkedScripts();
    const result = spawnSync(process.execPath, [join(scripts, script), ...args], { cwd: root, encoding: "utf8" });
    expect(result.stderr).toContain(error);
    expect(result.status).not.toBe(0);
  });
});
