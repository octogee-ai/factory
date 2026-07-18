import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  acquireSystemConfigMutationLease,
  acquireSystemConfigShellCapabilitySync,
  acquireSystemConfigSyncLeaseSync,
  activeSystemConfigShellIds,
  readSystemConfigShellCapability,
  releaseSystemConfigShellCapabilitySync,
  systemConfigSyncLockPath,
} from "./system-config-mutation-lease.js";

const dirs: string[] = [];

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "system-config-lease-"));
  dirs.push(dir);
  return dir;
}

function blockCurrentThread(milliseconds: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

afterEach(() => {
  vi.useRealTimers();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("system config cross-container mutation lease", () => {
  it("starts its heartbeat before an immediate release", () => {
    const openclawDir = tempDir();
    for (let index = 0; index < 10; index += 1) {
      const lease = acquireSystemConfigSyncLeaseSync({ openclawDir });
      expect(lease).not.toBeNull();
      expect(() => lease!.release()).not.toThrow();
    }
  });

  it("starts and releases from an ESM child process both immediately and after a heartbeat", () => {
    const openclawDir = tempDir();
    const moduleUrl = pathToFileURL(path.resolve("dist/system-config-mutation-lease.js")).href;
    const source = `
      import path from "node:path";
      import { acquireSystemConfigSyncLeaseSync } from ${JSON.stringify(moduleUrl)};
      const root = ${JSON.stringify(openclawDir)};
      for (let index = 0; index < 5; index += 1) {
        const lease = acquireSystemConfigSyncLeaseSync({
          openclawDir: path.join(root, "immediate-" + index),
          heartbeatMs: 20,
          staleAfterMs: 100,
        });
        if (!lease) throw new Error("lease was unexpectedly busy");
        lease.release();
      }
      const delayed = acquireSystemConfigSyncLeaseSync({
        openclawDir: path.join(root, "delayed"),
        heartbeatMs: 20,
        staleAfterMs: 100,
      });
      if (!delayed) throw new Error("delayed lease was unexpectedly busy");
      await new Promise((resolve) => setTimeout(resolve, 60));
      delayed.release();
    `;

    expect(() => execFileSync(
      process.execPath,
      ["--input-type=module", "-e", source],
      { stdio: "pipe", timeout: 10_000 },
    )).not.toThrow();
  });

  it("returns a typed busy result without exposing a mutation window and ignores retired freeze markers", async () => {
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
      slug: "alice",
      directoryMode: 0o700,
      configMode: 0o600,
    }));
    const mutation = await acquireSystemConfigMutationLease({ openclawDir });
    expect(mutation.ok).toBe(true);
    if (mutation.ok) await mutation.lease.release();
    expect(fs.existsSync(systemConfigSyncLockPath(openclawDir))).toBe(false);
  });

  it("refuses Dashboard mutation and config control while an accepted shell capability exists", async () => {
    const openclawDir = tempDir();
    const capability = acquireSystemConfigShellCapabilitySync({
      openclawDir,
      shellId: "accepted-shell",
    });
    expect(capability).toMatchObject({ ok: true, created: true });
    if (!capability.ok) throw new Error("expected shell capability");
    expect(activeSystemConfigShellIds(openclawDir)).toEqual(["accepted-shell"]);

    await expect(acquireSystemConfigMutationLease({ openclawDir })).resolves.toEqual({
      ok: false,
      code: "shell-active",
      shellIds: ["accepted-shell"],
    });

    expect(releaseSystemConfigShellCapabilitySync({
      openclawDir,
      shellId: "accepted-shell",
      ownerToken: capability.ownerToken,
    })).toBe(true);
    expect(activeSystemConfigShellIds(openclawDir)).toEqual([]);
    const mutation = await acquireSystemConfigMutationLease({ openclawDir });
    expect(mutation.ok).toBe(true);
    if (mutation.ok) await mutation.lease.release();
  });

  it("makes shell admission and Dashboard mutation atomic in either acquisition order", async () => {
    const shellFirstDir = tempDir();
    let dashboardDuringShell: ReturnType<typeof acquireSystemConfigMutationLease> | undefined;
    expect(acquireSystemConfigShellCapabilitySync({
      openclawDir: shellFirstDir,
      shellId: "accepted1",
      afterGateAcquired: () => {
        dashboardDuringShell = acquireSystemConfigMutationLease({ openclawDir: shellFirstDir });
      },
    })).toMatchObject({ ok: true, created: true, ownerToken: expect.any(String) });
    await expect(dashboardDuringShell).resolves.toEqual({
      ok: false,
      code: "writer-lock-busy",
    });

    const dashboardFirstDir = tempDir();
    let shellDuringDashboard: ReturnType<typeof acquireSystemConfigShellCapabilitySync> | undefined;
    const dashboard = await acquireSystemConfigMutationLease({
      openclawDir: dashboardFirstDir,
      afterGateAcquired: () => {
        shellDuringDashboard = acquireSystemConfigShellCapabilitySync({
          openclawDir: dashboardFirstDir,
          shellId: "dashboard-first",
        });
      },
    });
    expect(dashboard.ok).toBe(true);
    expect(shellDuringDashboard).toEqual({ ok: false, code: "writer-lock-busy" });
    if (dashboard.ok) await dashboard.lease.release();
  });

  it("conditionally releases only the observed shell capability generation", async () => {
    const openclawDir = tempDir();
    const observed = acquireSystemConfigShellCapabilitySync({
      openclawDir,
      shellId: "same-shell",
    });
    if (!observed.ok) throw new Error("expected observed capability");
    const reacquired = acquireSystemConfigShellCapabilitySync({
      openclawDir,
      shellId: "same-shell",
    });
    if (!reacquired.ok) throw new Error("expected reacquired capability");
    expect(reacquired.ownerToken).not.toBe(observed.ownerToken);

    expect(releaseSystemConfigShellCapabilitySync({
      openclawDir,
      shellId: "same-shell",
      ownerToken: observed.ownerToken,
    })).toBe(true);
    expect(readSystemConfigShellCapability(openclawDir, "same-shell")).toEqual({
      shellId: "same-shell",
      ownerToken: reacquired.ownerToken,
    });
    await expect(acquireSystemConfigMutationLease({ openclawDir })).resolves.toEqual({
      ok: false,
      code: "shell-active",
      shellIds: ["same-shell"],
    });
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

  it("does not reclaim a live lease while the writer blocks the main thread beyond staleAfterMs", async () => {
    const openclawDir = tempDir();
    const lockPath = systemConfigSyncLockPath(openclawDir);
    const held = acquireSystemConfigSyncLeaseSync({
      openclawDir,
      heartbeatMs: 20,
      staleAfterMs: 100,
    });
    expect(held).not.toBeNull();
    const ownerPath = path.join(lockPath, held!.ownerToken);
    const initialHeartbeat = fs.statSync(ownerPath).mtimeMs;
    await vi.waitFor(() => expect(fs.statSync(ownerPath).mtimeMs).toBeGreaterThan(initialHeartbeat));

    blockCurrentThread(250);

    expect(acquireSystemConfigSyncLeaseSync({
      openclawDir,
      heartbeatMs: 20,
      staleAfterMs: 100,
    })).toBeNull();
    held!.release();
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

  it("cleans up owned state even when an independent heartbeat loses its owner file", async () => {
    const openclawDir = tempDir();
    const lockPath = systemConfigSyncLockPath(openclawDir);
    const lease = acquireSystemConfigSyncLeaseSync({
      openclawDir,
      heartbeatMs: 20,
      staleAfterMs: 1_000,
    });
    expect(lease).not.toBeNull();
    const ownerPath = path.join(lockPath, lease!.ownerToken);
    const initialHeartbeat = fs.statSync(ownerPath).mtimeMs;
    await vi.waitFor(() => expect(fs.statSync(ownerPath).mtimeMs).toBeGreaterThan(initialHeartbeat));
    fs.unlinkSync(ownerPath);
    blockCurrentThread(60);
    fs.writeFileSync(ownerPath, `${lease!.ownerToken}\n`);

    expect(() => lease!.release()).toThrow(/heartbeat failed/i);
    expect(fs.existsSync(lockPath)).toBe(false);
  });
});
