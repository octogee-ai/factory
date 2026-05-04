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
// Phase 6.C.2 — push and commit can run hooks (we neutralize them via
// core.hooksPath, but commit also resolves trees that may scan the
// working set) and push transfers packfiles. First push / large pack
// can legitimately exceed the 5s read-side default. Bumped here to
// keep the read routes (status/diff/log) tight while letting writes
// complete.
const GIT_PUSH_TIMEOUT_MS = 60_000;
const GIT_COMMIT_TIMEOUT_MS = 30_000;

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

/**
 * Slug allowlist: the same shape MM channel slugs and Gitea repo names
 * use. Positive allowlist (not a blacklist) so single-dot, all-dots,
 * leading-dash, empty, oversize, and any path-separator-bearing inputs
 * are all rejected by construction. Tightened in #841 review pass.
 */
const SAFE_SLUG_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/;

function isSafeSlug(slug: string): boolean {
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

/**
 * Phase 6.C.3 — project working trees live at
 * `{customersRoot}/{slug}/projects/{projectSlug}/`. Per
 * `docs/specs/PROJECTS-CANVAS-SPEC.md` §D11 / §boot-sync, each project is
 * its own git repo and the `projects/` folder is .gitignored from the
 * workspace tree, so the two trees never interfere.
 *
 * Both slug components are validated by `isSafeSlug` — positive allowlist
 * rejects empty, single-dot, double-dot, leading-dash, oversize, and any
 * input containing a path separator.
 */
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

/**
 * Phase 6.C.2 — workspace-owner-driven write operations.
 *
 * Author identity comes from the route layer (Firebase profile —
 * displayName + email of the workspace owner) rather than git config
 * inside the customer dir, because the customer-dir's existing git
 * identity belongs to the agent, not the workspace owner. We override
 * per-command via `-c user.name=` / `-c user.email=` to keep the agent's
 * config untouched.
 *
 * Push uses whatever remote auth the customer dir is already configured
 * for (SSH key + ssh-agent inside the gateway pod, OR HTTPS with
 * credential helper). No new auth surface — same path the agent uses.
 */

export interface CommitAuthor {
  name: string;
  email: string;
}

export interface CommitResult {
  sha: string;
  /** True when nothing was staged (clean working tree → no-op commit). */
  empty: boolean;
}

export async function gitCommit(
  customerDir: string,
  options: { message: string; author: CommitAuthor },
): Promise<{ ok: true; result: CommitResult } | { ok: false; error: WorkspaceGitError }> {
  const message = options.message.trim();
  if (!message || message.length > 5_000) {
    return { ok: false, error: { code: "INTERNAL", message: "commit message empty or too long" } };
  }
  // Stage everything in the working tree first. Mirrors what an agent
  // does internally (`git add -A`). Untracked + modified + deleted all
  // captured.
  const addRes = await runGit(customerDir, ["add", "-A"]);
  if (!addRes.ok) return addRes;

  // Check if there's anything to commit. `git diff --cached --quiet` exits
  // 0 if nothing is staged, 1 if something is staged. Emulate via porcelain.
  const statusRes = await runGit(customerDir, ["status", "--porcelain=v1", "-z"]);
  if (!statusRes.ok) return statusRes;
  if (parsePorcelain(statusRes.stdout).length === 0) {
    return { ok: true, result: { sha: "", empty: true } };
  }

  // Commit with per-command author override. -c flags BEFORE the
  // subcommand so they're "transient config" — they don't write to
  // .git/config. `--no-verify` is defense-in-depth on top of the
  // module-level `core.hooksPath=/dev/null` pin so a future regression
  // (or an unforeseen hook discovery path) can't re-arm the
  // commit-hook RCE vector.
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

  // Resolve the new HEAD sha.
  const shaRes = await runGit(customerDir, ["rev-parse", "HEAD"]);
  if (!shaRes.ok) return shaRes;
  return { ok: true, result: { sha: shaRes.stdout.trim(), empty: false } };
}

export interface WorkspaceGitBranchEntry {
  name: string;
  current: boolean;
}

/**
 * Lists local branches for the working tree, flagging the current one.
 * `--list` + `--format` keeps output machine-parseable. `HEAD` filtering
 * via `%(refname:short)` strips the `refs/heads/` prefix.
 *
 * Phase 6.C.3 — feeds the toolbar's branch-switcher dropdown.
 */
export async function gitBranches(
  customerDir: string,
): Promise<{ ok: true; entries: WorkspaceGitBranchEntry[] } | { ok: false; error: WorkspaceGitError }> {
  // Format: `<refname>\t<HEAD>` where HEAD is "*" for the current branch.
  // Tab is impossible in a git ref name (per git-check-ref-format), so
  // it's a safe field separator.
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
  // Ref name validation at the helper layer — defense in depth on top
  // of the route's regex. Empty/oversize/leading-dash are local errors
  // that shouldn't even reach git.
  if (!branch || branch.length > 250 || branch.startsWith("-")) {
    return {
      ok: false,
      error: { code: "INTERNAL", message: "branch name empty, too long, or leading-dash" },
    };
  }
  // Two argv shapes: `-b` consumes the next arg as the new branch name
  // and is incompatible with `--end-of-options` placement; the non-
  // create path uses `--end-of-options` as defense-in-depth against a
  // future caller bypassing the leading-dash check above.
  const args: string[] = options.create
    ? ["checkout", "-b", branch]
    : ["checkout", "--end-of-options", branch];
  const r = await runGit(customerDir, args);
  if (!r.ok) return r;
  return { ok: true };
}

export async function gitPush(
  customerDir: string,
  options: { branch?: string } = {},
): Promise<{ ok: true } | { ok: false; error: WorkspaceGitError }> {
  // No-arg push uses the current branch's upstream. With a branch arg,
  // push origin/<branch> explicitly. `--end-of-options` after the
  // subcommand separates flags from positionals (defense against future
  // callers passing user input as a remote name).
  const args = options.branch
    ? ["push", "--end-of-options", "origin", options.branch]
    : ["push", "--end-of-options"];
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

/**
 * Hardening pins (P0-2 of #825 review, extended in #839 Copilot pass).
 * The customer dir's `.git/config` is customer-controllable: an agent
 * edit can write keys like `diff.external = /bin/sh -c 'curl ...'`
 * that fire DURING `git diff`. These pins neutralize the attack surface:
 *
 *   -c core.fsmonitor=         disables fsmonitor exec on every command
 *   -c core.pager=cat          defuses pager (already piped; belt+suspenders)
 *   -c core.hooksPath=/dev/null  neutralizes ALL hook exec
 *                              (pre-commit / post-commit / pre-push / etc.).
 *                              Customer-controlled `.git/hooks/*` would
 *                              otherwise execute arbitrary code inside the
 *                              workspace-api sidecar on every commit/push.
 *   -c gpg.program=/bin/false  neutralizes signature-verify exec
 *   -c protocol.file.allow=never  blocks file:// (recursive-submodule RCE
 *                              vector). Phase 6.C.2 push uses HTTPS/SSH;
 *                              file:// is never legitimate here.
 *   -c protocol.ext.allow=never  blocks `ext::` URLs which git turns into
 *                              shell-out-with-args (`ext::sh -c '<args>'`),
 *                              defeating the file-only pin above. Default
 *                              is "user" (gated, but allowed in attended
 *                              git); `never` makes it unconditional.
 *
 * Defense-in-depth on commit: `--no-verify` flag still passed at the
 * subcommand level so a future `core.hooksPath` regression doesn't
 * silently re-arm the hook vector.
 *
 * NOT pinned (intentional):
 *   - `protocol.allow=never` — too restrictive: would block HTTPS + SSH
 *     too, breaking the Phase 6.C.2 push path.
 *   - `diff.external=` (empty) — git interprets that as "run empty cmd"
 *     and errors out. `--no-ext-diff` at the subcommand level is the
 *     correct neutralization (see gitDiff/gitLog).
 *
 * Plus env pins so the helper ignores ~/.gitconfig and /etc/gitconfig
 * and never prompts.
 */
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
