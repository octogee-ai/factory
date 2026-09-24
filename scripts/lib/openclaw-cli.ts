import { execFile } from "node:child_process";

export interface OpenClawCommandResult { code: number; stdout: string }
export interface OpenClawCommandOptions { env: NodeJS.ProcessEnv; signal?: AbortSignal }
export type OpenClawCommand = (
  args: string[],
  options: OpenClawCommandOptions,
) => Promise<OpenClawCommandResult>;

export const runOpenClaw: OpenClawCommand = (args, options) =>
  new Promise((resolve, reject) => {
    execFile("/usr/local/bin/openclaw", args, {
      ...options, timeout: 180_000, maxBuffer: 2 * 1024 * 1024,
      cwd: options.env.OPENCLAW_STATE_DIR,
    }, (error, stdout) => {
      if (error && (error.killed || typeof error.code !== "number")) {
        reject(new Error(`OpenClaw ${args[0]} command failed (${error.code ?? error.signal ?? "unknown"})`));
      } else {
        resolve({ code: (error?.code as number | undefined) ?? 0, stdout });
      }
    });
  });
