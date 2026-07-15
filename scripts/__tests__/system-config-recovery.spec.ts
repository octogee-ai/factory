import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { reconcilePlatformInvariants } from "../lib/system-config-invariants.js";
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
  return { openclawDir, repoDir, configPath };
}

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("system config accepted-head recovery", () => {
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
    })).toMatchObject({ ready: true });
    expect(readSystemConfigStatus(h.openclawDir)).toMatchObject({ doctorResult: "ok" });
  });

  it("boots a locally accepted config while a transient Gitea push remains durably pending", () => {
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
    })).toEqual({
      ready: true,
      acceptedCommit: "b".repeat(40),
      durablePending: true,
      errorCode: "push-failed",
    });
    expect(readSystemConfigStatus(h.openclawDir)).toMatchObject({
      state: "error",
      acceptedCommit: "b".repeat(40),
      lastErrorCode: "push-failed",
    });
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
