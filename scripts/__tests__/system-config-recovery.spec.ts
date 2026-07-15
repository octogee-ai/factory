import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";

import { reconcilePlatformInvariants } from "../lib/system-config-invariants.js";
import { readSystemConfigCommitBlob } from "../lib/system-config-durable-files.js";
import { recoverSystemConfigHead } from "../lib/system-config-recovery.js";
import { readSystemConfigStatus } from "../lib/system-config-status.js";
import { checkpointBootSystemConfigForSlug } from "../lib/system-config.js";

const dirs: string[] = [];
const env = {
  GATEWAY_CLASS: "builder",
  GATEWAY_ID: "bender",
  API_PUBLIC_URL: "https://api-test.octogee.com",
  GATEWAY_REVISION_ID: "bender-r9",
  OPENCLAW_VERSION: "2026.7.1",
};

function validConfig(extra: Record<string, unknown> = {}): string {
  const value = { ...extra };
  reconcilePlatformInvariants(value, env);
  return `${JSON.stringify(value, null, 2)}\n`;
}

function fixture(activeContents: string): { openclawDir: string; repoDir: string; configPath: string } {
  const openclawDir = fs.mkdtempSync(path.join(os.tmpdir(), "octogee-config-recovery-"));
  dirs.push(openclawDir);
  const repoDir = path.join(openclawDir, "system_config");
  fs.mkdirSync(path.join(repoDir, ".git"), { recursive: true });
  const configPath = path.join(repoDir, "openclaw.json");
  fs.writeFileSync(configPath, activeContents);
  fs.writeFileSync(path.join(repoDir, ".octogee.json"), '{"schemaVersion":1}\n');
  fs.writeFileSync(path.join(repoDir, ".gitignore"), "*.bak\n*.tmp\n");
  return { openclawDir, repoDir, configPath };
}

function git(repoDir: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: repoDir, encoding: "utf8" }).trim();
}

