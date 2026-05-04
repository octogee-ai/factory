/**
 * workspace-git.ts — Phase 6.B (docs/ACTIVITY-STREAM-SPEC.md §10).
 *
 * Pure helpers that shell out to `git` against a workspace's local
 * filesystem checkout (the customer dir maintained by the gateway). Used
 * by `routes/workspace/git.ts` to expose `git status / diff / log` over
 * HTTP for the PWA Working Tree pane.
 *
 * Phase 6.B is read-only. Commit / push / branch operations defer to
 * Phase 6.C (toolbar PR) and add their own validation + signing path.
 */

import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import * as path from "node:path";

const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
const GIT_TIMEOUT_MS = 5_000;

const RECORD_SEPARATOR = String.fromCharCode(0x1e);
const UNIT_SEPARATOR = String.fromCharCode(0x1f);
const NUL = String.fromCharCode(0x00);

export type WorkspaceGitError =
  | { code: "NOT_A_REPO"; cwd: string }
  | { code: "CUSTOMER_DIR_MISSING"; cwd: string }
  | { code: "TIMEOUT"; cwd: string; durationMs: number }
  | { code: "GIT_FAILED"; cwd: string; status: number; stderr: string }
  | { code: "OUTPUT_TOO_LARGE"; cwd: string; cap: number }
  | { code: "INTERNAL"; message: string };

export interface WorkspaceGitStatusEntry {
  path: string;
  change: "modified" | "added" | "deleted" | "untracked" | "renamed";
}

export interface WorkspaceGitLogEntry {
  sha: string;
  author: string;
  ts: number;
  subject: string;
}

export async function resolveCustomerDir(
  customersRoot: string,
  slug: string,
): Promise<string | null> {
  if (slug.includes("..") || slug.includes("/") || slug.includes("\\")) {
    return null;
  }
  const dir = path.join(customersRoot, slug);
  try {
    const stat = await fs.stat(dir);
    if (!stat.isDirectory()) return null;
    const gitDir = path.join(dir, ".git");
    try {
      const gs = await fs.stat(gitDir);
      if (!gs.isDirectory() && !gs.isFile()) return null;
    } catch {
      return null;
    }
    return dir;
  } catch {
    return null;
  }
}

export async function gitStatus(
  customerDir: string,
): Promise<{ ok: true; entries: WorkspaceGitStatusEntry[] } | { ok: false; error: WorkspaceGitError }> {
  const r = await runGit(customerDir, ["status", "--porcelain=v1", "-z"]);
  if (!r.ok) return r;
  return { ok: true, entries: parsePorcelain(r.stdout) };
}

export async function gitDiff(
  customerDir: string,
  options: { path?: string; ref?: string } = {},
): Promise<{ ok: true; diff: string } | { ok: false; error: WorkspaceGitError }> {
  // `--no-ext-diff` neutralizes `diff.external` from the customer's
  //   .git/config (P0-2 — live RCE vector otherwise).
  // `--end-of-options` separates flags from positionals. Defense
  //   against a future caller (or a regex regression) letting a
  //   `-`-prefixed ref through.
  // Path goes after `--` per existing convention.
  const args = ["diff", "--no-color", "--no-ext-diff", "--end-of-options", options.ref ?? "HEAD"];
  if (options.path) {
    args.push("--", options.path);
  }
  const r = await runGit(customerDir, args);
  if (!r.ok) return r;
  return { ok: true, diff: r.stdout };
}

export async function gitLog(
  customerDir: string,
  options: { limit?: number; branch?: string } = {},
): Promise<{ ok: true; entries: WorkspaceGitLogEntry[] } | { ok: false; error: WorkspaceGitError }> {
  const limit = clampLimit(options.limit ?? 20);
  // %aN respects mailmap (Octogee Builders set display names independent
  // of git identity); fall through to %an if no mailmap entry.
  const FMT = `%H${UNIT_SEPARATOR}%aN${UNIT_SEPARATOR}%ct${UNIT_SEPARATOR}%s${RECORD_SEPARATOR}`;
  const args = ["log", "--no-ext-diff", `-n${limit}`, `--pretty=format:${FMT}`, "--end-of-options"];
  if (options.branch) args.push(options.branch);
  const r = await runGit(customerDir, args);
  if (!r.ok) return r;
  return { ok: true, entries: parseLog(r.stdout) };
}

function clampLimit(n: number): number {
  if (!Number.isFinite(n) || n < 1) return 1;
  if (n > 200) return 200;
  return Math.floor(n);
}

interface GitRunOk {
  ok: true;
  stdout: string;
  stderr: string;
}

/**
 * Hardening pins (P0-2 of #825 review). The customer dir's `.git/config`
 * is customer-controllable: an agent edit can write keys like
 * `diff.external = /bin/sh -c 'curl ...'` that fire DURING `git diff`.
 * These pins neutralize the attack surface:
 *   -c core.fsmonitor=       disables fsmonitor exec on every command
 *   -c core.pager=cat        defuses pager (already piped, belt+suspenders)
 *   -c gpg.program=/bin/false neutralizes signature-verify exec
 *   -c protocol.allow=never   no fetch/push (read-only routes anyway)
 *
 * Note: `diff.external` is neutralized at the subcommand level via
 * `--no-ext-diff` (see gitDiff/gitLog). Setting `-c diff.external=`
 * here would NOT disable it — git interprets empty as "run empty
 * command" and errors out, breaking the diff entirely.
 *
 * Plus env pins so the helper ignores ~/.gitconfig and /etc/gitconfig
 * and never prompts.
 */
