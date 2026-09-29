import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const verifier = path.resolve(__dirname, "../../infra/gateway/verify-parallel-source-match.mjs");
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function writeFiles(root: string, files: Record<string, string>): void {
  for (const [relative, content] of Object.entries(files)) {
    const absolute = path.join(root, relative);
    mkdirSync(path.dirname(absolute), { recursive: true });
    writeFileSync(absolute, content);
  }
}

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "parallel-match-"));
  roots.push(root);
  const vendored = path.join(root, "vendored");
  const host = path.join(root, "openclaw");
  const installed = path.join(host, "dist/extensions/parallel");
  const report = path.join(root, "list.json");
  const files = {
    "package.json": JSON.stringify({ name: "@openclaw/parallel-plugin", version: "2026.9.5" }),
    "openclaw.plugin.json": JSON.stringify({ id: "parallel", contracts: { webSearchProviders: ["parallel", "parallel-free"] } }),
    "dist/index.js": "export const a = 1;\n",
    "dist/catalog.worker.cjs": "exports.a = 1;\n",
    "dist/data.bin": "source-matched-runtime-asset",
  };
  writeFiles(vendored, files);
  writeFiles(installed, files);
  writeFiles(host, { "package.json": JSON.stringify({ name: "openclaw", version: "2026.9.5" }) });
  const plugin = {
    id: "parallel",
    rootDir: installed,
    source: path.join(installed, "dist/index.js"),
    origin: "bundled",
    trust: { reason: "bundled", origin: "bundled" },
  };
  const inspect = (changes: Record<string, unknown> = {}) =>
    writeFileSync(report, JSON.stringify({ plugins: [{ ...plugin, ...changes }] }));
  inspect();
  return { vendored, host, installed, report, inspect };
}

function run(f: ReturnType<typeof fixture>): { ok: boolean; output: string } {
  try {
    const stdout = execFileSync(process.execPath, [verifier, f.vendored, f.host, f.report], { stdio: "pipe" });
    return { ok: true, output: stdout.toString() };
  } catch (error) {
    return { ok: false, output: String((error as { stderr?: Buffer }).stderr ?? error) };
  }
}

describe("Parallel companion source match and bundled ownership", () => {
  it("accepts identical source bytes discovered in the running host's bundled tree", () => {
    const result = run(fixture());
    expect(result.ok, result.output).toBe(true);
    expect(result.output).toContain("PASS (5 runtime files identical; origin=bundled)");
  });

  it.each(["dist/index.js", "dist/catalog.worker.cjs", "dist/data.bin", "package.json"])(
    "rejects changed %s even when the package version still matches",
    (file) => {
      const f = fixture();
      writeFiles(f.installed, { [file]: "changed" });
      const result = run(f);
      expect(result.ok).toBe(false);
      expect(result.output).toContain(file + ": content differs");
    },
  );

  it("rejects discovery with no Parallel provider", () => {
    const f = fixture();
    writeFileSync(f.report, JSON.stringify({ plugins: [] }));
    expect(run(f).output).toContain("Parallel missing from fresh-state plugin discovery");
  });

  it("rejects a package without the keyless provider contract", () => {
    const f = fixture();
    writeFiles(f.installed, { "openclaw.plugin.json": JSON.stringify({ id: "parallel", contracts: { webSearchProviders: ["parallel"] } }) });
    expect(run(f).output).toContain("Parallel keyless search provider contract is missing");
  });

  it("rejects missing and extra runtime files", () => {
    const f = fixture();
    rmSync(path.join(f.installed, "dist/data.bin"));
    writeFiles(f.installed, { "dist/extra.js": "extra" });
    const result = run(f);
    expect(result.ok).toBe(false);
    expect(result.output).toContain("dist/data.bin: missing from the installed package");
    expect(result.output).toContain("dist/extra.js: missing from the vendored package");
  });

  it.each([
    { origin: "global", trust: { reason: "trusted-official", origin: "global" } },
    { origin: "global", trust: { reason: "origin-path", origin: "global", installSource: "npm", installSpec: "npm-pack:/tmp/parallel.tgz" } },
  ])("rejects non-bundled discovery: $trust.reason", (report) => {
    const f = fixture();
    f.inspect(report);
    const result = run(f);
    expect(result.ok).toBe(false);
    expect(result.output).toContain("expected bundled Parallel");
  });

  it("rejects discovery of another physical copy", () => {
    const f = fixture();
    f.inspect({ rootDir: f.vendored, source: path.join(f.vendored, "dist/index.js") });
    const result = run(f);
    expect(result.ok).toBe(false);
    expect(result.output).toContain("outside the expected bundled package");
  });

  it("rejects a bundle symlink escaping the running host", () => {
    const f = fixture();
    rmSync(f.installed, { recursive: true });
    symlinkSync(f.vendored, f.installed, "dir");
    const result = run(f);
    expect(result.ok).toBe(false);
    expect(result.output).toContain("not physically contained");
  });

  it("rejects a companion with a different core version", () => {
    const f = fixture();
    writeFiles(f.host, { "package.json": JSON.stringify({ name: "openclaw", version: "2026.9.6" }) });
    const result = run(f);
    expect(result.ok).toBe(false);
    expect(result.output).toContain("does not match the OpenClaw package");
  });
});
