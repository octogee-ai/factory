import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { reconcilePlatformInvariants } from "../lib/system-config-invariants.js";
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
      readAcceptedConfig: () => Buffer.from(acceptedBytes),
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
});
