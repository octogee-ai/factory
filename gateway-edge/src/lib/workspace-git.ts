import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import * as path from "node:path";

const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
const GIT_TIMEOUT_MS = 5_000;

const GIT_PUSH_TIMEOUT_MS = 60_000;
const GIT_COMMIT_TIMEOUT_MS = 30_000;

const END_OF_OPTIONS = "--end-of-options";

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

const SAFE_SLUG_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/;

export function isSafeSlug(slug: string): boolean {
  return SAFE_SLUG_RE.test(slug);
}

export async function resolveCustomerDir(
  customersRoot: string,
  slug: string,
): Promise<string | null> {
  if (!isSafeSlug(slug)) return null;
  const dir = path.join(customersRoot, slug);
  return verifyGitDir(dir);
}

export async function resolveProjectDir(
  customersRoot: string,
  slug: string,
  projectSlug: string,
): Promise<string | null> {
  if (!isSafeSlug(slug) || !isSafeSlug(projectSlug)) return null;
  const dir = path.join(customersRoot, slug, "projects", projectSlug);
  return verifyGitDir(dir);
}

async function verifyGitDir(dir: string): Promise<string | null> {
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

const args = ["diff", "--no-color", "--no-ext-diff", END_OF_OPTIONS, options.ref ?? "HEAD"];
  if (options.path) {
    args.push("--", options.path);
  }
  const r = await runGit(customerDir, args);
  if (!r.ok) return r;
  return { ok: true, diff: r.stdout };
}

export async function gitCommitDiff(
  customerDir: string,
  sha: string,
): Promise<{ ok: true; diff: string } | { ok: false; error: WorkspaceGitError }> {
  const args = [
    "diff-tree",
    "--no-commit-id",
    "--no-color",
    "--no-ext-diff",
    "-p",
    "-r",
    "--root",
    END_OF_OPTIONS,
    sha,
  ];
  const r = await runGit(customerDir, args);
  if (!r.ok) return r;
  return { ok: true, diff: r.stdout };
}

export async function gitLog(
  customerDir: string,
  options: { limit?: number; branch?: string } = {},
): Promise<{ ok: true; entries: WorkspaceGitLogEntry[] } | { ok: false; error: WorkspaceGitError }> {
  const limit = clampLimit(options.limit ?? 20);
  
  const FMT = `%H${UNIT_SEPARATOR}%aN${UNIT_SEPARATOR}%ct${UNIT_SEPARATOR}%s${RECORD_SEPARATOR}`;
  const args = ["log", "--no-ext-diff", `-n${limit}`, `--pretty=format:${FMT}`, END_OF_OPTIONS];
  if (options.branch) args.push(options.branch);
  const r = await runGit(customerDir, args);
  if (!r.ok) return r;
  return { ok: true, entries: parseLog(r.stdout) };
}

export interface CommitAuthor {
  name: string;
  email: string;
}

export interface CommitResult {
  sha: string;
  
  empty: boolean;
}

export async function gitCommit(
  customerDir: string,
  options: { message: string; author: CommitAuthor; excludePathspecs?: string[] },
): Promise<{ ok: true; result: CommitResult } | { ok: false; error: WorkspaceGitError }> {
  const message = options.message.trim();
  if (!message || message.length > 5_000) {
    return { ok: false, error: { code: "INTERNAL", message: "commit message empty or too long" } };
  }

  const excludes = options.excludePathspecs ?? [];
  const addArgs =
    excludes.length > 0
      ? ["add", "-A", "--", ".", ...excludes.map((p) => `:(exclude)${p}`)]
      : ["add", "-A"];
  const addRes = await runGit(customerDir, addArgs);
  if (!addRes.ok) return addRes;

const statusRes = await runGit(customerDir, ["status", "--porcelain=v1", "-z"]);
  if (!statusRes.ok) return statusRes;
  if (parsePorcelain(statusRes.stdout).length === 0) {
    return { ok: true, result: { sha: "", empty: true } };
  }

const commitRes = await runGit(
    customerDir,
    [
      "-c", `user.name=${options.author.name}`,
      "-c", `user.email=${options.author.email}`,
      "commit",
      "--no-verify",
      "-m", message,
    ],
    { timeoutMs: GIT_COMMIT_TIMEOUT_MS },
  );
  if (!commitRes.ok) return commitRes;

  const shaRes = await runGit(customerDir, ["rev-parse", "HEAD"]);
  if (!shaRes.ok) return shaRes;
  return { ok: true, result: { sha: shaRes.stdout.trim(), empty: false } };
}

export interface CommitAndPushResult {
  committed: boolean;
  pushed: boolean;
  nothingToCommit: boolean;
  pushError?: string;
}

