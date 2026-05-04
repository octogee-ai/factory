import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

import {
  gitDiff,
  gitLog,
  gitStatus,
  parseLog,
  parsePorcelain,
  resolveCustomerDir,
} from "../lib/workspace-git";

const NUL = String.fromCharCode(0x00);
const RS = String.fromCharCode(0x1e);
const US = String.fromCharCode(0x1f);

function git(cwd: string, args: string[]): void {
  const r = spawnSync("git", args, { cwd, encoding: "utf-8" });
  if (r.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
  }
}

async function makeRepo(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "wsgit-"));
  git(dir, ["init", "--initial-branch=main"]);
  git(dir, ["config", "user.email", "test@example.com"]);
  git(dir, ["config", "user.name", "test"]);
  await fs.writeFile(path.join(dir, "README.md"), "hello\n");
  git(dir, ["add", "."]);
  git(dir, ["commit", "-m", "initial"]);
  return dir;
}

describe("parsePorcelain", () => {
  it("returns [] for empty output", () => {
    expect(parsePorcelain("")).toEqual([]);
  });

  it("parses a single modified file", () => {
    expect(parsePorcelain(` M README.md${NUL}`)).toEqual([
      { path: "README.md", change: "modified" },
    ]);
  });

  it("parses untracked + added + deleted + modified mixed", () => {
    const stdout =
      `?? newfile.ts${NUL}` +
      ` M README.md${NUL}` +
      `A  staged.ts${NUL}` +
      ` D removed.ts${NUL}`;
    expect(parsePorcelain(stdout)).toEqual([
      { path: "newfile.ts", change: "untracked" },
      { path: "README.md", change: "modified" },
      { path: "staged.ts", change: "added" },
      { path: "removed.ts", change: "deleted" },
    ]);
  });

  it("collapses a renamed pair into one entry on the new path", () => {
    // Rename records have an old-path companion record.
    const stdout =
      `R  newname.ts${NUL}oldname.ts${NUL}` +
      ` M other.ts${NUL}`;
    expect(parsePorcelain(stdout)).toEqual([
      { path: "newname.ts", change: "renamed" },
      { path: "other.ts", change: "modified" },
    ]);
  });

  it("collapses a copy (C) record's old-path companion the same way as rename (P1-5)", () => {
    const stdout =
      `C  copied.ts${NUL}original.ts${NUL}` +
      ` M unrelated.ts${NUL}`;
    expect(parsePorcelain(stdout)).toEqual([
      { path: "copied.ts", change: "renamed" },
      { path: "unrelated.ts", change: "modified" },
    ]);
  });
});

describe("parseLog", () => {
  it("returns [] for empty input", () => {
    expect(parseLog("")).toEqual([]);
  });

  it("parses sha, author, ts, subject from one record", () => {
    const stdout = `abc123${US}Alice${US}1730000000${US}Initial${RS}`;
    expect(parseLog(stdout)).toEqual([
      { sha: "abc123", author: "Alice", ts: 1730000000, subject: "Initial" },
    ]);
  });

  it("parses multiple records in order", () => {
    const stdout =
      `sha2${US}Bob${US}1730000200${US}second${RS}` +
      `sha1${US}Alice${US}1730000100${US}first${RS}`;
    expect(parseLog(stdout)).toEqual([
      { sha: "sha2", author: "Bob", ts: 1730000200, subject: "second" },
      { sha: "sha1", author: "Alice", ts: 1730000100, subject: "first" },
    ]);
  });

  it("skips records with non-numeric timestamps (defensive)", () => {
    const stdout =
      `sha${US}name${US}not-a-number${US}subj${RS}` +
      `ok${US}A${US}1730000000${US}good${RS}`;
    expect(parseLog(stdout)).toEqual([
      { sha: "ok", author: "A", ts: 1730000000, subject: "good" },
    ]);
  });
});

describe("resolveCustomerDir", () => {
  let repo: string;
  let root: string;
  beforeAll(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "wsroot-"));
    const slugDir = path.join(root, "alice");
    await fs.mkdir(slugDir);
    spawnSync("git", ["init", slugDir]);
    repo = slugDir;
  });
  afterAll(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it("returns the dir when it exists and contains .git", async () => {
    expect(await resolveCustomerDir(root, "alice")).toBe(repo);
  });

  it("returns null for a missing slug dir", async () => {
    expect(await resolveCustomerDir(root, "nope")).toBeNull();
  });

  it("returns null when the dir lacks .git (not a working tree)", async () => {
    const slugDir = path.join(root, "no-git");
    await fs.mkdir(slugDir);
    expect(await resolveCustomerDir(root, "no-git")).toBeNull();
  });

  it("rejects slugs containing path-traversal segments", async () => {
    expect(await resolveCustomerDir(root, "..")).toBeNull();
    expect(await resolveCustomerDir(root, "alice/..")).toBeNull();
    expect(await resolveCustomerDir(root, "../etc/passwd")).toBeNull();
  });
});

describe("gitStatus / gitDiff / gitLog (real git)", () => {
  let repo: string;
  beforeAll(async () => {
    repo = await makeRepo();
  });
  afterAll(async () => {
    await fs.rm(repo, { recursive: true, force: true });
  });

  it("status: clean tree is empty", async () => {
    const r = await gitStatus(repo);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.entries).toEqual([]);
  });

  it("status: single modified file shows up correctly", async () => {
    await fs.writeFile(path.join(repo, "README.md"), "changed\n");
    const r = await gitStatus(repo);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.entries).toEqual([{ path: "README.md", change: "modified" }]);
  });

  it("diff: returns non-empty unified diff for a modified file", async () => {
    const r = await gitDiff(repo, { path: "README.md" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.diff).toContain("--- a/README.md");
    expect(r.diff).toContain("+changed");
  });

  it("log: returns one entry for the initial commit", async () => {
    const r = await gitLog(repo, { limit: 5 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.entries).toHaveLength(1);
    expect(r.entries[0].subject).toBe("initial");
    expect(r.entries[0].author).toBe("test");
    expect(r.entries[0].sha).toMatch(/^[0-9a-f]{40}$/);
    expect(r.entries[0].ts).toBeGreaterThan(0);
  });

  it("status: NOT_A_REPO error when called against a non-git dir", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "noregit-"));
    try {
      const r = await gitStatus(dir);
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.error.code).toBe("NOT_A_REPO");
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("hardening: customer-controlled diff.external in .git/config is neutralized (P0-2)", async () => {
    // Plant a `diff.external` driver that, if invoked, would write a
    // canary file. Run `git diff` and confirm the canary doesn't exist —
    // the hardening pin `-c diff.external=` overrides the repo config.
    const canary = path.join(repo, ".pwned-canary");
    const driver = path.join(repo, "evil-driver.sh");
    await fs.writeFile(driver, `#!/bin/sh\ntouch "${canary}"\n`);
    await fs.chmod(driver, 0o755);
    git(repo, ["config", "diff.external", driver]);

    await fs.writeFile(path.join(repo, "README.md"), "trigger diff\n");
    const r = await gitDiff(repo, { path: "README.md" });
    expect(r.ok).toBe(true);

    // Canary must NOT exist — diff.external was suppressed.
    await expect(fs.access(canary)).rejects.toThrow();

    // Cleanup
    git(repo, ["config", "--unset", "diff.external"]);
    await fs.rm(driver, { force: true });
    await fs.writeFile(path.join(repo, "README.md"), "hello\n");
  });
});
