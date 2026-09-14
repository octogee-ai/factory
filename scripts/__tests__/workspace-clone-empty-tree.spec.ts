import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";

vi.mock("../lib/config.js", async () => {
  const os = await import("node:os");
  const nodePath = await import("node:path");
  const root = nodePath.join(os.tmpdir(), `octogee-workspace-clone-${process.pid}`);
  return {
    log: () => {},
    dlog: () => {},
    GIT_API_URL: "https://gitea.test/api/v1",
    GIT_SSH_HOST: "gitea.test",
    OPENCLAW_DIR: root,
    CUSTOMERS_DIR: nodePath.join(root, "customers"),
    CUSTOMER_KEYS_DIR: nodePath.join(root, "keys"),
    AGENTS_DIR: nodePath.join(root, "agents"),
  };
});

const { OPENCLAW_DIR, CUSTOMERS_DIR } = await import("../lib/config.js");
const { cloneWorkspaceRepo, workspaceTreeState } = await import("../lib/git.js");

const SLUG = "bender";
const TRACKED = {
  "SOUL.md": "# SOUL.md - Who You Are\nYou're BenderEcho.\n",
  "MEMORY.md": "# MEMORY.md\n- Chris\n",
  "memory/2026-08-30.md": "notes\n",
};

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

function metadataDir(): string {
  return path.join(OPENCLAW_DIR, "git-metadata", SLUG, "workspace.git");
}

function seedCheckout(): string {
  const dest = path.join(CUSTOMERS_DIR, SLUG);
  fs.mkdirSync(dest, { recursive: true });
  fs.mkdirSync(path.dirname(metadataDir()), { recursive: true });
  git(dest, ["init", "-q", "-b", "main", "--separate-git-dir", metadataDir()]);
  fs.writeFileSync(`${metadataDir()}.octogee-trusted-v3`, "octogee-customer-git-v3\ngitea:workspace\n");
  git(dest, ["config", "user.email", "test@octogee.test"]);
  git(dest, ["config", "user.name", "Octogee Test"]);
  for (const [rel, body] of Object.entries(TRACKED)) {
    fs.mkdirSync(path.dirname(path.join(dest, rel)), { recursive: true });
    fs.writeFileSync(path.join(dest, rel), body);
  }
  git(dest, ["add", "-A"]);
  git(dest, ["commit", "-q", "-m", "canonical"]);
  return dest;
}

function emptyTree(dest: string): void {
  for (const entry of fs.readdirSync(dest)) {
    if (entry === ".git") continue;
    fs.rmSync(path.join(dest, entry), { recursive: true, force: true });
  }
}

beforeEach(() => {
  fs.rmSync(OPENCLAW_DIR, { recursive: true, force: true });
  fs.mkdirSync(CUSTOMERS_DIR, { recursive: true });
});

afterEach(() => {
  fs.rmSync(OPENCLAW_DIR, { recursive: true, force: true });
});

describe("cloneWorkspaceRepo on a directory that already has git metadata", () => {
  it("restores the tracked files when the working tree was emptied", async () => {
    const dest = seedCheckout();
    emptyTree(dest);
    expect(workspaceTreeState(dest)).toEqual({ tracked: 3, missing: 3 });

    await expect(cloneWorkspaceRepo(SLUG)).resolves.toBe(true);

    for (const [rel, body] of Object.entries(TRACKED)) {
      expect(fs.readFileSync(path.join(dest, rel), "utf8")).toBe(body);
    }
  });

  it("leaves a partially edited working tree alone", async () => {
    const dest = seedCheckout();
    fs.rmSync(path.join(dest, "memory/2026-08-30.md"));
    fs.writeFileSync(path.join(dest, "SOUL.md"), "edited locally\n");

    await expect(cloneWorkspaceRepo(SLUG)).resolves.toBe(true);

    expect(fs.existsSync(path.join(dest, "memory/2026-08-30.md"))).toBe(false);
    expect(fs.readFileSync(path.join(dest, "SOUL.md"), "utf8")).toBe("edited locally\n");
  });

  it("refuses to treat unreadable git metadata as a clone", async () => {
    const dest = path.join(CUSTOMERS_DIR, SLUG);
    fs.mkdirSync(dest, { recursive: true });
    fs.writeFileSync(path.join(dest, ".git"), `gitdir: ${metadataDir()}\n`);

    await expect(cloneWorkspaceRepo(SLUG)).resolves.toBe(false);
  });
});
