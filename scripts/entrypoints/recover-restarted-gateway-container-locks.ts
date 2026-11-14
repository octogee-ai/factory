import { readlink } from "node:fs/promises";
import os from "node:os";
import { pathToFileURL } from "node:url";

import { createServiceLogger } from "@octogee/shared/server/service-logger";
import { recoverRestartedGatewayContainerLocks } from "../lib/gateway-container-restart-locks.js";
import { runOpenClaw } from "../lib/openclaw-cli.js";

const runtimeLogger = createServiceLogger("recover-restarted-gateway-container-locks");

async function currentPidNamespace(): Promise<string> {
  const link = await readlink("/proc/self/ns/pid");
  const inode = /^pid:\[(\d+)\]$/u.exec(link)?.[1];
  if (!inode) throw new Error(`/proc/self/ns/pid names no PID namespace inode: ${link}`);
  return inode;
}

async function main(): Promise<void> {
  try {
    await recoverRestartedGatewayContainerLocks({
      env: process.env,
      hostname: os.hostname(),
      pidNamespace: await currentPidNamespace(),
      run: runOpenClaw,
      log: runtimeLogger.info,
    });
  } catch (error) {
    runtimeLogger.error(`[gateway-container] Gateway lock recovery failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main();
}
