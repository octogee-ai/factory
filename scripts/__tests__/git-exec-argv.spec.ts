import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/config.js", () => ({
  log: () => {},
  dlog: () => {},
  GIT_API_URL: "https://gitea.test/api/v1",
  GIT_SSH_HOST: "gitea.test",
  CUSTOMERS_DIR: "/tmp/octogee-test/customers-doesnt-exist",
  CUSTOMER_KEYS_DIR: "/tmp/octogee-test/keys",
  AGENTS_DIR: "/tmp/octogee-test/agents",
}));

const { gitExec } = await import("../lib/git.js");

describe("gitExec argv semantics (no shell)", () => {
  const originalGitConfigGlobal = process.env.GIT_CONFIG_GLOBAL;
  const originalGitConfigSystem = process.env.GIT_CONFIG_SYSTEM;
  const originalPath = process.env.PATH;
  let repo: string;

  beforeEach(() => {
    process.env.GIT_CONFIG_GLOBAL = "/dev/null";
    process.env.GIT_CONFIG_SYSTEM = "/dev/null";
    repo = fs.mkdtempSync(path.join(os.tmpdir(), "git-exec-argv-"));
    execFileSync("git", ["init", "-b", "main", "."], { cwd: repo, env: process.env });
    execFileSync("git", ["config", "user.email", "test@octogee.test"], {
      cwd: repo,
      env: process.env,
    });
    execFileSync("git", ["config", "user.name", "tester"], { cwd: repo, env: process.env });
  });

  afterEach(() => {
    fs.rmSync(repo, { recursive: true, force: true });
    if (originalGitConfigGlobal === undefined) delete process.env.GIT_CONFIG_GLOBAL;
    else process.env.GIT_CONFIG_GLOBAL = originalGitConfigGlobal;
    if (originalGitConfigSystem === undefined) delete process.env.GIT_CONFIG_SYSTEM;
    else process.env.GIT_CONFIG_SYSTEM = originalGitConfigSystem;
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
  });

  it("passes hostile commit messages through as a single literal argument", () => {
    const hostile = `initial: pwn"; $(touch ${repo}/pwned) \`touch ${repo}/pwned2\` | ; && project created`;
    fs.writeFileSync(path.join(repo, "seed.txt"), "seed\n");
    gitExec(repo, ["add", "-A"]);

    const result = gitExec(repo, ["commit", "-m", hostile]);

    expect(result).not.toBeNull();
    const subject = execFileSync("git", ["log", "-1", "--pretty=%s"], {
      cwd: repo,
      encoding: "utf8",
      env: process.env,
    }).trim();
    expect(subject).toBe(hostile);
    expect(fs.existsSync(path.join(repo, "pwned"))).toBe(false);
    expect(fs.existsSync(path.join(repo, "pwned2"))).toBe(false);
  });

  it("stores committer identity containing quotes and backticks verbatim", () => {
    const name = 'Octo "The `Kraken`" (acme); rm -rf /';

    const result = gitExec(repo, ["config", "user.name", name]);

    expect(result).not.toBeNull();
    const stored = execFileSync("git", ["config", "--get", "user.name"], {
      cwd: repo,
      encoding: "utf8",
      env: process.env,
    }).trim();
    expect(stored).toBe(name);
  });

  it("keeps the null-on-failure contract for argv commands", () => {
    expect(gitExec(repo, ["checkout", "no-such-branch"])).toBeNull();
  });

  it("uses the trusted system git binary instead of PATH lookup", () => {
    const fakeBin = fs.mkdtempSync(path.join(os.tmpdir(), "git-exec-fake-bin-"));
    const marker = path.join(repo, "fake-git-ran");
    const fakeGit = path.join(fakeBin, "git");
    fs.writeFileSync(fakeGit, `#!/bin/sh\ntouch "${marker}"\nexit 1\n`);
    fs.chmodSync(fakeGit, 0o755);
    process.env.PATH = `${fakeBin}:${originalPath ?? ""}`;

    const result = gitExec(repo, ["rev-parse", "--is-inside-work-tree"]);

    expect(result).toBe("true");
    expect(fs.existsSync(marker)).toBe(false);
    fs.rmSync(fakeBin, { recursive: true, force: true });
  });
});
