import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";

import { reconcilePlatformInvariants } from "../lib/system-config-invariants.js";
import { readSystemConfigCommitBlob } from "../lib/system-config-durable-files.js";
import { readSystemConfigStatus } from "../lib/system-config-status.js";
import {
  auditSystemConfigForSlug,
  syncSystemConfigForSlug,
} from "../lib/system-config.js";

const dirs: string[] = [];
const env = {
  GATEWAY_CLASS: "builder",
  GATEWAY_ID: "bender",
  API_PUBLIC_URL: "https://api-test.octogee.com",
  GATEWAY_REVISION_ID: "bender-r8",
  OPENCLAW_VERSION: "2026.7.1",
};

function fixture(mutator?: (config: Record<string, unknown>) => void) {
  const openclawDir = fs.mkdtempSync(path.join(os.tmpdir(), "octogee-config-sync-"));
  dirs.push(openclawDir);
  const repoDir = path.join(openclawDir, "system_config");
  fs.mkdirSync(path.join(repoDir, ".git"), { recursive: true });
  const config: Record<string, unknown> = { customerSetting: true };
  reconcilePlatformInvariants(config, env);
  mutator?.(config);
  fs.writeFileSync(path.join(repoDir, "openclaw.json"), `${JSON.stringify(config, null, 2)}\n`);
  fs.writeFileSync(path.join(repoDir, ".octogee.json"), '{"schemaVersion":1}\n');
  fs.writeFileSync(path.join(repoDir, ".gitignore"), "*.tmp\n");
  return { openclawDir, repoDir };
}

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("system config sync hardening", () => {
  it("rejects a platform-invariant edit with typed paths and restores accepted bytes", () => {
    const h = fixture((config) => {
      (config.gateway as Record<string, unknown>).port = 9000;
    });
    const accepted = fixture().repoDir;
    const acceptedBytes = fs.readFileSync(path.join(accepted, "openclaw.json"), "utf8");
    const gitExec = vi.fn((_cwd: string, command: string) => {
      if (command.startsWith("status --porcelain")) return " M openclaw.json";
      if (command === "rev-parse HEAD") return "a".repeat(40);
      if (command.startsWith("ls-remote")) return `${"a".repeat(40)}\trefs/heads/main`;
      if (command === "show HEAD:openclaw.json") return acceptedBytes;
      return "";
    });

    const result = syncSystemConfigForSlug("ceckert", {
      openclawDir: h.openclawDir,
      env,
      durablePolicy: true,
      gitExec,
      setRepoSshCommand: vi.fn(),
      customerSshKeyPath: () => "/tmp/key",
      validateConfig: vi.fn(),
      readCommitBlob: () => Buffer.from(acceptedBytes),
    });

    expect(result).toMatchObject({
      rejected: true,
      errorCode: "platform-invariant-violation",
      policyPaths: ["gateway.port"],
    });
    expect(fs.readFileSync(path.join(h.repoDir, "openclaw.json"), "utf8")).toBe(acceptedBytes);
    expect(readSystemConfigStatus(h.openclawDir)).toMatchObject({
      state: "error",
      lastErrorCode: "platform-invariant-violation",
      rejectedCount: 1,
    });
  });

  it("rejects live config deletion and restores the complete accepted durable set", () => {
    const h = fixture();
    const runGit = (...args: string[]) => execFileSync("git", args, {
      cwd: h.repoDir,
      encoding: "utf8",
    }).trim();
    runGit("init", "-b", "main");
    runGit("config", "user.email", "test@octogee.test");
    runGit("config", "user.name", "Octogee Test");
    const accepted = {
      config: fs.readFileSync(path.join(h.repoDir, "openclaw.json")),
      metadata: Buffer.from('{"schemaVersion":1,"accepted":true}\n'),
      gitignore: Buffer.from("*.bak\n*.tmp\n"),
    };
    fs.writeFileSync(path.join(h.repoDir, ".octogee.json"), accepted.metadata);
    fs.writeFileSync(path.join(h.repoDir, ".gitignore"), accepted.gitignore);
    runGit("add", "openclaw.json", ".octogee.json", ".gitignore");
    runGit("commit", "-m", "accepted");
    fs.rmSync(path.join(h.repoDir, "openclaw.json"));
    fs.writeFileSync(path.join(h.repoDir, ".octogee.json"), '{"schemaVersion":1,"dirty":true}\n');
    fs.writeFileSync(path.join(h.repoDir, ".gitignore"), "*.tmp\n");
    const head = "a".repeat(40);
    const gitExec = vi.fn((_cwd: string, command: string) => {
      if (command === "rev-parse HEAD") return head;
      if (command.startsWith("ls-remote")) return `${head}\trefs/heads/main`;
      if (command.startsWith("status --porcelain")) {
        return " D openclaw.json\n M .octogee.json\n M .gitignore";
      }
      return "";
    });

    expect(syncSystemConfigForSlug("ceckert", {
      openclawDir: h.openclawDir,
      env,
      durablePolicy: true,
      gitExec,
      setRepoSshCommand: vi.fn(),
      customerSshKeyPath: () => "/tmp/key",
      validateConfig: vi.fn(),
      readCommitBlob: readSystemConfigCommitBlob,
    })).toMatchObject({
      committed: false,
      pushed: false,
      rejected: true,
      errorCode: "openclaw-json-missing",
    });
    expect(fs.readFileSync(path.join(h.repoDir, "openclaw.json"))).toEqual(accepted.config);
    expect(fs.readFileSync(path.join(h.repoDir, ".octogee.json"))).toEqual(accepted.metadata);
    expect(fs.readFileSync(path.join(h.repoDir, ".gitignore"))).toEqual(accepted.gitignore);
    expect(readSystemConfigStatus(h.openclawDir)).toMatchObject({
      state: "error",
      lastErrorCode: "openclaw-json-missing",
      rejectedCount: 1,
    });
    expect(gitExec).not.toHaveBeenCalledWith(h.repoDir, expect.stringMatching(/^add /), "/tmp/key");
  });

  it("restores a deleted active config before reporting a remote outage", () => {
    const h = fixture();
    const accepted = {
      "openclaw.json": fs.readFileSync(path.join(h.repoDir, "openclaw.json")),
      ".octogee.json": Buffer.from('{"schemaVersion":1}\n'),
      ".gitignore": Buffer.from("*.bak\n*.tmp\n"),
    };
    fs.rmSync(path.join(h.repoDir, "openclaw.json"));
    const head = "a".repeat(40);
    const gitExec = vi.fn((_cwd: string, command: string) => {
      if (command === "rev-parse HEAD") return head;
      if (command.startsWith("ls-remote")) return null;
      return "";
    });

    expect(syncSystemConfigForSlug("ceckert", {
      openclawDir: h.openclawDir,
      env,
      durablePolicy: true,
      gitExec,
      setRepoSshCommand: vi.fn(),
      customerSshKeyPath: () => "/tmp/key",
      validateConfig: vi.fn(),
      readCommitBlob: (_repoDir, _commit, filename) => accepted[filename],
    })).toMatchObject({
      pending: true,
      rejected: true,
      errorCode: "remote-head-unavailable",
    });
    expect(fs.readFileSync(path.join(h.repoDir, "openclaw.json"))).toEqual(accepted["openclaw.json"]);
    expect(readSystemConfigStatus(h.openclawDir)).toMatchObject({ rejectedCount: 1 });
  });

  it("uses attributed commits and records the accepted pushed head", () => {
    const h = fixture();
    let head = "a".repeat(40);
    const calls: string[] = [];
    const gitExec = vi.fn((_cwd: string, command: string) => {
      calls.push(command);
      if (command.startsWith("status --porcelain")) return " M openclaw.json";
      if (command === "rev-parse HEAD") return head;
      if (command.startsWith("ls-remote")) return `${"a".repeat(40)}\trefs/heads/main`;
      if (command.startsWith("add ")) return "";
      if (command.startsWith("commit ")) {
        head = "b".repeat(40);
        return "";
      }
      if (command === "push origin main") return "";
      return "";
    });

    expect(syncSystemConfigForSlug("ceckert", {
      openclawDir: h.openclawDir,
      env,
      durablePolicy: true,
      source: "auto-watch",
      gitExec,
      setRepoSshCommand: vi.fn(),
      customerSshKeyPath: () => "/tmp/key",
      validateConfig: vi.fn(),
      now: () => new Date("2026-07-14T20:00:00.000Z"),
    })).toMatchObject({ committed: true, pushed: true, acceptedCommit: "b".repeat(40) });

    expect(calls.find((command) => command.startsWith("commit "))).toContain(
      "Octogee-Config-Source: auto-watch",
    );
    expect(readSystemConfigStatus(h.openclawDir)).toMatchObject({
      state: "clean",
      acceptedCommit: "b".repeat(40),
      openclawVersion: "2026.7.1",
    });
  });

  it("returns the validated local head when its durable push remains pending", () => {
    const h = fixture();
    let head = "a".repeat(40);
    const gitExec = vi.fn((_cwd: string, command: string) => {
      if (command === "rev-parse HEAD") return head;
      if (command.startsWith("ls-remote")) return `${"a".repeat(40)}\trefs/heads/main`;
      if (command.startsWith("status --porcelain")) return " M openclaw.json";
      if (command.startsWith("add ")) return "";
      if (command.startsWith("commit ")) {
        head = "b".repeat(40);
        return "";
      }
      if (command === "push origin main") return null;
      if (command.startsWith("merge-base ")) return "a".repeat(40);
      return "";
    });

    expect(syncSystemConfigForSlug("ceckert", {
      openclawDir: h.openclawDir,
      env,
      durablePolicy: true,
      gitExec,
      setRepoSshCommand: vi.fn(),
      customerSshKeyPath: () => "/tmp/key",
      validateConfig: vi.fn(),
    })).toMatchObject({
      committed: true,
      pushed: false,
      pending: true,
      errorCode: "push-failed",
      acceptedCommit: "b".repeat(40),
    });
  });

  it("keeps retrying when a successful push cannot prove its accepted head", () => {
    const h = fixture();
    let headReads = 0;
    const gitExec = vi.fn((_cwd: string, command: string) => {
      if (command === "rev-parse HEAD") {
        headReads += 1;
        return headReads === 1 ? "a".repeat(40) : null;
      }
      if (command.startsWith("ls-remote")) return `${"a".repeat(40)}\trefs/heads/main`;
      if (command.startsWith("status --porcelain")) return "";
      if (command === "push origin main") return "";
      return "";
    });

    expect(syncSystemConfigForSlug("ceckert", {
      openclawDir: h.openclawDir,
      env,
      durablePolicy: true,
      gitExec,
      setRepoSshCommand: vi.fn(),
      customerSshKeyPath: () => "/tmp/key",
      validateConfig: vi.fn(),
    })).toMatchObject({
      committed: false,
      pushed: true,
      pending: true,
      errorCode: "accepted-head-unavailable",
    });
    expect(readSystemConfigStatus(h.openclawDir)).toMatchObject({
      state: "error",
      lastErrorCode: "accepted-head-unavailable",
    });
  });

  it("marks a non-fast-forward conflict and never pushes or force-pushes", () => {
    const h = fixture();
    const commands: string[] = [];
    const gitExec = vi.fn((_cwd: string, command: string) => {
      commands.push(command);
      if (command.startsWith("status --porcelain")) return "";
      if (command === "rev-parse HEAD") return "a".repeat(40);
      if (command.startsWith("ls-remote")) return `${"b".repeat(40)}\trefs/heads/main`;
      if (command.startsWith("merge-base ")) return "c".repeat(40);
      return "";
    });

    expect(syncSystemConfigForSlug("ceckert", {
      openclawDir: h.openclawDir,
      env,
      durablePolicy: true,
      gitExec,
      setRepoSshCommand: vi.fn(),
      customerSshKeyPath: () => "/tmp/key",
      validateConfig: vi.fn(),
    })).toMatchObject({
      committed: false,
      pushed: false,
      pending: true,
      errorCode: "non-fast-forward-conflict",
    });
    expect(commands).not.toContain("push origin main");
    expect(commands.join(" ")).not.toMatch(/force|--force/);
  });

  it("audits remote head, local head, index, worktree, and active hash", () => {
    const h = fixture();
    const head = "a".repeat(40);
    const gitExec = vi.fn((_cwd: string, command: string) => {
      if (command === "rev-parse HEAD") return head;
      if (command === "rev-parse HEAD^{tree}") return "tree-head";
      if (command === "write-tree") return "tree-index";
      if (command.startsWith("status --porcelain")) return " M .octogee.json";
      if (command.startsWith("ls-remote")) return `${head}\trefs/heads/main`;
      return null;
    });

    expect(auditSystemConfigForSlug("ceckert", {
      openclawDir: h.openclawDir,
      gitExec,
      customerSshKeyPath: () => "/tmp/key",
    })).toMatchObject({
      state: "dirty",
      needsSync: true,
      head,
      remoteHead: head,
      headTree: "tree-head",
      indexTree: "tree-index",
      worktreeDirty: true,
    });
  });

  it("audits a deleted live config as repairable error instead of unavailable checkout", () => {
    const h = fixture();
    fs.rmSync(path.join(h.repoDir, "openclaw.json"));

    expect(auditSystemConfigForSlug("ceckert", {
      openclawDir: h.openclawDir,
      gitExec: vi.fn(),
      customerSshKeyPath: () => "/tmp/key",
    })).toEqual({
      state: "error",
      needsSync: true,
      errorCode: "openclaw-json-missing",
    });
  });
});
