import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { reconcilePlatformInvariants } from "../lib/system-config-invariants.js";
import {
  adoptSystemConfig,
  SystemConfigAdoptionCheckpointError,
} from "../lib/system-config-adoption.js";
import { SystemConfigCheckpointError } from "../lib/system-config.js";

const dirs: string[] = [];
const env = {
  GATEWAY_CLASS: "operator",
  GATEWAY_ID: "bender",
  API_PUBLIC_URL: "https://api.octogee.com",
  GATEWAY_REVISION_ID: "bender-r12",
  OPENCLAW_VERSION: "2026.7.1",
};

function fixture() {
  const openclawDir = fs.mkdtempSync(path.join(os.tmpdir(), "octogee-config-adopt-"));
  dirs.push(openclawDir);
  const repoDir = path.join(openclawDir, "system_config");
  fs.mkdirSync(path.join(repoDir, ".git"), { recursive: true });
  const targetPath = path.join(repoDir, "openclaw.json");
  const current: Record<string, unknown> = { customerSetting: "old" };
  reconcilePlatformInvariants(current, env);
  fs.writeFileSync(targetPath, `${JSON.stringify(current, null, 2)}\n`);
  const sourcePath = path.join(openclawDir, "bender-live.json");
  fs.writeFileSync(sourcePath, JSON.stringify({
    customerSetting: "new",
    gateway: { port: 9000 },
    channels: {
      mattermost: {
        accounts: {
          "ceckert-coach": { botToken: "bender-live-pat", enabled: true },
        },
      },
    },
  }));
  return { openclawDir, targetPath, sourcePath };
}

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("system config adoption", () => {
  it("previews redacted path-only changes without mutating durable config or secrets", async () => {
    const h = fixture();
    const before = fs.readFileSync(h.targetPath, "utf8");
    const writeSecrets = vi.fn();
    const checkpoint = vi.fn();
    let validationSecretPath = "";
    const validateConfig = vi.fn((candidatePath: string) => {
      const candidate = fs.readFileSync(candidatePath, "utf8");
      expect(candidate).not.toContain("bender-live-pat");
      expect(fs.statSync(candidatePath).mode & 0o777).toBe(0o600);
      const parsed = JSON.parse(candidate);
      validationSecretPath = parsed.secrets.providers["octogee-mattermost"].path;
      expect(validationSecretPath).not.toBe(path.join(
        h.openclawDir,
        "secrets",
        "mattermost-accounts.json",
      ));
      expect(JSON.parse(fs.readFileSync(validationSecretPath, "utf8"))).toEqual({
        "ceckert-coach": "bender-live-pat",
      });
      expect(fs.statSync(validationSecretPath).mode & 0o777).toBe(0o600);
    });

    const plan = await adoptSystemConfig({
      slug: "ceckert",
      sourcePath: h.sourcePath,
      openclawDir: h.openclawDir,
      env,
      validateConfig,
      writeSecrets,
      checkpoint,
    });

    expect(plan).toMatchObject({ applied: false });
    expect(plan.approvalHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(plan.changedPaths).toEqual(expect.arrayContaining([
      "customerSetting",
      "channels.mattermost.accounts.ceckert-coach.botToken.source",
    ]));
    expect(JSON.stringify(plan)).not.toContain("bender-live-pat");
    expect(fs.readFileSync(h.targetPath, "utf8")).toBe(before);
    expect(fs.existsSync(validationSecretPath)).toBe(false);
    expect(fs.existsSync(path.join(h.openclawDir, "secrets", "mattermost-accounts.json"))).toBe(false);
    expect(writeSecrets).not.toHaveBeenCalled();
    expect(checkpoint).not.toHaveBeenCalled();
  });

  it("requires the exact preview hash before applying", async () => {
    const h = fixture();
    const before = fs.readFileSync(h.targetPath, "utf8");

    await expect(adoptSystemConfig({
      slug: "ceckert",
      sourcePath: h.sourcePath,
      openclawDir: h.openclawDir,
      env,
      approveHash: `sha256:${"0".repeat(64)}`,
      validateConfig: vi.fn(),
      writeSecrets: vi.fn(),
      checkpoint: vi.fn(),
    })).rejects.toMatchObject({ code: "adoption-approval-mismatch" });
    expect(fs.readFileSync(h.targetPath, "utf8")).toBe(before);
  });

  it("applies externalized secrets and requires an accepted durable head", async () => {
    const h = fixture();
    const validateConfig = vi.fn();
    const preview = await adoptSystemConfig({
      slug: "ceckert",
      sourcePath: h.sourcePath,
      openclawDir: h.openclawDir,
      env,
      validateConfig,
      writeSecrets: vi.fn(),
      checkpoint: vi.fn(),
    });
    const writeSecrets = vi.fn(async () => {});
    const checkpoint = vi.fn(() => ({
      committed: true,
      pushed: true,
      acceptedCommit: "a".repeat(40),
    }));

    const result = await adoptSystemConfig({
      slug: "ceckert",
      sourcePath: h.sourcePath,
      openclawDir: h.openclawDir,
      env,
      approveHash: preview.approvalHash,
      validateConfig,
      writeSecrets,
      checkpoint,
    });

    expect(result).toMatchObject({ applied: true, acceptedCommit: "a".repeat(40) });
    expect(writeSecrets).toHaveBeenCalledWith(h.openclawDir, {
      set: { "ceckert-coach": "bender-live-pat" },
    });
    expect(checkpoint).toHaveBeenCalledWith("ceckert", expect.objectContaining({
      openclawDir: h.openclawDir,
      env,
      source: "boot-migration",
    }));
    const tracked = fs.readFileSync(h.targetPath, "utf8");
    expect(tracked).not.toContain("bender-live-pat");
    expect(JSON.parse(tracked)).toMatchObject({
      customerSetting: "new",
      gateway: { port: 18789 },
      channels: {
        mattermost: {
          accounts: {
            "ceckert-coach": {
              botToken: {
                source: "file",
                provider: "octogee-mattermost",
                id: "/ceckert-coach",
              },
            },
          },
        },
      },
    });
  });

  it("leaves the tracked file untouched when validation or secret audit fails", async () => {
    const h = fixture();
    const before = fs.readFileSync(h.targetPath, "utf8");

    await expect(adoptSystemConfig({
      slug: "ceckert",
      sourcePath: h.sourcePath,
      openclawDir: h.openclawDir,
      env,
      validateConfig: () => {
        throw new Error("secrets audit failed");
      },
      writeSecrets: vi.fn(),
      checkpoint: vi.fn(),
    })).rejects.toThrow("secrets audit failed");
    expect(fs.readFileSync(h.targetPath, "utf8")).toBe(before);
  });

  it("rolls back config and newly staged secrets when checkpointing fails before commit", async () => {
    const h = fixture();
    const before = fs.readFileSync(h.targetPath, "utf8");
    const preview = await adoptSystemConfig({
      slug: "ceckert",
      sourcePath: h.sourcePath,
      openclawDir: h.openclawDir,
      env,
      validateConfig: vi.fn(),
      writeSecrets: vi.fn(),
      checkpoint: vi.fn(),
    });
    const writeSecrets = vi.fn(async () => {});
    const checkpoint = vi.fn(() => {
      throw new SystemConfigCheckpointError({
        committed: false,
        pushed: false,
        pending: true,
        errorCode: "non-fast-forward-conflict",
      });
    });

    await expect(adoptSystemConfig({
      slug: "ceckert",
      sourcePath: h.sourcePath,
      openclawDir: h.openclawDir,
      env,
      approveHash: preview.approvalHash,
      validateConfig: vi.fn(),
      writeSecrets,
      checkpoint,
    })).rejects.toMatchObject({
      code: "adoption-checkpoint-failed",
      localState: "restored",
    });

    expect(fs.readFileSync(h.targetPath, "utf8")).toBe(before);
    expect(writeSecrets).toHaveBeenNthCalledWith(1, h.openclawDir, {
      set: { "ceckert-coach": "bender-live-pat" },
    });
    expect(writeSecrets).toHaveBeenNthCalledWith(2, h.openclawDir, {
      set: {},
      remove: ["ceckert-coach"],
    });
  });

  it("reports a committed checkpoint as pending instead of applied when push fails", async () => {
    const h = fixture();
    const preview = await adoptSystemConfig({
      slug: "ceckert",
      sourcePath: h.sourcePath,
      openclawDir: h.openclawDir,
      env,
      validateConfig: vi.fn(),
      writeSecrets: vi.fn(),
      checkpoint: vi.fn(),
    });

    const pending = adoptSystemConfig({
      slug: "ceckert",
      sourcePath: h.sourcePath,
      openclawDir: h.openclawDir,
      env,
      approveHash: preview.approvalHash,
      validateConfig: vi.fn(),
      writeSecrets: vi.fn(async () => {}),
      checkpoint: vi.fn(() => {
        throw new SystemConfigCheckpointError({
          committed: true,
          pushed: false,
          pending: true,
          errorCode: "push-failed",
        });
      }),
    });

    await expect(pending).rejects.toBeInstanceOf(SystemConfigAdoptionCheckpointError);
    await expect(pending).rejects.toMatchObject({
      code: "adoption-checkpoint-failed",
      localState: "committed-pending",
    });
    expect(JSON.parse(fs.readFileSync(h.targetPath, "utf8"))).toMatchObject({
      customerSetting: "new",
    });
  });
});
