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
  OPENCLAW_DIR: "/tmp/octogee-test",
  CUSTOMERS_DIR: "/tmp/octogee-test/customers-doesnt-exist",
  CUSTOMER_KEYS_DIR: "/tmp/octogee-test/keys",
  AGENTS_DIR: "/tmp/octogee-test/agents",
}));

const { externalizeCustomerGitDir, gitExec, setRepoSshCommand } = await import("../lib/git.js");

function fetchCanonicalFrom(remote: string) {
  return (_repoDir: string, gitDir: string) => {
    execFileSync(
      "/usr/bin/git",
      ["--git-dir", gitDir, "fetch", remote, "+refs/heads/*:refs/remotes/origin/*"],
      { env: process.env },
    );
  };
}

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

  it("refuses clean-filter config before git add can execute repository-controlled code", () => {
    const marker = path.join(repo, "filter-ran");
    execFileSync("git", ["config", "filter.octogee-test.clean", `touch ${marker}; cat`], {
      cwd: repo,
      env: process.env,
    });
    fs.writeFileSync(path.join(repo, ".gitattributes"), "payload.txt filter=octogee-test\n");
    fs.writeFileSync(path.join(repo, "payload.txt"), "payload\n");

    expect(gitExec(repo, ["add", "-A"])).toBeNull();
    expect(fs.existsSync(marker)).toBe(false);
  });

  it("fails closed when the repository-local config is malformed", () => {
    fs.appendFileSync(path.join(repo, ".git", "config"), "\n[broken\n");

    expect(gitExec(repo, ["status", "--porcelain"])).toBeNull();
  });

  it("ignores agent-writable Git pointers and uses platform-owned customer metadata", () => {
    const customerRepo = "/tmp/octogee-test/customers-doesnt-exist/alice";
    const metadataRoot = "/tmp/octogee-test/git-metadata/alice";
    fs.rmSync(customerRepo, { recursive: true, force: true });
    fs.rmSync(metadataRoot, { recursive: true, force: true });
    fs.mkdirSync(customerRepo, { recursive: true });
    try {
      execFileSync("git", ["init", "-b", "main", "."], { cwd: customerRepo, env: process.env });
      execFileSync("git", ["config", "user.email", "test@octogee.test"], {
        cwd: customerRepo,
        env: process.env,
      });
      execFileSync("git", ["config", "user.name", "tester"], { cwd: customerRepo, env: process.env });
      execFileSync("git", ["remote", "add", "origin", "ssh://attacker.invalid/loot.git"], {
        cwd: customerRepo,
        env: process.env,
      });
      execFileSync("git", ["config", "remote.origin.pushurl", "ssh://attacker.invalid/push.git"], {
        cwd: customerRepo,
        env: process.env,
      });
      const canonical = fs.mkdtempSync(path.join(os.tmpdir(), "git-exec-canonical-"));
      fs.rmSync(canonical, { recursive: true, force: true });
      execFileSync("git", ["clone", "--bare", customerRepo, canonical], { env: process.env });
      setRepoSshCommand(customerRepo, "alice", { fetchCanonical: fetchCanonicalFrom(canonical) });
      const trustedGitDir = "/tmp/octogee-test/git-metadata/alice/workspace.git";
      expect(execFileSync("git", ["config", "--file", path.join(trustedGitDir, "config"), "remote.origin.url"], {
        encoding: "utf8",
        env: process.env,
      }).trim()).toBe("git@gitea.test:alice/workspace.git");
      expect(() => execFileSync(
        "git",
        ["config", "--file", path.join(trustedGitDir, "config"), "remote.origin.pushurl"],
        { encoding: "utf8", env: process.env },
      )).toThrow();

      const attacker = fs.mkdtempSync(path.join(os.tmpdir(), "git-exec-attacker-"));
      const marker = path.join(customerRepo, "filter-ran");
      execFileSync("git", ["init", "-q", attacker], { env: process.env });
      execFileSync("git", ["config", "filter.octogee-test.clean", `touch ${marker}; cat`], {
        cwd: attacker,
        env: process.env,
      });
      fs.chmodSync(path.join(customerRepo, ".git"), 0o644);
      fs.writeFileSync(path.join(customerRepo, ".git"), `gitdir: ${path.join(attacker, ".git")}\n`);
      fs.writeFileSync(path.join(customerRepo, ".gitattributes"), "payload.txt filter=octogee-test\n");
      fs.writeFileSync(path.join(customerRepo, "payload.txt"), "payload\n");

      expect(gitExec(customerRepo, ["add", "-A"])).not.toBeNull();
      expect(fs.existsSync(marker)).toBe(false);
      fs.rmSync(attacker, { recursive: true, force: true });
      fs.rmSync(canonical, { recursive: true, force: true });
    } finally {
      fs.rmSync(customerRepo, { recursive: true, force: true });
      fs.rmSync(metadataRoot, { recursive: true, force: true });
    }
  });

  it("quarantines symlinked customer Git metadata without dereferencing it", () => {
    const customerRepo = "/tmp/octogee-test/customers-doesnt-exist/symlinked";
    const metadataRoot = "/tmp/octogee-test/git-metadata/symlinked";
    const quarantine = "/tmp/octogee-test/git-metadata-quarantine/symlinked";
    const attacker = fs.mkdtempSync(path.join(os.tmpdir(), "git-exec-symlink-attacker-"));
    fs.rmSync(customerRepo, { recursive: true, force: true });
    fs.rmSync(metadataRoot, { recursive: true, force: true });
    fs.rmSync(quarantine, { recursive: true, force: true });
    fs.mkdirSync(customerRepo, { recursive: true });
    execFileSync("git", ["init", "-q", attacker], { env: process.env });
    fs.symlinkSync(path.join(attacker, ".git"), path.join(customerRepo, ".git"));
    const canonical = fs.mkdtempSync(path.join(os.tmpdir(), "git-exec-empty-canonical-"));
    fs.rmSync(canonical, { recursive: true, force: true });
    execFileSync("git", ["init", "--bare", "--initial-branch=main", canonical], { env: process.env });
    try {
      expect(externalizeCustomerGitDir(customerRepo, {
        fetchCanonical: fetchCanonicalFrom(canonical),
      })).toBe(path.join(metadataRoot, "workspace.git"));
      expect(fs.lstatSync(path.join(metadataRoot, "workspace.git")).isDirectory()).toBe(true);
      expect(fs.existsSync(path.join(attacker, ".git"))).toBe(true);
      expect(fs.readdirSync(quarantine)).toHaveLength(1);
      expect(fs.lstatSync(path.join(quarantine, fs.readdirSync(quarantine)[0]!)).isSymbolicLink()).toBe(true);
    } finally {
      fs.rmSync(customerRepo, { recursive: true, force: true });
      fs.rmSync(metadataRoot, { recursive: true, force: true });
      fs.rmSync(quarantine, { recursive: true, force: true });
      fs.rmSync(attacker, { recursive: true, force: true });
      fs.rmSync(canonical, { recursive: true, force: true });
    }
  });
});
