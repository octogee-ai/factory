import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const verifier = path.resolve(__dirname, "../../infra/gateway/verify-codex-source-match.mjs");
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function packageDir(files: Record<string, string>): string {
  const root = mkdtempSync(path.join(tmpdir(), "codex-match-"));
  roots.push(root);
  for (const [relative, content] of Object.entries(files)) {
    const absolute = path.join(root, relative);
    mkdirSync(path.dirname(absolute), { recursive: true });
    writeFileSync(absolute, content);
  }
  return root;
}

function run(vendored: string, installed: string): { ok: boolean; output: string } {
  try {
    const stdout = execFileSync(process.execPath, [verifier, vendored, installed], { stdio: "pipe" });
    return { ok: true, output: stdout.toString() };
  } catch (error) {
    return { ok: false, output: String((error as { stderr?: Buffer }).stderr ?? error) };
  }
}

describe("Codex companion source match", () => {
  it("passes when every dist module of the installed package matches the vendored build, ignoring package.json version", () => {
    const vendored = packageDir({
      "package.json": JSON.stringify({ name: "@openclaw/codex", version: "0.0.0-fork" }),
      "dist/index.js": "export const a = 1;\n",
      "dist/app-server/auth-bridge.js": "export const b = 2;\n",
      "dist/manifest.json": "{}\n",
      "README.md": "vendored",
    });
    const installed = packageDir({
      "package.json": JSON.stringify({ name: "@openclaw/codex", version: "2026.9.5" }),
      "dist/index.js": "export const a = 1;\n",
      "dist/app-server/auth-bridge.js": "export const b = 2;\n",
      "dist/manifest.json": "{}\n",
      "README.md": "registry",
    });
    const result = run(vendored, installed);
    expect(result.ok).toBe(true);
    expect(result.output).toContain("PASS (3 dist modules identical)");
  });

  it("fails and names the module when the registry package diverges from the source-matched build", () => {
    const vendored = packageDir({ "dist/index.js": "export const a = 1;\n", "dist/extra.js": "x" });
    const installed = packageDir({ "dist/index.js": "export const a = 2;\n" });
    const result = run(vendored, installed);
    expect(result.ok).toBe(false);
    expect(result.output).toContain("dist/index.js".replace("dist/", "") + ": content differs");
    expect(result.output).toContain("extra.js: missing from the installed package");
  });

  it("fails when the vendored package has no dist modules at all", () => {
    const vendored = packageDir({ "dist/.keep": "" });
    const installed = packageDir({ "dist/index.js": "x" });
    const result = run(vendored, installed);
    expect(result.ok).toBe(false);
    expect(result.output).toContain("vendored package has no dist modules");
  });
});
