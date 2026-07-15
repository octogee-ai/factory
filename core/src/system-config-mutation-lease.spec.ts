import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  acquireSystemConfigMutationLease,
  acquireSystemConfigSyncLeaseSync,
  systemConfigSyncLockPath,
} from "./system-config-mutation-lease.js";

const dirs: string[] = [];

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "system-config-lease-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  vi.useRealTimers();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("system config cross-container mutation lease", () => {
  it("returns typed busy and frozen results without exposing a mutation window", async () => {
    const openclawDir = tempDir();
    const held = acquireSystemConfigSyncLeaseSync({ openclawDir });
    expect(held).not.toBeNull();

    await expect(acquireSystemConfigMutationLease({ openclawDir })).resolves.toEqual({
      ok: false,
      code: "writer-lock-busy",
    });
    held?.release();

    fs.writeFileSync(path.join(openclawDir, "system_config.freeze.json"), JSON.stringify({
      migrationId: "mig-1",
      directoryMode: 0o700,
      configMode: 0o600,
    }));
    await expect(acquireSystemConfigMutationLease({ openclawDir })).resolves.toEqual({
      ok: false,
      code: "config-frozen",
      freezeOwner: "mig-1",
    });
    expect(fs.existsSync(systemConfigSyncLockPath(openclawDir))).toBe(false);
  });

  it("reclaims only an expired heartbeat through atomic lease-directory quarantine", () => {
    const openclawDir = tempDir();
    const lockPath = systemConfigSyncLockPath(openclawDir);
    const ownerToken = "00000000-0000-4000-8000-000000000001";
    const ownerPath = path.join(lockPath, ownerToken);
    fs.mkdirSync(lockPath);
    fs.writeFileSync(ownerPath, `${ownerToken}\n`);
    fs.utimesSync(ownerPath, new Date(0), new Date(0));

    const lease = acquireSystemConfigSyncLeaseSync({
      openclawDir,
      heartbeatMs: 100,
      staleAfterMs: 1_000,
    });

    expect(lease).not.toBeNull();
    expect(fs.readdirSync(lockPath)).toEqual([lease?.ownerToken]);
    expect(fs.readdirSync(openclawDir).filter((name) => name.includes(".stale."))).toEqual([]);
    lease?.release();
  });

  it("never removes a successor lease when an expired owner releases late", () => {
    const openclawDir = tempDir();
    const lockPath = systemConfigSyncLockPath(openclawDir);
    const first = acquireSystemConfigSyncLeaseSync({ openclawDir });
    expect(first).not.toBeNull();
    const quarantined = `${lockPath}.stale.test`;
    fs.renameSync(lockPath, quarantined);
    const successor = acquireSystemConfigSyncLeaseSync({ openclawDir });
    expect(successor).not.toBeNull();

    expect(() => first?.release()).toThrow(/ownership lost/i);
    expect(fs.readdirSync(lockPath)).toEqual([successor?.ownerToken]);
    successor?.release();
  });

  it("does not trust an expired token heartbeat in a malformed lease directory", () => {
    const openclawDir = tempDir();
    const lockPath = systemConfigSyncLockPath(openclawDir);
    const ownerToken = "00000000-0000-4000-8000-000000000001";
    fs.mkdirSync(lockPath);
    fs.writeFileSync(path.join(lockPath, ownerToken), `${ownerToken}\n`);
    fs.writeFileSync(path.join(lockPath, "unexpected"), "unexpected\n");
    fs.utimesSync(path.join(lockPath, ownerToken), new Date(0), new Date(0));

    expect(acquireSystemConfigSyncLeaseSync({
      openclawDir,
      heartbeatMs: 100,
      staleAfterMs: 1_000,
    })).toBeNull();
  });

  it("cleans up owned state even when a heartbeat failure must be reported", () => {
    vi.useFakeTimers();
    const openclawDir = tempDir();
    const lockPath = systemConfigSyncLockPath(openclawDir);
    const lease = acquireSystemConfigSyncLeaseSync({
      openclawDir,
      heartbeatMs: 100,
      staleAfterMs: 1_000,
    });
    expect(lease).not.toBeNull();
    const ownerPath = path.join(lockPath, lease!.ownerToken);
    fs.unlinkSync(ownerPath);
    vi.advanceTimersByTime(100);
    fs.writeFileSync(ownerPath, `${lease!.ownerToken}\n`);

    expect(() => lease!.release()).toThrow(/heartbeat failed/i);
    expect(fs.existsSync(lockPath)).toBe(false);
  });
});