export interface CommitAndPushDeps {
  gitCommit: typeof gitCommit;
  gitPush: typeof gitPush;
}

/**
 * Commit local workspace changes and push them — the explicit "save now" an
 * exec-off agent triggers via `workspace_commit`. `gitCommit` reports `empty`
 * when there was nothing to stage (a clean no-op). A push that fails AFTER a
 * successful commit is not fatal: the commit is durable on the PVC and the
 * autosave / pre-stop flush retries the push — we surface `pushed:false` +
 * `pushError` so the caller can tell the user rather than silently swallow it.
 */
export async function commitAndPushWorkspace(
  customerDir: string,
  options: { message: string; author: CommitAuthor; excludePathspecs?: string[] },
  deps: CommitAndPushDeps = { gitCommit, gitPush },
): Promise<{ ok: true; result: CommitAndPushResult } | { ok: false; error: WorkspaceGitError }> {
  const commitRes = await deps.gitCommit(customerDir, options);
  if (!commitRes.ok) return commitRes;
  if (commitRes.result.empty) {
    return { ok: true, result: { committed: false, pushed: false, nothingToCommit: true } };
  }
  const pushRes = await deps.gitPush(customerDir, {});
  if (!pushRes.ok) {
    return {
      ok: true,
      result: {
        committed: true,
        pushed: false,
        nothingToCommit: false,
        pushError: describeGitError(pushRes.error),
      },
    };
  }
  return { ok: true, result: { committed: true, pushed: true, nothingToCommit: false } };
}

function describeGitError(err: WorkspaceGitError): string {
  switch (err.code) {
    case "GIT_FAILED":
      return `git failed (status ${err.status})`;
    case "TIMEOUT":
      return "git push timed out";
    case "NOT_A_REPO":
      return "not a git repository";
    default:
      return err.code;
  }
}

export interface WorkspaceGitBranchEntry {
  name: string;
  current: boolean;
}

export async function gitBranches(
  customerDir: string,
): Promise<{ ok: true; entries: WorkspaceGitBranchEntry[] } | { ok: false; error: WorkspaceGitError }> {
  const r = await runGit(customerDir, [
    "branch",
    "--list",
    "--format=%(refname:short)\t%(HEAD)",
  ]);
  if (!r.ok) return r;
  return { ok: true, entries: parseBranchList(r.stdout) };
}

export async function gitCheckout(
  customerDir: string,
  options: { branch: string; create?: boolean },
): Promise<{ ok: true } | { ok: false; error: WorkspaceGitError }> {
  const branch = options.branch;
  if (!branch || branch.length > 250 || branch.startsWith("-")) {
    return {
      ok: false,
      error: { code: "INTERNAL", message: "branch name empty, too long, or leading-dash" },
    };
  }

const args: string[] = options.create
    ? ["checkout", "-b", branch]
    : ["checkout", END_OF_OPTIONS, branch];
  const r = await runGit(customerDir, args);
  if (!r.ok) return r;
  return { ok: true };
}

export async function gitPush(
  customerDir: string,
  options: { branch?: string } = {},
): Promise<{ ok: true } | { ok: false; error: WorkspaceGitError }> {
  const args = options.branch
    ? ["push", END_OF_OPTIONS, "origin", options.branch]
    : ["push", END_OF_OPTIONS];
  const r = await runGit(customerDir, args, { timeoutMs: GIT_PUSH_TIMEOUT_MS });
  if (!r.ok) return r;
  return { ok: true };
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

const HARDENING_PINS: ReadonlyArray<string> = [
  "-c", "core.fsmonitor=",
  "-c", "core.pager=cat",
  "-c", "core.hooksPath=/dev/null",
  "-c", "gpg.program=/bin/false",
  "-c", "protocol.file.allow=never",
  "-c", "protocol.ext.allow=never",
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
  options: { timeoutMs?: number } = {},
): Promise<GitRunOk | { ok: false; error: WorkspaceGitError }> {
  const timeoutMs = options.timeoutMs ?? GIT_TIMEOUT_MS;

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
    }, timeoutMs);

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

export function parseBranchList(stdout: string): WorkspaceGitBranchEntry[] {
  if (!stdout) return [];
  const out: WorkspaceGitBranchEntry[] = [];
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const tabIdx = trimmed.indexOf("\t");
    const name = tabIdx >= 0 ? trimmed.slice(0, tabIdx) : trimmed;
    const headFlag = tabIdx >= 0 ? trimmed.slice(tabIdx + 1) : "";
    if (!name) continue;
    out.push({ name, current: headFlag === "*" });
  }
  return out;
}