const HARDENING_PINS: ReadonlyArray<string> = [
  "-c", "core.fsmonitor=",
  "-c", "core.pager=cat",
  "-c", "gpg.program=/bin/false",
  "-c", "protocol.allow=never",
];

const HARDENING_ENV: Readonly<Record<string, string>> = {
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_TERMINAL_PROMPT: "0",
  GIT_OPTIONAL_LOCKS: "0",
};

async function runGit(
  cwd: string,
  args: ReadonlyArray<string>,
): Promise<GitRunOk | { ok: false; error: WorkspaceGitError }> {
  // Layered argv:
  //   1. hardening `-c <key>=<value>` pins (must come BEFORE subcmd)
  //   2. --git-dir / --work-tree pins (defeat parent-dir discovery)
  //   3. caller args (already validated by the route layer)
  const fullArgs = [
    ...HARDENING_PINS,
    "--git-dir",
    path.join(cwd, ".git"),
    "--work-tree",
    cwd,
    ...args,
  ];
  return new Promise((resolve) => {
    const start = Date.now();
    let stdoutBytes = 0;
    let stderrBytes = 0;
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let timedOut = false;
    let outputCapped = false;

    let proc: ReturnType<typeof spawn>;
    try {
      // PATH is fixed by the image build (sidecar in the gateway pod);
      // sonarjs/no-os-command-from-path's threat model doesn't apply.
      // eslint-disable-next-line sonarjs/no-os-command-from-path
      proc = spawn("git", fullArgs, {
        cwd,
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, ...HARDENING_ENV },
      });
    } catch (err) {
      resolve({
        ok: false,
        error: { code: "INTERNAL", message: err instanceof Error ? err.message : String(err) },
      });
      return;
    }
    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill("SIGTERM");
    }, GIT_TIMEOUT_MS);

    proc.stdout?.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > MAX_OUTPUT_BYTES) {
        outputCapped = true;
        proc.kill("SIGTERM");
        return;
      }
      stdoutChunks.push(chunk);
    });
    proc.stderr?.on("data", (chunk: Buffer) => {
      stderrBytes += chunk.length;
      if (stderrBytes < 64 * 1024) stderrChunks.push(chunk);
    });
    proc.on("error", (err) => {
      clearTimeout(timer);
      resolve({
        ok: false,
        error: { code: "INTERNAL", message: err.message },
      });
    });
    proc.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) {
        resolve({
          ok: false,
          error: { code: "TIMEOUT", cwd, durationMs: Date.now() - start },
        });
        return;
      }
      if (outputCapped) {
        resolve({
          ok: false,
          error: { code: "OUTPUT_TOO_LARGE", cwd, cap: MAX_OUTPUT_BYTES },
        });
        return;
      }
      const stdout = Buffer.concat(stdoutChunks).toString("utf8");
      const stderr = Buffer.concat(stderrChunks).toString("utf8");
      if (code !== 0) {
        if (/not a git repository/i.test(stderr)) {
          resolve({ ok: false, error: { code: "NOT_A_REPO", cwd } });
          return;
        }
        resolve({
          ok: false,
          error: { code: "GIT_FAILED", cwd, status: code ?? -1, stderr: stderr.slice(0, 500) },
        });
        return;
      }
      resolve({ ok: true, stdout, stderr });
    });
  });
}

export function parsePorcelain(stdout: string): WorkspaceGitStatusEntry[] {
  if (!stdout) return [];
  const records = stdout.split(NUL).filter((r) => r.length > 0);
  const out: WorkspaceGitStatusEntry[] = [];
  for (let i = 0; i < records.length; i++) {
    const rec = records[i];
    if (rec.length < 3) continue;
    const xy = rec.slice(0, 2);
    const filePath = rec.slice(3);
    const change = porcelainXyToChange(xy);
    if (change === "renamed") {
      i++;
    }
    out.push({ path: filePath, change });
  }
  return out;
}

function porcelainXyToChange(xy: string): WorkspaceGitStatusEntry["change"] {
  if (xy.includes("R") || xy.includes("C")) return "renamed";
  if (xy === "??") return "untracked";
  if (xy.includes("D")) return "deleted";
  if (xy.includes("A")) return "added";
  return "modified";
}

export function parseLog(stdout: string): WorkspaceGitLogEntry[] {
  if (!stdout) return [];
  const records = stdout.split(RECORD_SEPARATOR).filter((r) => r.trim().length > 0);
  const out: WorkspaceGitLogEntry[] = [];
  for (const rec of records) {
    const parts = rec.split(UNIT_SEPARATOR);
    if (parts.length < 4) continue;
    const ts = Number.parseInt(parts[2], 10);
    if (!Number.isFinite(ts)) continue;
    out.push({
      sha: parts[0],
      author: parts[1],
      ts,
      subject: parts[3],
    });
  }
  return out;
}
