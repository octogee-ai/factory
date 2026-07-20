import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  AgentImportGitError,
  applyAgentImportRepository,
  buildAgentImportGitEnvironment,
  inspectAgentImportRepository,
  rollbackAgentImportRepository,
  scanAgentImportSecrets,
} from "../lib/agent-import-git.js";

const roots: string[] = [];

function temp(name: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `${name}-`));
  roots.push(dir);
  return dir;
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function repo(name: string, files: Record<string, string | Buffer>): string {
  const dir = temp(name);
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.name", "Octogee Test");
  git(dir, "config", "user.email", "test@octogee.invalid");
  for (const [file, contents] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), contents);
  }
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "initial");
  return dir;
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("inspectAgentImportRepository", () => {
  it("reports reachable history and fails closed on secret findings", async () => {
    const source = repo("agent-import-source", { "MEMORY.md": "old memory\n" });
    fs.writeFileSync(path.join(source, "MEMORY.md"), "new memory\n");
    git(source, "add", "MEMORY.md");
    git(source, "commit", "-q", "-m", "remember");

    const clean = await inspectAgentImportRepository(source, {
      scanSecrets: vi.fn(async () => []),
    });
    expect(clean).toMatchObject({ commitCount: 2, fileCount: 1, secretFindings: [] });
    expect(clean.head).toMatch(/^[0-9a-f]{40}$/);
    expect(clean.workspaceDigest).toMatch(/^sha256:[0-9a-f]{64}$/);

    await expect(inspectAgentImportRepository(source, {
      scanSecrets: vi.fn(async () => [{ ruleId: "generic-api-key", path: "MEMORY.md", commit: clean.head }]),
    })).rejects.toMatchObject({ code: "secret_findings" });
  });

  it("rejects symlinks and submodules before checkout", async () => {
    const source = repo("agent-import-symlink", { "MEMORY.md": "memory\n" });
    fs.symlinkSync("MEMORY.md", path.join(source, "linked-memory"));
    git(source, "add", "linked-memory");
    git(source, "commit", "-q", "-m", "link");

    await expect(inspectAgentImportRepository(source, { scanSecrets: async () => [] }))
      .rejects.toMatchObject({ code: "unsafe_git_entry" });
  });

  it("rejects credential and raw config paths anywhere in reachable history", async () => {
    const source = repo("agent-import-sensitive-history", { ".env": "TOKEN=historical\n" });
    fs.rmSync(path.join(source, ".env"));
    fs.writeFileSync(path.join(source, "MEMORY.md"), "safe tip\n");
    git(source, "add", "-A");
    git(source, "commit", "-q", "-m", "remove credential file");

    await expect(inspectAgentImportRepository(source, { scanSecrets: async () => [] }))
      .rejects.toMatchObject({ code: "unsafe_git_entry" });
  });

  it("does not expose pod credentials to imported Git operations", () => {
    const env = buildAgentImportGitEnvironment({
      PATH: "/attacker/bin",
      OPENCLAW_GATEWAY_TOKEN: "pod-secret",
      GITEA_TOKEN: "admin-secret",
      SSH_AUTH_SOCK: "/tmp/agent.sock",
    });

    expect(env).toMatchObject({
      PATH: "/usr/local/bin:/usr/bin:/bin",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_TERMINAL_PROMPT: "0",
    });
    expect(env).not.toHaveProperty("OPENCLAW_GATEWAY_TOKEN");
    expect(env).not.toHaveProperty("GITEA_TOKEN");
    expect(env).not.toHaveProperty("SSH_AUTH_SOCK");
  });
});

