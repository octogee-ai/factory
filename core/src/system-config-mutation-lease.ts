import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const DEFAULT_HEARTBEAT_MS = 5_000;
const DEFAULT_STALE_AFTER_MS = 120_000;
const DEFAULT_LOCK_NAME = "system_config.sync.lock";
const OWNER_TOKEN_RE = /^[0-9a-f-]{36}$/;

export interface SystemConfigSyncLeaseOptions {
  openclawDir: string;
  lockName?: string;
  heartbeatMs?: number;
  staleAfterMs?: number;
  now?: () => number;
}

export interface SystemConfigSyncLease {
  ownerToken: string;
  release(): void;
}

export interface SystemConfigMutationLease {
  ownerToken: string;
  release(): Promise<void>;
}

export type SystemConfigMutationLeaseResult =
  | { ok: true; lease: SystemConfigMutationLease }
  | { ok: false; code: "writer-lock-busy" }
  | { ok: false; code: "config-frozen"; freezeOwner: string };

export function systemConfigSyncLockPath(
  openclawDir: string,
  lockName = DEFAULT_LOCK_NAME,
): string {
  return path.join(openclawDir, lockName);
}

function quarantineExpiredLease(lockPath: string, staleAfterMs: number, now: number): boolean {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(lockPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
    throw error;
  }
  let heartbeatMtimeMs = stat.mtimeMs;
  if (stat.isDirectory()) {
    const entries = fs.readdirSync(lockPath);
    if (entries.length === 1 && OWNER_TOKEN_RE.test(entries[0])) {
      heartbeatMtimeMs = fs.statSync(path.join(lockPath, entries[0])).mtimeMs;
    }
  }
  if (now - heartbeatMtimeMs <= staleAfterMs) return false;
  const quarantinePath = `${lockPath}.stale.${randomUUID()}`;
  try {
    fs.renameSync(lockPath, quarantinePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
    throw error;
  }
  fs.rmSync(quarantinePath, { recursive: true, force: true });
  return true;
}

function createLease(
  lockPath: string,
  ownerToken: string,
  heartbeatMs: number,
): SystemConfigSyncLease {
  const ownerPath = path.join(lockPath, ownerToken);
  let released = false;
  let heartbeatError: Error | null = null;
  const heartbeat = setInterval(() => {
    try {
      fs.utimesSync(ownerPath, new Date(), new Date());
    } catch (error) {
      heartbeatError = error instanceof Error ? error : new Error(String(error));
      clearInterval(heartbeat);
    }
  }, heartbeatMs);
  heartbeat.unref();

  return {
    ownerToken,
    release(): void {
      if (released) throw new Error(`system config lease ${ownerToken} was already released`);
      released = true;
      clearInterval(heartbeat);
      const errors: Error[] = [];
      if (heartbeatError) {
        errors.push(new Error(`system config lease ${ownerToken} heartbeat failed`, {
          cause: heartbeatError,
        }));
      }
      if (!fs.existsSync(ownerPath)) {
        errors.push(new Error(`system config lease ${ownerToken} ownership lost`));
      } else {
        try {
          fs.unlinkSync(ownerPath);
          fs.rmdirSync(lockPath);
        } catch (error) {
          errors.push(new Error(`system config lease ${ownerToken} release failed`, {
            cause: error,
          }));
        }
      }
      if (errors.length === 1) throw errors[0];
      if (errors.length > 1) {
        throw new AggregateError(errors, `system config lease ${ownerToken} failed`);
      }
    },
  };
}

export function acquireSystemConfigSyncLeaseSync(
  options: SystemConfigSyncLeaseOptions,
): SystemConfigSyncLease | null {
  const heartbeatMs = options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
  const staleAfterMs = options.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
  if (heartbeatMs <= 0 || staleAfterMs <= heartbeatMs) {
    throw new Error("system config lease timing is invalid");
  }
  const lockPath = systemConfigSyncLockPath(options.openclawDir, options.lockName);
  fs.mkdirSync(options.openclawDir, { recursive: true });
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      fs.mkdirSync(lockPath, { mode: 0o700 });
      const ownerToken = randomUUID();
      try {
        fs.writeFileSync(path.join(lockPath, ownerToken), `${ownerToken}\n`, {
          flag: "wx",
          mode: 0o600,
        });
      } catch (error) {
        fs.rmSync(lockPath, { recursive: true, force: true });
        throw error;
      }
      return createLease(lockPath, ownerToken, heartbeatMs);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (!quarantineExpiredLease(
        lockPath,
        staleAfterMs,
        (options.now ?? Date.now)(),
      )) return null;
    }
  }
  return null;
}

function readFreezeOwner(openclawDir: string): string | null {
  const markerPath = path.join(openclawDir, "system_config.freeze.json");
  let contents: string;
  try {
    contents = fs.readFileSync(markerPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  const parsed = JSON.parse(contents) as unknown;
  if (
    !parsed ||
    typeof parsed !== "object" ||
    Array.isArray(parsed) ||
    typeof (parsed as { migrationId?: unknown }).migrationId !== "string" ||
    !(parsed as { migrationId: string }).migrationId
  ) {
    throw new Error(`invalid system config freeze marker at ${markerPath}`);
  }
  return (parsed as { migrationId: string }).migrationId;
}

export async function acquireSystemConfigMutationLease(
  options: SystemConfigSyncLeaseOptions,
): Promise<SystemConfigMutationLeaseResult> {
  const syncLease = acquireSystemConfigSyncLeaseSync(options);
  if (!syncLease) return { ok: false, code: "writer-lock-busy" };
  let freezeOwner: string | null;
  try {
    freezeOwner = readFreezeOwner(options.openclawDir);
  } catch (error) {
    try {
      syncLease.release();
    } catch (releaseError) {
      throw new AggregateError([error, releaseError], "freeze validation and lease release failed");
    }
    throw error;
  }
  if (freezeOwner) {
    syncLease.release();
    return { ok: false, code: "config-frozen", freezeOwner };
  }
  return {
    ok: true,
    lease: {
      ownerToken: syncLease.ownerToken,
      async release(): Promise<void> {
        syncLease.release();
      },
    },
  };
}