function realGitFixture(configContents = validConfig({ accepted: true })) {
  const openclawDir = fs.mkdtempSync(path.join(os.tmpdir(), "octogee-config-real-git-"));
  dirs.push(openclawDir);
  const repoDir = path.join(openclawDir, "system_config");
  fs.mkdirSync(repoDir, { recursive: true });
  git(repoDir, "init", "-b", "main");
  git(repoDir, "config", "user.email", "test@octogee.test");
  git(repoDir, "config", "user.name", "Octogee Test");
  const configPath = path.join(repoDir, "openclaw.json");
  fs.writeFileSync(configPath, configContents);
  fs.writeFileSync(path.join(repoDir, ".octogee.json"), '{"schemaVersion":1}\n');
  fs.writeFileSync(path.join(repoDir, ".gitignore"), "*.bak\n*.tmp\n");
  git(repoDir, "add", "openclaw.json", ".octogee.json", ".gitignore");
  git(repoDir, "commit", "-m", "accepted");
  return { openclawDir, repoDir, configPath, acceptedCommit: git(repoDir, "rev-parse", "HEAD") };
}

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("system config accepted-head recovery", () => {
  it("reads exact committed durable blobs without trimming trailing newlines", () => {
    const h = realGitFixture();

    expect(readSystemConfigCommitBlob(h.repoDir, h.acceptedCommit, "openclaw.json"))
      .toEqual(fs.readFileSync(h.configPath));
    expect(readSystemConfigCommitBlob(h.repoDir, h.acceptedCommit, ".octogee.json"))
      .toEqual(Buffer.from('{"schemaVersion":1}\n'));
    expect(readSystemConfigCommitBlob(h.repoDir, h.acceptedCommit, ".gitignore"))
      .toEqual(Buffer.from("*.bak\n*.tmp\n"));
  });

  it("recovers from a real accepted ancestor while preserving exact support-file bytes", () => {
    const h = realGitFixture(validConfig({ ancestor: true }));
    const remoteDir = fs.mkdtempSync(path.join(os.tmpdir(), "octogee-config-real-remote-"));
    dirs.push(remoteDir);
    execFileSync("git", ["init", "--bare", remoteDir]);
    git(h.repoDir, "remote", "add", "origin", remoteDir);
    fs.writeFileSync(h.configPath, "not-json\n");
    git(h.repoDir, "add", "openclaw.json");
    git(h.repoDir, "commit", "-m", "invalid head");
    git(h.repoDir, "push", "-u", "origin", "main");

    expect(recoverSystemConfigHead({
      ...h,
      slug: "ceckert",
      env,
      validateConfig: vi.fn(),
    })).toMatchObject({
      outcome: "recovered",
      recoveredFromCommit: h.acceptedCommit,
    });
    expect(fs.readFileSync(path.join(h.repoDir, ".octogee.json")))
      .toEqual(Buffer.from('{"schemaVersion":1}\n'));
    expect(fs.readFileSync(path.join(h.repoDir, ".gitignore")))
      .toEqual(Buffer.from("*.bak\n*.tmp\n"));
  });
  it("appends and pushes a recovery commit from the newest valid ancestor", () => {
    const h = fixture('{"gateway":{"port":9999}}\n');
    const commands: string[] = [];
    let head = "bad111";
    const newestValidAncestor = "b".repeat(40);
    const olderValidAncestor = "c".repeat(40);
    const gitExec = vi.fn((_cwd: string, command: string) => {
      commands.push(command);
      if (command === "rev-parse HEAD") return head;
      if (command === "rev-list HEAD") return `bad111\n${newestValidAncestor}\n${olderValidAncestor}`;
      if (command === `show ${newestValidAncestor}:openclaw.json`) return '{"customerSetting":true}\n';
      if (command === `show ${olderValidAncestor}:openclaw.json`) return validConfig({ customerSetting: false });
      if (command === `show ${newestValidAncestor}:.octogee.json` ||
          command === `show ${olderValidAncestor}:.octogee.json`) return '{"schemaVersion":1}\n';
      if (command === `show ${newestValidAncestor}:.gitignore` ||
          command === `show ${olderValidAncestor}:.gitignore`) return "*.bak\n*.tmp\n";
      if (command.startsWith("add ")) return "";
      if (command.startsWith("commit ")) {
        head = "recovered444";
        return "";
      }
      if (command === "push origin main") return "";
      return null;
    });

    const result = recoverSystemConfigHead({
      ...h,
      slug: "ceckert",
      env,
      gitExec,
      validateConfig: (candidatePath) => {
        const parsed = JSON.parse(fs.readFileSync(candidatePath, "utf8")) as Record<string, unknown>;
        if (parsed.customerSetting === undefined) throw new Error("invalid head");
      },
      now: () => new Date("2026-07-14T20:00:00.000Z"),
    });

    expect(result).toEqual({
      outcome: "recovered",
      rejectedCommit: "bad111",
      recoveredFromCommit: newestValidAncestor,
      acceptedCommit: "recovered444",
    });
    expect(JSON.parse(fs.readFileSync(h.configPath, "utf8"))).toMatchObject({ customerSetting: true });
    expect(JSON.parse(fs.readFileSync(h.configPath, "utf8"))).toMatchObject({
      gateway: {
        port: 18789,
        controlUi: { basePath: "/g/bender/openclaw" },
      },
    });
    expect(commands.some((command) => command.includes("Octogee-Config-Source: recovery"))).toBe(true);
    expect(commands.some((command) => command.includes("Octogee-Gateway-Revision: bender-r9"))).toBe(true);
    expect(commands.some((command) => command.includes("OpenClaw-Version: 2026.7.1"))).toBe(true);
    expect(commands.at(-1)).toBe("rev-parse HEAD");
  });

  it("keeps the rejected head available for repair when no valid ancestor exists", () => {
    const h = fixture("not-json\n");
    const gitExec = vi.fn((_cwd: string, command: string) => {
      if (command === "rev-parse HEAD") return "bad111";
      if (command === "rev-list HEAD") return "bad111\nbad000";
      if (command === "show bad000:openclaw.json") return '{"gateway":{"port":1}}\n';
      return null;
    });

    expect(recoverSystemConfigHead({
      ...h,
      slug: "ceckert",
      env,
      gitExec,
      validateConfig: () => {
        throw new Error("invalid");
      },
    })).toEqual({ outcome: "unavailable", rejectedCommit: "bad111" });
    expect(fs.readFileSync(h.configPath, "utf8")).toBe("not-json\n");
    expect(gitExec).not.toHaveBeenCalledWith(h.repoDir, expect.stringMatching(/^commit /), expect.anything());
  });

  it("ignores non-SHA recovery history entries before building a git show command", () => {
    const h = fixture("not-json\n");
    const gitExec = vi.fn((_cwd: string, command: string) => {
      if (command === "rev-parse HEAD") return "a".repeat(40);
      if (command === "rev-list HEAD") return `${"a".repeat(40)}\n--help`;
      return null;
    });

    expect(recoverSystemConfigHead({
      ...h,
      slug: "ceckert",
      env,
      gitExec,
      validateConfig: vi.fn(() => {
        throw new Error("invalid");
      }),
    })).toMatchObject({ outcome: "unavailable" });
    expect(gitExec).not.toHaveBeenCalledWith(h.repoDir, "show --help:openclaw.json", expect.anything());
  });

  it("records the current head when it already passes policy and validation", () => {
    const h = fixture(validConfig({ harmless: "value" }));
    const gitExec = vi.fn((_cwd: string, command: string) => command === "rev-parse HEAD" ? "good222" : null);

    expect(recoverSystemConfigHead({
      ...h,
      slug: "ceckert",
      env,
      gitExec,
      validateConfig: vi.fn(),
    })).toEqual({ outcome: "accepted", acceptedCommit: "good222" });
  });

  it("restores a valid committed HEAD after Doctor mutates the worktree without creating commits", () => {
    const h = fixture(validConfig({ doctorMutation: true }));
    const head = "a".repeat(40);
    const acceptedConfig = validConfig({ acceptedHead: true });
    const commands: string[] = [];
    const gitExec = vi.fn((_cwd: string, command: string) => {
      commands.push(command);
      if (command === "rev-parse HEAD") return head;
      if (command === `show ${head}:openclaw.json`) return acceptedConfig;
      if (command === `show ${head}:.octogee.json`) return '{"schemaVersion":1}\n';
      if (command === `show ${head}:.gitignore`) return "*.bak\n*.tmp\n";
      return null;
    });
    const options = {
      ...h,
      slug: "ceckert",
      env,
      gitExec,
      validateConfig: vi.fn(),
      acceptCurrent: false,
    };

    expect(recoverSystemConfigHead(options)).toEqual({ outcome: "accepted", acceptedCommit: head });
    expect(fs.readFileSync(h.configPath, "utf8")).toBe(acceptedConfig);
    fs.writeFileSync(h.configPath, validConfig({ secondDoctorMutation: true }));
    expect(recoverSystemConfigHead(options)).toEqual({ outcome: "accepted", acceptedCommit: head });
    expect(fs.readFileSync(h.configPath, "utf8")).toBe(acceptedConfig);
    expect(commands).not.toContain("rev-list HEAD");
    expect(commands.join("\n")).not.toMatch(/^(?:add|commit|push) /m);
  });

  it("restores valid committed HEAD before older history when ordinary working bytes are invalid", () => {
    const h = fixture("not-json\n");
    const head = "d".repeat(40);
    const acceptedConfig = validConfig({ acceptedHead: true });
    const commands: string[] = [];
    const gitExec = vi.fn((_cwd: string, command: string) => {
      commands.push(command);
      if (command === "rev-parse HEAD") return head;
      if (command === `show ${head}:openclaw.json`) return acceptedConfig;
      if (command === `show ${head}:.octogee.json`) return '{"schemaVersion":1}\n';
      if (command === `show ${head}:.gitignore`) return "*.bak\n*.tmp\n";
      return null;
    });

    expect(recoverSystemConfigHead({
      ...h,
      slug: "ceckert",
      env,
      gitExec,
      validateConfig: vi.fn(),
    })).toEqual({ outcome: "accepted", acceptedCommit: head });
    expect(fs.readFileSync(h.configPath, "utf8")).toBe(acceptedConfig);
    expect(commands).not.toContain("rev-list HEAD");
    expect(commands.join("\n")).not.toMatch(/^(?:add|commit|push) /m);
  });

  it("reconciles boot invariants before an attributed migration checkpoint", () => {
    const h = fixture('{"gateway":{"port":9000},"customerSetting":true}\n');
    const recover = vi.fn(() => ({ outcome: "accepted", acceptedCommit: "good222" } as const));
    const sync = vi.fn(() => ({
      committed: true,
      pushed: true,
      acceptedCommit: "boot333",
      configHash: "hash",
    }));

    expect(checkpointBootSystemConfigForSlug("ceckert", {
      openclawDir: h.openclawDir,
      env,
      validateConfig: vi.fn(),
      recover,
      sync,
      verifyAcceptedDurableSet: () => true,
    })).toMatchObject({ ready: true, acceptedCommit: "boot333" });
    expect(JSON.parse(fs.readFileSync(h.configPath, "utf8"))).toMatchObject({
      gateway: { port: 18789, mode: "local", bind: "lan" },
      customerSetting: true,
    });
    expect(sync).toHaveBeenCalledWith("ceckert", expect.objectContaining({
      durablePolicy: true,
      source: "boot-migration",
    }));
    expect(readSystemConfigStatus(h.openclawDir)).not.toHaveProperty("doctorResult");
  });

  it("records Doctor success only when the caller supplies an observed successful result", () => {
    const h = fixture(validConfig({ harmless: true }));

    expect(checkpointBootSystemConfigForSlug("ceckert", {
      openclawDir: h.openclawDir,
      env,
      doctorResult: "ok",
      validateConfig: vi.fn(),
      recover: () => ({ outcome: "accepted", acceptedCommit: "a".repeat(40) }),
      sync: () => ({
        committed: true,
        pushed: true,
        acceptedCommit: "b".repeat(40),
      }),
      verifyAcceptedDurableSet: () => true,
    })).toMatchObject({ ready: true });
    expect(readSystemConfigStatus(h.openclawDir)).toMatchObject({ doctorResult: "ok" });
  });

  it("keeps a locally accepted config unready while a transient Gitea push remains pending", () => {
    const h = fixture(validConfig({ harmless: true }));

    expect(checkpointBootSystemConfigForSlug("ceckert", {
      openclawDir: h.openclawDir,
      env,
      validateConfig: vi.fn(),
      recover: () => ({ outcome: "accepted", acceptedCommit: "a".repeat(40) }),
      sync: () => ({
        committed: true,
        pushed: false,
        pending: true,
        errorCode: "push-failed",
        acceptedCommit: "b".repeat(40),
      }),
    })).toEqual({ ready: false, errorCode: "push-failed" });
    expect(readSystemConfigStatus(h.openclawDir)).toMatchObject({
      state: "error",
      acceptedCommit: "b".repeat(40),
      lastErrorCode: "push-failed",
    });
  });

  it("retries the full boot pipeline after accepting an older pre-cleanup ancestor", () => {
    const h = fixture(validConfig({ current: true }));
    const sync = vi.fn();
    const legacy = {
      channels: {
        mattermost: {
          defaultAccount: "default",
          accounts: {
            default: {
              botToken: "${MM_BOT_TOKEN}",
              commands: { native: false },
            },
          },
        },
      },
    };
    const recover = vi.fn(() => {
      fs.writeFileSync(h.configPath, `${JSON.stringify(legacy, null, 2)}\n`);
      fs.writeFileSync(path.join(h.repoDir, ".octogee.json"), '{"schemaVersion":0}\n');
      return {
        outcome: "recovered" as const,
        rejectedCommit: "a".repeat(40),
        recoveredFromCommit: "b".repeat(40),
        acceptedCommit: "c".repeat(40),
      };
    });

    expect(checkpointBootSystemConfigForSlug("ceckert", {
      openclawDir: h.openclawDir,
      env,
      validateConfig: vi.fn(),
      recover,
      sync,
    })).toEqual({
      ready: false,
      errorCode: "accepted-ancestor-retry-required",
      rejectedCommit: "a".repeat(40),
    });
    expect(sync).not.toHaveBeenCalled();
    expect(JSON.parse(fs.readFileSync(path.join(h.repoDir, ".octogee.json"), "utf8")))
      .toEqual({ schemaVersion: 0 });
    expect(fs.readFileSync(h.configPath, "utf8")).toContain("${MM_BOT_TOKEN}");
  });

  it("keeps boot unready when active durable bytes diverge after a successful push", () => {
    const h = fixture(validConfig({ harmless: true }));

    expect(checkpointBootSystemConfigForSlug("ceckert", {
      openclawDir: h.openclawDir,
      env,
      validateConfig: vi.fn(),
      recover: () => ({ outcome: "accepted", acceptedCommit: "a".repeat(40) }),
      sync: () => ({
        committed: true,
        pushed: true,
        acceptedCommit: "b".repeat(40),
      }),
      verifyAcceptedDurableSet: () => false,
    })).toEqual({ ready: false, errorCode: "post-push-durable-mismatch" });
    expect(readSystemConfigStatus(h.openclawDir)).toMatchObject({
      state: "error",
      lastErrorCode: "post-push-durable-mismatch",
    });
  });

  it("accepts a real pushed HEAD only when all three active durable files match exactly", () => {
    const h = realGitFixture();

    expect(checkpointBootSystemConfigForSlug("ceckert", {
      openclawDir: h.openclawDir,
      env,
      validateConfig: vi.fn(),
      recover: () => ({ outcome: "accepted", acceptedCommit: h.acceptedCommit }),
      sync: () => ({
        committed: false,
        pushed: true,
        acceptedCommit: h.acceptedCommit,
      }),
    })).toEqual({ ready: true, acceptedCommit: h.acceptedCommit });

    fs.writeFileSync(path.join(h.repoDir, ".gitignore"), "*.bak\n*.tmp");
    expect(checkpointBootSystemConfigForSlug("ceckert", {
      openclawDir: h.openclawDir,
      env,
      validateConfig: vi.fn(),
      recover: () => ({ outcome: "accepted", acceptedCommit: h.acceptedCommit }),
      sync: () => ({
        committed: false,
        pushed: true,
        acceptedCommit: h.acceptedCommit,
      }),
    })).toEqual({ ready: false, errorCode: "post-push-durable-mismatch" });
  });

  it("reconciles the latest committed config before considering an older ancestor", () => {
    const latest = "a".repeat(40);
    const ancestor = "b".repeat(40);
    const h = fixture('{"gateway":{"port":9000},"customerSetting":"latest"}\n');
    let head = latest;
    const gitExec = vi.fn((_cwd: string, command: string) => {
      if (command === "rev-parse HEAD") return head;
      if (command === "rev-list HEAD") return `${latest}\n${ancestor}`;
      if (command === `show ${latest}:openclaw.json`) {
        return '{"gateway":{"port":9000},"customerSetting":"latest"}\n';
      }
      if (command === `show ${ancestor}:openclaw.json`) {
        return validConfig({ customerSetting: "ancestor" });
      }
      if (command.endsWith(":.octogee.json")) return '{"schemaVersion":1}\n';
      if (command.endsWith(":.gitignore")) return "*.bak\n*.tmp\n";
      if (command.startsWith("add ")) return "";
      if (command.startsWith("commit ")) {
        head = "c".repeat(40);
        return "";
      }
      if (command === "push origin main") return "";
      return null;
    });

    expect(recoverSystemConfigHead({
      ...h,
      slug: "ceckert",
      env,
      gitExec,
      validateConfig: vi.fn(),
    })).toMatchObject({
      outcome: "recovered",
      rejectedCommit: latest,
      recoveredFromCommit: latest,
      acceptedCommit: "c".repeat(40),
    });
    expect(JSON.parse(fs.readFileSync(h.configPath, "utf8"))).toMatchObject({
      gateway: { port: 18789, mode: "local", bind: "lan" },
      customerSetting: "latest",
    });
    expect(gitExec.mock.calls.filter(([, command]) => command.startsWith("commit "))).toHaveLength(1);
    expect(gitExec.mock.calls.filter(([, command]) => command === "push origin main")).toHaveLength(1);
  });

  it("recovers a committed openclaw.json deletion from the newest complete ancestor", () => {
    const h = fixture(validConfig({ deletedAtHead: true }));
    fs.rmSync(h.configPath);
    const head = "a".repeat(40);
    const ancestor = "b".repeat(40);
    let recoveredHead = head;
    const gitExec = vi.fn((_cwd: string, command: string) => {
      if (command === "rev-parse HEAD") return recoveredHead;
      if (command === "rev-list HEAD") return `${head}\n${ancestor}`;
      if (command === `show ${ancestor}:openclaw.json`) return validConfig({ recovered: true });
      if (command === `show ${ancestor}:.octogee.json`) return '{"schemaVersion":1}\n';
      if (command === `show ${ancestor}:.gitignore`) return "*.bak\n*.tmp\n";
      if (command.startsWith("add ")) return "";
      if (command.startsWith("commit ")) {
        recoveredHead = "c".repeat(40);
        return "";
      }
      if (command === "push origin main") return "";
      return null;
    });

    expect(recoverSystemConfigHead({
      ...h,
      slug: "ceckert",
      env,
      gitExec,
      validateConfig: vi.fn(),
    })).toMatchObject({
      outcome: "recovered",
      rejectedCommit: head,
      recoveredFromCommit: ancestor,
      acceptedCommit: "c".repeat(40),
    });
    expect(JSON.parse(fs.readFileSync(h.configPath, "utf8"))).toMatchObject({ recovered: true });
  });

  it("skips a committed candidate with an unknown pending state cleanup", () => {
    const h = fixture("not-json\n");
    const head = "a".repeat(40);
    const ancestor = "b".repeat(40);
    let recoveredHead = head;
    const gitExec = vi.fn((_cwd: string, command: string) => {
      if (command === "rev-parse HEAD") return recoveredHead;
      if (command === "rev-list HEAD") return `${head}\n${ancestor}`;
      if (command === `show ${head}:openclaw.json`) return validConfig({ rejected: true });
      if (command === `show ${head}:.octogee.json`) {
        return '{"schemaVersion":1,"pendingStateCleanup":"unknown"}\n';
      }
      if (command === `show ${ancestor}:openclaw.json`) return validConfig({ recovered: true });
      if (command === `show ${ancestor}:.octogee.json`) return '{"schemaVersion":1}\n';
      if (command.endsWith(":.gitignore")) return "*.bak\n*.tmp\n";
      if (command.startsWith("add ")) return "";
      if (command.startsWith("commit ")) {
        recoveredHead = "c".repeat(40);
        return "";
      }
      if (command === "push origin main") return "";
      return null;
    });

    expect(recoverSystemConfigHead({
      ...h,
      slug: "ceckert",
      env,
      gitExec,
      validateConfig: vi.fn(),
    })).toMatchObject({
      outcome: "recovered",
      recoveredFromCommit: ancestor,
    });
    expect(JSON.parse(fs.readFileSync(h.configPath, "utf8"))).toMatchObject({ recovered: true });
  });

  it("rejects malformed current metadata and restores the complete accepted ancestor", () => {
    const h = fixture(validConfig({ current: true }));
    fs.writeFileSync(path.join(h.repoDir, ".octogee.json"), "{ invalid");
    const head = "a".repeat(40);
    const ancestor = "b".repeat(40);
    let recoveredHead = head;
    const gitExec = vi.fn((_cwd: string, command: string) => {
      if (command === "rev-parse HEAD") return recoveredHead;
      if (command === "rev-list HEAD") return `${head}\n${ancestor}`;
      if (command === `show ${ancestor}:openclaw.json`) return validConfig({ recovered: true });
      if (command === `show ${ancestor}:.octogee.json`) return '{"schemaVersion":1}\n';
      if (command === `show ${ancestor}:.gitignore`) return "*.bak\n*.tmp\n";
      if (command.startsWith("add ")) return "";
      if (command.startsWith("commit ")) {
        recoveredHead = "c".repeat(40);
        return "";
      }
      if (command === "push origin main") return "";
      return null;
    });

    expect(recoverSystemConfigHead({
      ...h,
      slug: "ceckert",
      env,
      gitExec,
      validateConfig: vi.fn(),
    })).toMatchObject({ outcome: "recovered", recoveredFromCommit: ancestor });
    expect(JSON.parse(fs.readFileSync(path.join(h.repoDir, ".octogee.json"), "utf8")))
      .toEqual({ schemaVersion: 1 });
  });

  it("keeps boot unavailable and observable when no accepted ancestor exists", () => {
    const h = fixture("not-json\n");
    const sync = vi.fn();

    expect(checkpointBootSystemConfigForSlug("ceckert", {
      openclawDir: h.openclawDir,
      env,
      validateConfig: vi.fn(),
      recover: () => ({ outcome: "unavailable", rejectedCommit: "bad111" }),
      sync,
    })).toEqual({
      ready: false,
      errorCode: "no-valid-ancestor",
      rejectedCommit: "bad111",
    });
    expect(sync).not.toHaveBeenCalled();
    expect(readSystemConfigStatus(h.openclawDir)).toMatchObject({
      state: "unavailable",
      bootRecovery: "unavailable",
      lastErrorCode: "no-valid-ancestor",
    });
  });
});
