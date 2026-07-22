import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Worker } from "node:worker_threads";
import { isValidShellId } from "@octogee/shared/types/shells";
const DEFAULT_HEARTBEAT_MS = 5_000;
const DEFAULT_STALE_AFTER_MS = 120_000;
const DEFAULT_LOCK_NAME = "system_config.sync.lock";
const SHELL_CAPABILITY_DIRNAME = "system_config.shell-capabilities";
const OWNER_TOKEN_RE = /^[0-9a-f-]{36}$/;
const HEARTBEAT_STARTING = 0;
const HEARTBEAT_RUNNING = 1;
const HEARTBEAT_STOP_REQUESTED = 2;
const HEARTBEAT_FAILED = 3;
const HEARTBEAT_STOPPED = 4;
const HEARTBEAT_STATE_INDEX = 0;
const HEARTBEAT_ERROR_LENGTH_INDEX = 1;
const HEARTBEAT_CONTROL_BYTES = Int32Array.BYTES_PER_ELEMENT * 2;
const HEARTBEAT_ERROR_BYTES = 4_096;
const HEARTBEAT_START_TIMEOUT_MS = 5_000;
const HEARTBEAT_STOP_TIMEOUT_MS = 5_000;
const HEARTBEAT_WORKER_SOURCE = String.raw `
(async () => {
  const fs = await import("node:fs");
  const { workerData } = await import("node:worker_threads");
  const control = new Int32Array(workerData.shared, 0, 2);
  const errorBytes = new Uint8Array(workerData.shared, 8);

  function fail(error) {
    const encoded = Buffer.from(error instanceof Error ? error.stack || error.message : String(error));
    const length = Math.min(encoded.length, errorBytes.length);
    errorBytes.set(encoded.subarray(0, length));
    Atomics.store(control, 1, length);
    Atomics.store(control, 0, 3);
  }

  try {
    Atomics.store(control, 0, 1);
    Atomics.notify(control, 0);
    while (Atomics.load(control, 0) === 1) {
      Atomics.wait(control, 0, 1, workerData.heartbeatMs);
      if (Atomics.load(control, 0) !== 1) break;
      const now = new Date();
      fs.utimesSync(workerData.ownerPath, now, now);
    }
    if (Atomics.load(control, 0) === 2) Atomics.store(control, 0, 4);
  } catch (error) {
    fail(error);
  } finally {
    Atomics.notify(control, 0);
  }
})().catch((error) => {
  throw error;
});
`;
export function systemConfigSyncLockPath(openclawDir, lockName = DEFAULT_LOCK_NAME) {
    return path.join(openclawDir, lockName);
}
function quarantineExpiredLease(lockPath, staleAfterMs, now) {
    let stat;
    try {
        stat = fs.statSync(lockPath);
    }
    catch (error) {
        if (error.code === "ENOENT")
            return true;
        throw error;
    }
    let heartbeatMtimeMs = stat.mtimeMs;
    if (stat.isDirectory()) {
        const entries = fs.readdirSync(lockPath);
        if (entries.length === 1 && OWNER_TOKEN_RE.test(entries[0])) {
            try {
                heartbeatMtimeMs = fs.statSync(path.join(lockPath, entries[0])).mtimeMs;
            }
            catch (error) {
                if (error.code === "ENOENT")
                    return true;
                throw error;
            }
        }
    }
    if (now - heartbeatMtimeMs <= staleAfterMs)
        return false;
    const quarantinePath = `${lockPath}.stale.${randomUUID()}`;
    try {
        fs.renameSync(lockPath, quarantinePath);
    }
    catch (error) {
        if (error.code === "ENOENT")
            return true;
        throw error;
    }
    fs.rmSync(quarantinePath, { recursive: true, force: true });
    return true;
}
function writeHeartbeatError(control, errorBytes, error) {
    const encoded = Buffer.from(error instanceof Error ? error.stack ?? error.message : String(error));
    const length = Math.min(encoded.length, errorBytes.length);
    errorBytes.set(encoded.subarray(0, length));
    Atomics.store(control, HEARTBEAT_ERROR_LENGTH_INDEX, length);
    Atomics.store(control, HEARTBEAT_STATE_INDEX, HEARTBEAT_FAILED);
    Atomics.notify(control, HEARTBEAT_STATE_INDEX);
}
function readHeartbeatError(control, errorBytes) {
    const length = Atomics.load(control, HEARTBEAT_ERROR_LENGTH_INDEX);
    if (length <= 0)
        return "heartbeat worker stopped without an error description";
    return Buffer.from(errorBytes.subarray(0, length)).toString("utf8");
}
function createHeartbeat(ownerPath, heartbeatMs) {
    const shared = new SharedArrayBuffer(HEARTBEAT_CONTROL_BYTES + HEARTBEAT_ERROR_BYTES);
    const control = new Int32Array(shared, 0, 2);
    const errorBytes = new Uint8Array(shared, HEARTBEAT_CONTROL_BYTES);
    const worker = new Worker(HEARTBEAT_WORKER_SOURCE, {
        eval: true,
        workerData: { shared, ownerPath, heartbeatMs },
    });
    worker.on("error", (error) => writeHeartbeatError(control, errorBytes, error));
    worker.on("exit", (code) => {
        const state = Atomics.load(control, HEARTBEAT_STATE_INDEX);
        if (state === HEARTBEAT_RUNNING || state === HEARTBEAT_STOP_REQUESTED) {
            writeHeartbeatError(control, errorBytes, new Error(`heartbeat worker exited with code ${code}`));
        }
    });
    worker.unref();
    const startupDeadline = Date.now() + HEARTBEAT_START_TIMEOUT_MS;
    let startupState = Atomics.load(control, HEARTBEAT_STATE_INDEX);
    while (startupState === HEARTBEAT_STARTING) {
        const remainingMs = startupDeadline - Date.now();
        if (remainingMs <= 0) {
            void worker.terminate();
            throw new Error(`heartbeat worker did not start within ${HEARTBEAT_START_TIMEOUT_MS}ms`);
        }
        Atomics.wait(control, HEARTBEAT_STATE_INDEX, HEARTBEAT_STARTING, remainingMs);
        startupState = Atomics.load(control, HEARTBEAT_STATE_INDEX);
    }
    if (startupState === HEARTBEAT_FAILED) {
        throw new Error(`heartbeat worker failed to start: ${readHeartbeatError(control, errorBytes)}`);
    }
    if (startupState !== HEARTBEAT_RUNNING) {
        throw new Error(`heartbeat worker entered state ${startupState} during startup`);
    }
    return {
        stop() {
            if (Atomics.compareExchange(control, HEARTBEAT_STATE_INDEX, HEARTBEAT_RUNNING, HEARTBEAT_STOP_REQUESTED) === HEARTBEAT_RUNNING) {
                Atomics.notify(control, HEARTBEAT_STATE_INDEX);
            }
            const deadline = Date.now() + HEARTBEAT_STOP_TIMEOUT_MS;
            let state = Atomics.load(control, HEARTBEAT_STATE_INDEX);
            while (state === HEARTBEAT_RUNNING || state === HEARTBEAT_STOP_REQUESTED) {
                const remainingMs = deadline - Date.now();
                if (remainingMs <= 0) {
                    return {
                        stopped: false,
                        error: new Error(`heartbeat worker did not stop within ${HEARTBEAT_STOP_TIMEOUT_MS}ms`),
                    };
                }
                Atomics.wait(control, HEARTBEAT_STATE_INDEX, state, remainingMs);
                state = Atomics.load(control, HEARTBEAT_STATE_INDEX);
            }
            worker.removeAllListeners();
            if (state === HEARTBEAT_FAILED) {
                return { stopped: true, error: new Error(readHeartbeatError(control, errorBytes)) };
            }
            if (state !== HEARTBEAT_STOPPED) {
                return { stopped: false, error: new Error(`heartbeat worker entered state ${state}`) };
            }
            return { stopped: true, error: null };
        },
    };
}
function createLease(lockPath, ownerToken, heartbeatMs) {
    const ownerPath = path.join(lockPath, ownerToken);
    let released = false;
    const heartbeat = createHeartbeat(ownerPath, heartbeatMs);
    return {
        ownerToken,
        release() {
            if (released)
                throw new Error(`system config lease ${ownerToken} was already released`);
            const heartbeatStop = heartbeat.stop();
            if (!heartbeatStop.stopped) {
                throw new Error(`system config lease ${ownerToken} heartbeat shutdown failed`, {
                    cause: heartbeatStop.error,
                });
            }
            released = true;
            const errors = [];
            if (heartbeatStop.error) {
                errors.push(new Error(`system config lease ${ownerToken} heartbeat failed`, {
                    cause: heartbeatStop.error,
                }));
            }
            if (!fs.existsSync(ownerPath)) {
                errors.push(new Error(`system config lease ${ownerToken} ownership lost`));
            }
            else {
                try {
                    fs.unlinkSync(ownerPath);
                    fs.rmdirSync(lockPath);
                }
                catch (error) {
                    errors.push(new Error(`system config lease ${ownerToken} release failed`, {
                        cause: error,
                    }));
                }
            }
            if (errors.length === 1)
                throw errors[0];
            if (errors.length > 1) {
                throw new AggregateError(errors, `system config lease ${ownerToken} failed`);
            }
        },
    };
}
export function acquireSystemConfigSyncLeaseSync(options) {
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
            }
            catch (error) {
                fs.rmSync(lockPath, { recursive: true, force: true });
                throw error;
            }
            try {
                return createLease(lockPath, ownerToken, heartbeatMs);
            }
            catch (error) {
                fs.rmSync(lockPath, { recursive: true, force: true });
                throw error;
            }
        }
        catch (error) {
            if (error.code !== "EEXIST")
                throw error;
            if (!quarantineExpiredLease(lockPath, staleAfterMs, (options.now ?? Date.now)()))
                return null;
        }
    }
    return null;
}
function shellCapabilityDir(openclawDir) {
    return path.join(openclawDir, SHELL_CAPABILITY_DIRNAME);
}
function shellCapabilityPath(openclawDir, shellId) {
    return path.join(shellCapabilityDir(openclawDir), `${shellId}.json`);
}
function readShellCapability(markerPath) {
    const parsed = JSON.parse(fs.readFileSync(markerPath, "utf8"));
    const record = parsed;
    const shellId = record?.shellId;
    const ownerToken = record?.ownerToken;
    if (!parsed ||
        typeof parsed !== "object" ||
        Array.isArray(parsed) ||
        !isValidShellId(shellId) ||
        typeof ownerToken !== "string" ||
        !OWNER_TOKEN_RE.test(ownerToken) ||
        markerPath !== shellCapabilityPath(path.dirname(path.dirname(markerPath)), shellId)) {
        throw new Error(`invalid system config shell capability at ${markerPath}`);
    }
    return { shellId, ownerToken };
}
export function readSystemConfigShellCapability(openclawDir, shellId) {
    if (!isValidShellId(shellId))
        throw new Error("valid shellId is required");
    try {
        return readShellCapability(shellCapabilityPath(openclawDir, shellId));
    }
    catch (error) {
        if (error.code === "ENOENT")
            return null;
        throw error;
    }
}
export function activeSystemConfigShellCapabilities(openclawDir) {
    const directory = shellCapabilityDir(openclawDir);
    let entries;
    try {
        entries = fs.readdirSync(directory, { withFileTypes: true });
    }
    catch (error) {
        if (error.code === "ENOENT")
            return [];
        throw error;
    }
    return entries.map((entry) => {
        const markerPath = path.join(directory, entry.name);
        if (!entry.isFile() || !entry.name.endsWith(".json")) {
            throw new Error(`invalid system config shell capability at ${markerPath}`);
        }
        return readShellCapability(markerPath);
    }).sort((left, right) => left.shellId.localeCompare(right.shellId));
}
export function activeSystemConfigShellIds(openclawDir) {
    return activeSystemConfigShellCapabilities(openclawDir).map(({ shellId }) => shellId);
}
function releaseSyncLeaseAfterError(syncLease, error) {
    try {
        syncLease.release();
    }
    catch (releaseError) {
        throw new AggregateError([error, releaseError], "config gate validation and release failed");
    }
    throw error;
}
export function acquireSystemConfigShellCapabilitySync(options) {
    if (!isValidShellId(options.shellId))
        throw new Error("valid shellId is required");
    const syncLease = acquireSystemConfigSyncLeaseSync(options);
    if (!syncLease)
        return { ok: false, code: "writer-lock-busy" };
    let result;
    try {
        options.afterGateAcquired?.();
        const existing = readSystemConfigShellCapability(options.openclawDir, options.shellId);
        const ownerToken = randomUUID();
        const directory = shellCapabilityDir(options.openclawDir);
        fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
        const temporaryPath = path.join(options.openclawDir, `.system_config.shell-capability.${options.shellId}.${ownerToken}.tmp`);
        try {
            fs.writeFileSync(temporaryPath, `${JSON.stringify({ shellId: options.shellId, ownerToken })}\n`, { flag: "wx", mode: 0o600 });
            fs.renameSync(temporaryPath, shellCapabilityPath(options.openclawDir, options.shellId));
        }
        catch (error) {
            fs.rmSync(temporaryPath, { force: true });
            throw error;
        }
        result = { ok: true, created: existing === null, ownerToken };
    }
    catch (error) {
        return releaseSyncLeaseAfterError(syncLease, error);
    }
    syncLease.release();
    return result;
}
export function releaseSystemConfigShellCapabilitySync(options) {
    if (!isValidShellId(options.shellId))
        throw new Error("valid shellId is required");
    if (!OWNER_TOKEN_RE.test(options.ownerToken))
        throw new Error("valid ownerToken is required");
    if (!fs.existsSync(shellCapabilityPath(options.openclawDir, options.shellId)))
        return true;
    const syncLease = acquireSystemConfigSyncLeaseSync(options);
    if (!syncLease)
        return false;
    try {
        activeSystemConfigShellCapabilities(options.openclawDir);
        const current = readSystemConfigShellCapability(options.openclawDir, options.shellId);
        if (current?.ownerToken === options.ownerToken) {
            fs.rmSync(shellCapabilityPath(options.openclawDir, options.shellId), { force: true });
            try {
                fs.rmdirSync(shellCapabilityDir(options.openclawDir));
            }
            catch (error) {
                const code = error.code;
                if (code !== "ENOENT" && code !== "ENOTEMPTY" && code !== "EEXIST")
                    throw error;
            }
        }
    }
    catch (error) {
        return releaseSyncLeaseAfterError(syncLease, error);
    }
    syncLease.release();
    return true;
}
export async function acquireSystemConfigMutationLease(options) {
    const syncLease = acquireSystemConfigSyncLeaseSync(options);
    if (!syncLease)
        return { ok: false, code: "writer-lock-busy" };
    let shellIds;
    try {
        options.afterGateAcquired?.();
        shellIds = activeSystemConfigShellIds(options.openclawDir);
    }
    catch (error) {
        return releaseSyncLeaseAfterError(syncLease, error);
    }
    if (shellIds.length > 0) {
        syncLease.release();
        return { ok: false, code: "shell-active", shellIds };
    }
    return {
        ok: true,
        lease: {
            ownerToken: syncLease.ownerToken,
            async release() {
                syncLease.release();
            },
        },
    };
}