describe("applyAgentImportRepository", () => {
  it("creates a two-parent import commit, preserves platform paths, and normalizes binaries", async () => {
    const source = repo("agent-import-source", {
      "AGENTS.md": "# Moof\n",
      "README.md": "source readme\n",
      "memory/2026-07-20.md": "met Jack\n",
      "photo.png": Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2]),
      ".gitignore": "node_modules/\n",
    });
    const sourceHead = git(source, "rev-parse", "HEAD");
    const target = repo("agent-import-target", {
      "README.md": "octogee starter\n",
      ".files/manifest.json": JSON.stringify({ "avatar.png": { type: "blob", gcsPath: "customers/jack/avatar.png" } }),
      "projects/existing/PROJECT.md": "keep project\n",
      ".gitignore": ".files/cache/\nprojects/*/.git/\n",
    });
    const destinationHead = git(target, "rev-parse", "HEAD");
    const storeBlob = vi.fn(async (filePath: string, contents: Buffer) => ({
      type: "blob" as const,
      gcsPath: `customers/jack/${filePath}`,
      size: contents.length,
      mimeType: "image/png",
      uploadedAt: "2026-07-20T00:00:00.000Z",
    }));

    const applied = await applyAgentImportRepository({
      sourceDir: source,
      sourceHead,
      targetDir: target,
      destinationHead,
      importId: "import-123",
      slug: "jack",
      storeBlob,
      push: false,
    });

    expect(git(target, "rev-list", "--parents", "-n", "1", applied.importCommit).split(" "))
      .toEqual([applied.importCommit, destinationHead, sourceHead]);
    expect(fs.readFileSync(path.join(target, "AGENTS.md"), "utf8")).toBe("# Moof\n");
    expect(fs.readFileSync(path.join(target, "README.md"), "utf8")).toBe("source readme\n");
    expect(fs.readFileSync(path.join(target, "projects/existing/PROJECT.md"), "utf8")).toBe("keep project\n");
    expect(fs.existsSync(path.join(target, "photo.png"))).toBe(false);
    expect(JSON.parse(fs.readFileSync(path.join(target, ".files/manifest.json"), "utf8")))
      .toMatchObject({
        "avatar.png": { gcsPath: "customers/jack/avatar.png" },
        "photo.png": { gcsPath: "customers/jack/photo.png", size: 7 },
      });
    expect(fs.readFileSync(path.join(target, ".gitignore"), "utf8")).toContain("node_modules/");
    expect(fs.readFileSync(path.join(target, ".gitignore"), "utf8")).toContain("projects/*/.git/");
    expect(storeBlob).toHaveBeenCalledWith("photo.png", expect.any(Buffer), "image/png");
    expect(git(target, "rev-parse", "refs/octogee/imports/import-123/source")).toBe(sourceHead);
  });

  it("atomically publishes the imported main branch and provenance refs", async () => {
    const source = repo("agent-import-source", { "AGENTS.md": "Moof\n" });
    const sourceHead = git(source, "rev-parse", "HEAD");
    const target = repo("agent-import-target", { "README.md": "starter\n" });
    const destinationHead = git(target, "rev-parse", "HEAD");
    const remote = temp("agent-import-remote");
    git(remote, "init", "-q", "--bare");
    git(target, "remote", "add", "origin", remote);
    git(target, "push", "-q", "-u", "origin", "main");

    const applied = await applyAgentImportRepository({
      sourceDir: source,
      sourceHead,
      targetDir: target,
      destinationHead,
      importId: "import-push",
      slug: "jack",
      storeBlob: vi.fn(),
    });

    expect(git(remote, "rev-parse", "refs/heads/main")).toBe(applied.importCommit);
    expect(git(remote, "rev-parse", "refs/octogee/imports/import-push/source")).toBe(sourceHead);
    expect(git(remote, "rev-parse", "refs/octogee/imports/import-push/commit")).toBe(applied.importCommit);
  });

  it("rejects a stale destination preview instead of overwriting new work", async () => {
    const source = repo("agent-import-source", { "AGENTS.md": "Moof\n" });
    const target = repo("agent-import-target", { "README.md": "starter\n" });
    const staleHead = git(target, "rev-parse", "HEAD");
    fs.writeFileSync(path.join(target, "new.md"), "new\n");
    git(target, "add", "new.md");
    git(target, "commit", "-q", "-m", "new target work");

    await expect(applyAgentImportRepository({
      sourceDir: source,
      sourceHead: git(source, "rev-parse", "HEAD"),
      targetDir: target,
      destinationHead: staleHead,
      importId: "import-stale",
      slug: "jack",
      storeBlob: vi.fn(),
      push: false,
    })).rejects.toMatchObject({ code: "destination_changed" });
  });

  it("returns the exact prior import when a checkpoint retry sees its own merge commit", async () => {
    const source = repo("agent-import-source", { "AGENTS.md": "Moof\n" });
    const sourceHead = git(source, "rev-parse", "HEAD");
    const target = repo("agent-import-target", { "README.md": "starter\n" });
    const destinationHead = git(target, "rev-parse", "HEAD");
    const storeBlob = vi.fn();
    const first = await applyAgentImportRepository({
      sourceDir: source,
      sourceHead,
      targetDir: target,
      destinationHead,
      importId: "import-retry",
      slug: "jack",
      storeBlob,
      push: false,
    });

    const retried = await applyAgentImportRepository({
      sourceDir: source,
      sourceHead,
      targetDir: target,
      destinationHead,
      importId: "import-retry",
      slug: "jack",
      storeBlob,
      push: false,
    });

    expect(retried).toEqual(first);
    expect(storeBlob).not.toHaveBeenCalled();
    expect(git(target, "rev-list", "--count", "main")).toBe("3");
  });

  it("rolls back with a forward commit only while the import commit is still current", async () => {
    const source = repo("agent-import-source", { "AGENTS.md": "Moof\n" });
    const target = repo("agent-import-target", { "README.md": "starter\n" });
    const destinationHead = git(target, "rev-parse", "HEAD");
    const applied = await applyAgentImportRepository({
      sourceDir: source,
      sourceHead: git(source, "rev-parse", "HEAD"),
      targetDir: target,
      destinationHead,
      importId: "import-rollback",
      slug: "jack",
      storeBlob: vi.fn(),
      push: false,
    });

    const rolledBack = await rollbackAgentImportRepository({
      targetDir: target,
      importCommit: applied.importCommit,
      destinationHead,
      importId: "import-rollback",
      push: false,
    });
    expect(git(target, "rev-list", "--parents", "-n", "1", rolledBack.rollbackCommit).split(" "))
      .toEqual([rolledBack.rollbackCommit, applied.importCommit]);
    expect(fs.readFileSync(path.join(target, "README.md"), "utf8")).toBe("starter\n");

    await expect(rollbackAgentImportRepository({
      targetDir: target,
      importCommit: applied.importCommit,
      destinationHead,
      importId: "import-rollback",
      push: false,
    })).rejects.toMatchObject({ code: "rollback_window_closed" });
  });
});

