#!/usr/bin/env tsx

import { spawn, type ChildProcess } from "node:child_process";

import { superviseRunner } from "../lib/runner-supervisor.js";

// Usage: supervise-runner <name> [--restart-delay-ms=N] <command> [args...]
// Replaces the bare `while true; <cmd> || true; sleep N` loops in
// entrypoint.sh — same respawn behavior, plus a heartbeat the metrics
// exporter reads. The runner's stdout/stderr pass through (stdio: inherit).
const [, , name, maybeOption, ...rest] = process.argv;
let command = maybeOption;
let args = rest;
let restartDelayMs: number | undefined;

if (maybeOption?.startsWith("--restart-delay-ms=")) {
  restartDelayMs = Number(maybeOption.slice("--restart-delay-ms=".length));
  [command, ...args] = rest;
}

if (
  restartDelayMs !== undefined &&
  (!Number.isFinite(restartDelayMs) || restartDelayMs < 0)
) {
  console.error("usage: supervise-runner <name> [--restart-delay-ms=N] <command> [args...]");
  process.exit(2);
}

if (!name || !command) {
  console.error("usage: supervise-runner <name> [--restart-delay-ms=N] <command> [args...]");
  process.exit(2);
}

let stopping = false;
let activeChild: ChildProcess | null = null;
const stop = (): void => {
  stopping = true;
  activeChild?.kill("SIGTERM");
};
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
process.on("exit", () => activeChild?.kill("SIGTERM"));

await superviseRunner({
  name,
  restartDelayMs,
  shouldStop: () => stopping,
  spawn: () => {
    const child = spawn(command, args, { stdio: "inherit" });
    activeChild = child;
    const finish = (resolve: (code: number) => void, code: number): void => {
      if (activeChild === child) activeChild = null;
      resolve(code);
    };
    return {
      waitForExit: () =>
        new Promise<number>((resolve) => {
          child.once("exit", (code, signal) =>
            finish(resolve, code ?? (signal ? 1 : 0)),
          );
          // posix_spawnp / ENOENT etc — treat as a non-zero exit so the
          // supervisor records the failure and retries.
          child.once("error", () => finish(resolve, 1));
        }),
    };
  },
});
