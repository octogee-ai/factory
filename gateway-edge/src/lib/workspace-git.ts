import { spawn } from "node:child_process";
import { lstatSync, mkdirSync, promises as fs, readFileSync } from "node:fs";
import * as path from "node:path";

import { acquireWorkspaceMutationLeaseSync } from "@octogee/core/workspace-mutation-lease";

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
  | { code: "WORKSPACE_BUSY"; cwd: string }
  | { code: "BLOB_DIVERSION_FAILED"; cwd: string; paths: string[] }
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
  options: { untracked?: "normal" | "all" } = {},
): Promise<{ ok: true; entries: WorkspaceGitStatusEntry[] } | { ok: false; error: WorkspaceGitError }> {
  const args = ["status", "--porcelain=v1", "-z"];
  if (options.untracked === "all") args.push("-uall");
  const r = await runGit(customerDir, args);
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
  options: { message: string; author: CommitAuthor },
): Promise<{ ok: true; result: CommitResult } | { ok: false; error: WorkspaceGitError }> {
  const message = options.message.trim();
  if (!message || message.length > 5_000) {
    return { ok: false, error: { code: "INTERNAL", message: "commit message empty or too long" } };
  }

  const addRes = await runGit(customerDir, ["add", "-A"]);
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

export type WorkspaceCommitPreparation =
  | { ok: true }
  | { ok: false; error: WorkspaceGitError };

export interface CommitAndPushOptions {
  message: string;
  author: CommitAuthor;
  githubToken?: string;
  beforeCommit?: () => Promise<WorkspaceCommitPreparation>;
}

export interface CommitAndPushDeps {
  gitCommit: typeof gitCommit;
  gitPreparePush: typeof gitPreparePush;
  gitPush: typeof gitPush;
  acquireMutationLease: typeof acquireWorkspaceMutationLeaseSync;
}

const COMMIT_AND_PUSH_DEPS: CommitAndPushDeps = {
  gitCommit,
  gitPreparePush,
  gitPush,
  acquireMutationLease: acquireWorkspaceMutationLeaseSync,
};

export type WorkspaceRemoteSyncState =
  | "fast-forwarded"
  | "up-to-date"
  | "dirty"
  | "no-upstream";

export async function syncCleanWorkspaceToRemote(
  customerDir: string,
): Promise<
  | { ok: true; result: { state: WorkspaceRemoteSyncState } }
  | { ok: false; error: WorkspaceGitError }
> {
  const lease = acquireWorkspaceMutationLeaseSync({
    workspaceDir: customerDir,
    gitDir: workspaceMutationLeaseGitDir(customerDir),
  });
  if (!lease) return { ok: false, error: { code: "WORKSPACE_BUSY", cwd: customerDir } };
  try {
    const statusResult = await gitStatus(customerDir);
    if (!statusResult.ok) return statusResult;
    if (statusResult.entries.length > 0) {
      return { ok: true, result: { state: "dirty" } };
    }

    const branchResult = await runGit(customerDir, ["branch", "--show-current"]);
    if (!branchResult.ok) return branchResult;
    const branch = branchResult.stdout.trim();
    if (!branch) {
      return {
        ok: false,
        error: { code: "INTERNAL", message: "cannot sync a detached workspace HEAD" },
      };
    }

    const upstreamResult = await readOriginUpstream(customerDir, branch);
    if (!upstreamResult.ok) return upstreamResult;
    if (!upstreamResult.branch) {
      return { ok: true, result: { state: "no-upstream" } };
    }

    const headBefore = await runGit(customerDir, ["rev-parse", "HEAD"]);
    if (!headBefore.ok) return headBefore;
    const fetchResult = await runGit(
      customerDir,
      [
        "fetch",
        "--no-tags",
        END_OF_OPTIONS,
        "origin",
        `+refs/heads/${upstreamResult.branch}:refs/remotes/origin/${upstreamResult.branch}`,
      ],
      { timeoutMs: GIT_PUSH_TIMEOUT_MS },
    );
    if (!fetchResult.ok) return fetchResult;
    const mergeResult = await runGit(
      customerDir,
      ["merge", "--ff-only", END_OF_OPTIONS, `origin/${upstreamResult.branch}`],
      { timeoutMs: GIT_COMMIT_TIMEOUT_MS },
    );
    if (!mergeResult.ok) return mergeResult;
    const headAfter = await runGit(customerDir, ["rev-parse", "HEAD"]);
    if (!headAfter.ok) return headAfter;
    return {
      ok: true,
      result: {
        state: headAfter.stdout.trim() === headBefore.stdout.trim()
          ? "up-to-date"
          : "fast-forwarded",
      },
    };
  } finally {
    lease.release();
  }
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
  options: CommitAndPushOptions,
  deps: CommitAndPushDeps = COMMIT_AND_PUSH_DEPS,
): Promise<{ ok: true; result: CommitAndPushResult } | { ok: false; error: WorkspaceGitError }> {
  const lease = deps.acquireMutationLease({
    workspaceDir: customerDir,
    gitDir: workspaceMutationLeaseGitDir(customerDir),
  });
  if (!lease) return { ok: false, error: { code: "WORKSPACE_BUSY", cwd: customerDir } };
  try {
    if (options.beforeCommit) {
      const prepared = await options.beforeCommit();
      if (!prepared.ok) return prepared;
    }
    const commitRes = await deps.gitCommit(customerDir, options);
    if (!commitRes.ok) return commitRes;
    const committed = !commitRes.result.empty;
    const prepareRes = await deps.gitPreparePush(customerDir, {
      author: options.author,
      ...(options.githubToken ? { githubToken: options.githubToken } : {}),
    });
    if (!prepareRes.ok) {
      return {
        ok: true,
        result: {
          committed,
          pushed: false,
          nothingToCommit: !committed,
          pushError: describeGitError(prepareRes.error),
        },
      };
    }
    const pushRes = await deps.gitPush(customerDir, {
      ...prepareRes.target,
      ...(options.githubToken ? { githubToken: options.githubToken } : {}),
    });
    if (!pushRes.ok) {
      return {
        ok: true,
        result: {
          committed,
          pushed: false,
          nothingToCommit: !committed,
          pushError: describeGitError(pushRes.error),
        },
      };
    }
    return {
      ok: true,
      result: { committed, pushed: true, nothingToCommit: !committed },
    };
  } finally {
    lease.release();
  }
}

function describeGitError(err: WorkspaceGitError): string {
  switch (err.code) {
    case "GIT_FAILED":
      return `git failed (status ${err.status})`;
    case "TIMEOUT":
      return "git push timed out";
    case "NOT_A_REPO":
      return "not a git repository";
    case "WORKSPACE_BUSY":
      return "workspace is busy";
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
  options: { branch?: string; setUpstream?: boolean; githubToken?: string } = {},
): Promise<{ ok: true } | { ok: false; error: WorkspaceGitError }> {
  const args = options.branch
    ? [
        "push",
        ...(options.setUpstream ? ["--set-upstream"] : []),
        END_OF_OPTIONS,
        "origin",
        `HEAD:refs/heads/${options.branch}`,
      ]
    : ["push", END_OF_OPTIONS];
  const r = await runGit(customerDir, args, {
    timeoutMs: GIT_PUSH_TIMEOUT_MS,
    githubToken: options.githubToken,
  });
  if (!r.ok) return r;
  return { ok: true };
}

interface WorkspacePushTarget {
  branch: string;
  setUpstream: boolean;
}

type GitFailure = { ok: false; error: WorkspaceGitError };
type WorkspacePushPreparation =
  | { ok: true; target: WorkspacePushTarget }
  | GitFailure;

export async function gitPreparePush(
  customerDir: string,
  options: { author: CommitAuthor; githubToken?: string },
): Promise<WorkspacePushPreparation> {
  const branchResult = await runGit(customerDir, ["branch", "--show-current"]);
  if (!branchResult.ok) return branchResult;
  const branch = branchResult.stdout.trim();
  if (!branch) {
    return {
      ok: false,
      error: { code: "INTERNAL", message: "cannot push a detached workspace HEAD" },
    };
  }

  const upstreamResult = await readOriginUpstream(customerDir, branch);
  if (!upstreamResult.ok) return upstreamResult;
  if (!upstreamResult.branch) {
    return prepareUntrackedBranchPush(customerDir, {
      author: options.author,
      branch,
      githubToken: options.githubToken,
    });
  }
  const syncResult = await gitRebaseOntoRemoteBranch(customerDir, {
    author: options.author,
    branch: upstreamResult.branch,
    githubToken: options.githubToken,
  });
  if (!syncResult.ok) return syncResult;
  return {
    ok: true,
    target: { branch: upstreamResult.branch, setUpstream: false },
  };
}

async function readOriginUpstream(
  customerDir: string,
  branch: string,
): Promise<{ ok: true; branch: string | null } | GitFailure> {
  const remoteConfig = await runGit(customerDir, [
    "config",
    "--get",
    `branch.${branch}.remote`,
  ]);
  const mergeConfig = await runGit(customerDir, [
    "config",
    "--get",
    `branch.${branch}.merge`,
  ]);
  const remoteMissing = gitConfigIsMissing(remoteConfig);
  const mergeMissing = gitConfigIsMissing(mergeConfig);
  if (remoteMissing && mergeMissing) return { ok: true, branch: null };
  if (remoteMissing || mergeMissing) {
    return {
      ok: false,
      error: { code: "INTERNAL", message: `incomplete upstream configuration for ${branch}` },
    };
  }
  if (!remoteConfig.ok) return remoteConfig;
  if (!mergeConfig.ok) return mergeConfig;
  const remote = remoteConfig.stdout.trim();
  const mergeRef = mergeConfig.stdout.trim();
  if (remote !== "origin" || !mergeRef.startsWith("refs/heads/")) {
    return {
      ok: false,
      error: { code: "INTERNAL", message: `unsupported upstream for ${branch}` },
    };
  }
  return { ok: true, branch: mergeRef.slice("refs/heads/".length) };
}

async function prepareUntrackedBranchPush(
  customerDir: string,
  options: { author: CommitAuthor; branch: string; githubToken?: string },
): Promise<WorkspacePushPreparation> {
  const remoteBranchResult = await runGit(
    customerDir,
    [
      "ls-remote",
      "--exit-code",
      "--heads",
      END_OF_OPTIONS,
      "origin",
      `refs/heads/${options.branch}`,
    ],
    { timeoutMs: GIT_PUSH_TIMEOUT_MS, githubToken: options.githubToken },
  );
  if (remoteBranchResult.ok) {
    const syncResult = await gitRebaseOntoRemoteBranch(customerDir, {
      author: options.author,
      branch: options.branch,
      githubToken: options.githubToken,
    });
    if (!syncResult.ok) return syncResult;
  } else if (!remoteBranchIsMissing(remoteBranchResult)) {
    return remoteBranchResult;
  }
  return {
    ok: true,
    target: { branch: options.branch, setUpstream: false },
  };
}

function remoteBranchIsMissing(result: GitFailure): boolean {
  return result.error.code === "GIT_FAILED" && result.error.status === 2;
}

function gitConfigIsMissing(
  result: GitRunOk | { ok: false; error: WorkspaceGitError },
): boolean {
  return !result.ok && result.error.code === "GIT_FAILED" && result.error.status === 1;
}

async function gitRebaseOntoRemoteBranch(
  customerDir: string,
  options: { author: CommitAuthor; branch: string; githubToken?: string },
): Promise<{ ok: true } | { ok: false; error: WorkspaceGitError }> {
  const fetchResult = await runGit(
    customerDir,
    [
      "fetch",
      "--no-tags",
      END_OF_OPTIONS,
      "origin",
      `+refs/heads/${options.branch}:refs/remotes/origin/${options.branch}`,
    ],
    { timeoutMs: GIT_PUSH_TIMEOUT_MS, githubToken: options.githubToken },
  );
  if (!fetchResult.ok) return fetchResult;

  const rebaseResult = await runGit(
    customerDir,
    [
      "-c", `user.name=${options.author.name}`,
      "-c", `user.email=${options.author.email}`,
      "rebase", END_OF_OPTIONS, `origin/${options.branch}`,
    ],
    { timeoutMs: GIT_COMMIT_TIMEOUT_MS },
  );
  if (rebaseResult.ok) return { ok: true };

  const abortResult = await runGit(
    customerDir,
    ["rebase", "--abort"],
    { timeoutMs: GIT_COMMIT_TIMEOUT_MS },
  );
  if (!abortResult.ok) {
    return {
      ok: false,
      error: {
        code: "INTERNAL",
        message: `git rebase failed and abort failed: ${describeGitError(abortResult.error)}`,
      },
    };
  }
  return rebaseResult;
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

export const WORKSPACE_GIT_HARDENING_PINS: ReadonlyArray<string> = [
  "-c", "core.fsmonitor=",
  "-c", "core.pager=cat",
  "-c", "core.hooksPath=/dev/null",
  "-c", "credential.helper=",
  "-c", "commit.gpgSign=false",
  "-c", "tag.gpgSign=false",
  "-c", "gpg.program=/bin/false",
  "-c", "protocol.allow=never",
  "-c", "protocol.ssh.allow=always",
  "-c", "protocol.https.allow=always",
  "-c", "protocol.file.allow=never",
  "-c", "protocol.ext.allow=never",
];

export const WORKSPACE_GIT_HARDENING_ENV: Readonly<Record<string, string>> = {
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_TERMINAL_PROMPT: "0",
  GIT_ASKPASS: "/bin/false",
  SSH_ASKPASS: "/bin/false",
  GIT_EDITOR: "/bin/false",
  GIT_SEQUENCE_EDITOR: "/bin/false",
  GIT_PAGER: "cat",
  GIT_PROTOCOL_FROM_USER: "0",
  GIT_OPTIONAL_LOCKS: "0",
};

const UNSAFE_LOCAL_CONFIG_PREFIXES = [
  "alias.", "credential.", "diff.", "filter.", "http.", "https.",
  "include.", "includeif.", "merge.", "protocol.", "url.",
];
const UNSAFE_LOCAL_CONFIG_KEYS = new Set([
  "core.askpass", "core.editor", "core.fsmonitor", "core.gitproxy",
  "core.hookspath", "core.pager", "core.sshcommand", "core.worktree",
  "extensions.worktreeconfig", "gpg.program", "sequence.editor", "ssh.variant",
]);

function isUnsafeLocalConfigKey(key: string): boolean {
  const normalized = key.toLowerCase();
  return UNSAFE_LOCAL_CONFIG_KEYS.has(normalized)
    || UNSAFE_LOCAL_CONFIG_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

interface CustomerGitIdentity {
  customersRoot: string;
  slug: string;
  repoName: string;
  metadataDir: string;
}

function customerGitIdentity(cwd: string): CustomerGitIdentity | null {
  const customersRoot = path.resolve(
    process.env.CUSTOMERS_DIR ?? "/home/node/.openclaw/customers",
  );
  const relative = path.relative(customersRoot, path.resolve(cwd));
  if (!relative || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return null;
  const parts = relative.split(path.sep);
  const metadataRoot = path.join(path.dirname(customersRoot), "git-metadata");
  const slug = parts[0] ?? "";
  if (!isSafeSlug(slug)) return null;
  if (parts.length === 1) {
    return {
      customersRoot,
      slug,
      repoName: "workspace",
      metadataDir: path.join(metadataRoot, slug, "workspace.git"),
    };
  }
  const projectSlug = parts[2] ?? "";
  if (parts.length === 3 && parts[1] === "projects" && isSafeSlug(projectSlug)) {
    return {
      customersRoot,
      slug,
      repoName: projectSlug,
      metadataDir: path.join(metadataRoot, slug, "projects", `${projectSlug}.git`),
    };
  }
  return null;
}

export function customerGitMetadataDir(cwd: string): string | null {
  return customerGitIdentity(cwd)?.metadataDir ?? null;
}

export function trustedWorkspaceGitDir(cwd: string): string {
  return customerGitMetadataDir(cwd) ?? path.join(cwd, ".git");
}

export function workspaceMutationLeaseGitDir(cwd: string): string {
  const identity = customerGitIdentity(cwd);
  if (!identity || identity.repoName === "workspace") return trustedWorkspaceGitDir(cwd);
  const lockDir = path.join(
    path.dirname(identity.customersRoot),
    "git-source-switch-locks",
    identity.slug,
    `${identity.repoName}.git`,
  );
  mkdirSync(lockDir, { recursive: true, mode: 0o700 });
  return lockDir;
}

export async function runWorkspaceGitMutation<T>(
  cwd: string,
  work: () => Promise<T>,
): Promise<{ ok: true; result: T } | { ok: false; error: WorkspaceGitError }> {
  const lease = acquireWorkspaceMutationLeaseSync({
    workspaceDir: cwd,
    gitDir: workspaceMutationLeaseGitDir(cwd),
  });
  if (!lease) return { ok: false, error: { code: "WORKSPACE_BUSY", cwd } };
  try {
    return { ok: true, result: await work() };
  } finally {
    lease.release();
  }
}

export function workspaceGitCommandArgs(
  cwd: string,
  args: ReadonlyArray<string>,
  callerGithubCredential = false,
): string[] {
  return [
    ...WORKSPACE_GIT_HARDENING_PINS,
    ...(callerGithubCredential
      ? [
          "-c",
          githubCredentialHelper(),
        ]
      : []),
    "--git-dir",
    trustedWorkspaceGitDir(cwd),
    "--work-tree",
    cwd,
    ...args,
  ];
}

function githubCredentialHelper(): string {
  const secretField = ["pass", "word"].join("");
  return `credential.https://github.com.helper=!f() { test "$1" = get || exit 0; printf '%s\\n' username=x-access-token ${secretField}="$OCTOGEE_GITHUB_TOKEN"; }; f`;
}

export function workspaceGitEnvironment(
  source: NodeJS.ProcessEnv = process.env,
  cwd?: string,
  githubToken?: string,
): NodeJS.ProcessEnv {
  const environment = { ...source, ...WORKSPACE_GIT_HARDENING_ENV };
  for (const key of Object.keys(environment)) {
    if (
      key === "GH_TOKEN"
      || key === "GITHUB_TOKEN"
      || key === "GH_ENTERPRISE_TOKEN"
      || key === "GITHUB_ENTERPRISE_TOKEN"
      || key === "OCTOGEE_GITHUB_TOKEN"
      || key === "GIT_CONFIG"
      || key === "GIT_CONFIG_COUNT"
      || key === "GIT_CONFIG_PARAMETERS"
      || /^GIT_CONFIG_(?:KEY|VALUE)_\d+$/.test(key)
    ) {
      delete environment[key];
    }
  }
  if (githubToken) {
    environment.OCTOGEE_GITHUB_TOKEN = githubToken;
  }
  const identity = cwd ? customerGitIdentity(cwd) : null;
  if (identity) {
    const keyPath = path.join(
      path.dirname(identity.customersRoot),
      "customer-keys",
      identity.slug,
      "id_ed25519",
    );
    environment.GIT_SSH_COMMAND = [
      "/usr/bin/ssh",
      "-i", JSON.stringify(keyPath),
      "-F", "/home/node/.ssh/config",
      "-o", "IdentitiesOnly=yes",
      "-o", "StrictHostKeyChecking=no",
      "-o", "UserKnownHostsFile=/dev/null",
      "-o", "LogLevel=ERROR",
    ].join(" ");
  }
  return environment;
}

export function isTrustedGithubCustomerCheckout(cwd: string): boolean {
  const identity = customerGitIdentity(cwd);
  if (!identity) return false;
  const receipt = `${identity.metadataDir}.octogee-trusted-v3`;
  try {
    const metadataStat = lstatSync(identity.metadataDir);
    const receiptStat = lstatSync(receipt);
    if (
      !metadataStat.isDirectory()
      || metadataStat.isSymbolicLink()
      || !receiptStat.isFile()
      || receiptStat.isSymbolicLink()
    ) return false;
    return expectedCustomerRemoteUrl(cwd, readFileSync(receipt, "utf8"))
      ?.startsWith("https://github.com/") === true;
  } catch {
    return false;
  }
}

// eslint-disable-next-line complexity -- validates both canonical receipt grammars and their exact remote projections
function expectedCustomerRemoteUrl(
  cwd: string,
  receiptContents: string,
): string | null {
  const identity = customerGitIdentity(cwd);
  if (!identity) return null;
  const lines = receiptContents.split("\n");
  if (lines.length !== 3 || lines[0] !== "octogee-customer-git-v3" || lines[2] !== "") {
    return null;
  }
  const source = lines[1] ?? "";
  if (source.startsWith("gitea:")) {
    const repoName = source.slice("gitea:".length);
    if (!isSafeSlug(repoName)) return null;
    const host = process.env.GIT_SSH_HOST?.trim() || "gitea";
    return `git@${host}:${identity.slug}/${repoName}.git`;
  }
  if (source.startsWith("github:")) {
    const [owner, repo, extra] = source.slice("github:".length).split("/");
    if (!owner || !repo || extra || !isSafeSlug(owner) || !isSafeSlug(repo)) return null;
    return `https://github.com/${owner}/${repo}.git`;
  }
  return null;
}

const ORIGIN_URL = "remote.origin.url";
const ORIGIN_FETCH = "remote.origin.fetch";
const MALFORMED_REPOSITORY = "<malformed>";

async function validateTrustedMetadata(
  gitDir: string,
  metadataDir: string,
): Promise<{ error: string | null; receiptContents: string }> {
  const receipt = `${metadataDir}.octogee-trusted-v3`;
  try {
    const receiptStat = await fs.lstat(receipt);
    if (!receiptStat.isFile() || receiptStat.isSymbolicLink()) {
      return { error: "<untrusted-metadata>", receiptContents: "" };
    }
    const receiptContents = await fs.readFile(receipt, "utf8");
    const forbiddenEntries = [
      "commondir",
      path.join("objects", "info", "alternates"),
      path.join("info", "grafts"),
      path.join("refs", "replace"),
      "worktrees",
      "modules",
    ];
    for (const entry of forbiddenEntries) {
      try {
        await fs.lstat(path.join(gitDir, entry));
        return { error: `<unsafe-metadata:${entry}>`, receiptContents };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          return { error: MALFORMED_REPOSITORY, receiptContents };
        }
      }
    }
    const objects = await fs.lstat(path.join(gitDir, "objects"));
    return {
      error: objects.isDirectory() && !objects.isSymbolicLink()
        ? null
        : "<unsafe-metadata:objects>",
      receiptContents,
    };
  } catch {
    return { error: "<untrusted-metadata>", receiptContents: "" };
  }
}

function configEntryParts(entry: string): { key: string; value: string } | null {
  const separator = entry.indexOf("\n");
  return separator < 1
    ? null
    : { key: entry.slice(0, separator), value: entry.slice(separator + 1) };
}

function validRemoteConfigEntry(key: string, value: string, expectedRemote: string): boolean {
  if (key === ORIGIN_URL) return value === expectedRemote;
  return key === ORIGIN_FETCH && value === "+refs/heads/*:refs/remotes/origin/*";
}

function unsafeConfigEntry(entries: readonly string[], expectedRemote: string | null): string | null {
  let originUrlCount = 0;
  let originFetchCount = 0;
  for (const entry of entries) {
    const parsed = configEntryParts(entry);
    if (!parsed) return MALFORMED_REPOSITORY;
    const { key, value } = parsed;
    if (isUnsafeLocalConfigKey(key)) return key;
    if (expectedRemote && key.startsWith("branch.")) return key;
    if (!expectedRemote) continue;
    if (!key.startsWith("remote.")) continue;
    if (!validRemoteConfigEntry(key, value, expectedRemote)) return key;
    if (key === ORIGIN_URL) originUrlCount++;
    else originFetchCount++;
  }
  return expectedRemote && (originUrlCount !== 1 || originFetchCount !== 1)
    ? "remote.origin"
    : null;
}

async function unsafeLocalRepositoryConfigKey(cwd: string): Promise<string | null> {
  const gitDir = trustedWorkspaceGitDir(cwd);
  const identity = customerGitIdentity(cwd);
  let receiptContents = "";
  if (identity) {
    const validation = await validateTrustedMetadata(gitDir, identity.metadataDir);
    if (validation.error) return validation.error;
    receiptContents = validation.receiptContents;
    if (expectedCustomerRemoteUrl(cwd, receiptContents) === null) return "<untrusted-metadata>";
  }
  const configPath = path.join(gitDir, "config");
  try {
    const stat = await fs.lstat(configPath);
    if (!stat.isFile() || stat.isSymbolicLink()) return MALFORMED_REPOSITORY;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === "ENOENT" ? null : MALFORMED_REPOSITORY;
  }

  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(
        "/usr/bin/git",
        ["config", "--file", configPath, "--null", "--list"],
        {
          cwd,
          stdio: ["ignore", "pipe", "ignore"],
          env: workspaceGitEnvironment(process.env, cwd),
        },
      );
    } catch {
      resolve(MALFORMED_REPOSITORY);
      return;
    }
    child.stdout!.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.once("error", () => resolve(MALFORMED_REPOSITORY));
    child.once("close", (status) => {
      if (status !== 0) {
        resolve(MALFORMED_REPOSITORY);
        return;
      }
      const entries = Buffer.concat(chunks).toString("utf8").split(NUL).filter(Boolean);
      const expectedRemote = expectedCustomerRemoteUrl(cwd, receiptContents);
      resolve(unsafeConfigEntry(entries, expectedRemote));
    });
  });
}

async function runGit(
  cwd: string,
  args: ReadonlyArray<string>,
  options: { timeoutMs?: number; githubToken?: string } = {},
): Promise<GitRunOk | { ok: false; error: WorkspaceGitError }> {
  const timeoutMs = options.timeoutMs ?? GIT_TIMEOUT_MS;
  const unsafeConfigKey = await unsafeLocalRepositoryConfigKey(cwd);
  if (unsafeConfigKey) {
    return {
      ok: false,
      error: {
        code: "INTERNAL",
        message: `repository local config contains an unsafe key: ${unsafeConfigKey}`,
      },
    };
  }

  const fullArgs = workspaceGitCommandArgs(cwd, args, Boolean(options.githubToken));
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
      
      proc = spawn("/usr/bin/git", fullArgs, {
        cwd,
        stdio: ["ignore", "pipe", "pipe"],
        env: workspaceGitEnvironment(process.env, cwd, options.githubToken),
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