describe("scanAgentImportSecrets", () => {
  it("returns redacted finding coordinates and never returns match values", async () => {
    const source = repo("agent-import-scan", { "MEMORY.md": "memory\n" });
    const run = vi.fn((_command: string, args: string[], options: { env?: NodeJS.ProcessEnv }) => {
      expect(options.env).not.toHaveProperty("OPENCLAW_GATEWAY_TOKEN");
      const reportPath = args[args.indexOf("--report-path") + 1];
      fs.writeFileSync(reportPath, JSON.stringify([{
        RuleID: "github-pat",
        File: "MEMORY.md",
        Commit: "a".repeat(40),
        Secret: "ghp_must_not_escape",
        Match: "ghp_must_not_escape",
      }]));
      return { status: 1, stdout: "", stderr: "" };
    });

    const prior = process.env.OPENCLAW_GATEWAY_TOKEN;
    process.env.OPENCLAW_GATEWAY_TOKEN = "pod-secret";
    const findings = await scanAgentImportSecrets(source, { run });
    if (prior === undefined) delete process.env.OPENCLAW_GATEWAY_TOKEN;
    else process.env.OPENCLAW_GATEWAY_TOKEN = prior;
    expect(findings).toEqual([{
      ruleId: "github-pat",
      path: "MEMORY.md",
      commit: "a".repeat(40),
    }]);
    expect(JSON.stringify(findings)).not.toContain("ghp_must_not_escape");
  });

  it("fails closed when the scanner is unavailable", async () => {
    const source = repo("agent-import-scan", { "MEMORY.md": "memory\n" });
    await expect(scanAgentImportSecrets(source, {
      run: vi.fn(() => ({ status: null, stdout: "", stderr: "", error: new Error("ENOENT") })),
    })).rejects.toBeInstanceOf(AgentImportGitError);
  });
});
