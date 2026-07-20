import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { classifyAgentImportArchivePath } from "@octogee/shared/types/agent-import";
import { getExtension, getMimeType, isTextFile } from "../routes/workspace/helpers.js";

const SHA_RE = /^[0-9a-f]{40}$/;
const IMPORT_ID_RE = /^[A-Za-z0-9._-]{1,160}$/;
const MAX_COMMAND_OUTPUT = 16 * 1024 * 1024;
const MAX_BINARY_BYTES = 100 * 1024 * 1024;

export interface AgentImportSecretFinding {
  ruleId: string;
  path: string;
  commit: string | null;
}

export interface AgentImportRepositoryInspection {
  head: string;
  commitCount: number;
  fileCount: number;
  totalBytes: number;
  workspaceDigest: string;
  secretFindings: AgentImportSecretFinding[];
}

export interface AgentImportManifestEntry {
  type: "blob";
  gcsPath: string;
  size: number;
  mimeType: string;
  uploadedAt: string;
  thumbnailUrl?: string;
}

interface CommandResult {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: Error;
}

type CommandRunner = (
  command: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv },
) => CommandResult;

export function buildAgentImportGitEnvironment(
  source: NodeJS.ProcessEnv = process.env,
  extra: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv {
  return {
    PATH: "/usr/local/bin:/usr/bin:/bin",
    LANG: source.LANG ?? "C.UTF-8",
    LC_ALL: source.LC_ALL ?? "C.UTF-8",
    HOME: os.tmpdir(),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
    ...extra,
  };
}

export class AgentImportGitError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "AgentImportGitError";
  }
}

function defaultRun(
  command: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv },
): CommandResult {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env ?? buildAgentImportGitEnvironment(),
    encoding: "utf8",
    timeout: 120_000,
    maxBuffer: MAX_COMMAND_OUTPUT,
    stdio: ["ignore", "pipe", "pipe"],
  });
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    ...(result.error ? { error: result.error } : {}),
  };
}

function safeCommandError(label: string, result: CommandResult): AgentImportGitError {
  const diagnostic = (result.error as NodeJS.ErrnoException | undefined)?.code === "ENOENT"
    ? "command unavailable"
    : `exit ${String(result.status)}`;
  return new AgentImportGitError("git_command_failed", `${label} failed (${diagnostic})`);
}

function command(
  executable: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; label?: string } = {},
): string {
  const result = defaultRun(executable, args, options);
  if (result.error || result.status !== 0) throw safeCommandError(options.label ?? executable, result);
  return result.stdout.trim();
}

function git(cwd: string, args: string[], env?: NodeJS.ProcessEnv, label = "git"): string {
  return command("/usr/bin/git", args, { cwd, env, label });
}

function readRef(cwd: string, ref: string): string | null {
  const result = defaultRun("git", ["rev-parse", "--verify", ref], { cwd });
  if (!result.error && (result.status === 1 || result.status === 128)) return null;
  if (result.error || result.status !== 0) throw safeCommandError("git ref lookup", result);
  return requireSha(result.stdout.trim(), "git ref");
}

function requireSha(value: string, label: string): string {
  if (!SHA_RE.test(value)) throw new AgentImportGitError("invalid_git_head", `${label} is not a commit SHA`);
  return value;
}

function trackedTree(repoDir: string, head: string): {
  serialized: string;
  fileCount: number;
  totalBytes: number;
} {
  const serialized = git(repoDir, ["ls-tree", "-r", "-l", "-z", head], undefined, "git tree inspection");
  let fileCount = 0;
  let totalBytes = 0;
  for (const raw of serialized.split("\0").filter(Boolean)) {
    const tab = raw.indexOf("\t");
    if (tab < 0) throw new AgentImportGitError("invalid_git_tree", "git tree output is malformed");
    const metadata = raw.slice(0, tab).trim().split(/\s+/);
    const mode = metadata[0];
    if (mode === "120000" || mode === "160000") {
      throw new AgentImportGitError("unsafe_git_entry", "symlinks and submodules are not importable");
    }
    if (mode !== "100644" && mode !== "100755") {
      throw new AgentImportGitError("unsafe_git_entry", `unsupported git entry mode ${mode}`);
    }
    fileCount += 1;
    const size = Number.parseInt(metadata[3] ?? "0", 10);
    if (Number.isFinite(size)) totalBytes += size;
  }
  return { serialized, fileCount, totalBytes };
}

function assertSafeHistoryPaths(repoDir: string, head: string): void {
  const serialized = git(
    repoDir,
    ["log", "--format=", "--name-only", "-z", head],
    undefined,
    "git history path inspection",
  );
  for (const raw of serialized.split("\0")) {
    let relative = raw;
    while (relative.startsWith("\n")) relative = relative.slice(1);
    while (relative.endsWith("\n")) relative = relative.slice(0, -1);
    if (!relative) continue;
    if (classifyAgentImportArchivePath(`workspace/${relative}`) !== "workspace") {
      throw new AgentImportGitError("unsafe_git_entry", "source history contains a blocked workspace path");
    }
  }
}

export async function inspectAgentImportRepository(
  repoDir: string,
  options: {
    head?: string;
    scanSecrets?: (repoDir: string) => Promise<AgentImportSecretFinding[]>;
  } = {},
): Promise<AgentImportRepositoryInspection> {
  git(repoDir, ["fsck", "--strict", "--no-dangling"], undefined, "git fsck");
  const head = requireSha(options.head ?? git(repoDir, ["rev-parse", "HEAD"]), "source head");
  git(repoDir, ["cat-file", "-e", `${head}^{commit}`], undefined, "source commit lookup");
  const tree = trackedTree(repoDir, head);
  assertSafeHistoryPaths(repoDir, head);
  const commitCount = Number.parseInt(git(repoDir, ["rev-list", "--count", head]), 10);
  if (!Number.isFinite(commitCount) || commitCount < 1) {
    throw new AgentImportGitError("invalid_git_history", "source history has no reachable commit");
  }
  const scanSecrets = options.scanSecrets ?? ((dir: string) => scanAgentImportSecrets(dir));
  const secretFindings = await scanSecrets(repoDir);
  if (secretFindings.length > 0) {
    throw new AgentImportGitError("secret_findings", "source repository contains credential-like material");
  }
  return {
    head,
    commitCount,
    fileCount: tree.fileCount,
    totalBytes: tree.totalBytes,
    workspaceDigest: `sha256:${createHash("sha256").update(head).update("\0").update(tree.serialized).digest("hex")}`,
    secretFindings,
  };
}

function readDirectory(sourceDir: string, destinationDir: string): void {
  fs.mkdirSync(destinationDir, { recursive: true });
  for (const entry of fs.readdirSync(sourceDir, { withFileTypes: true })) {
    if (entry.name === ".git") continue;
    const sourcePath = path.join(sourceDir, entry.name);
    const destinationPath = path.join(destinationDir, entry.name);
    const stat = fs.lstatSync(sourcePath);
    if (stat.isSymbolicLink()) {
      throw new AgentImportGitError("unsafe_git_entry", "workspace symlinks are not importable");
    }
    if (stat.isDirectory()) readDirectory(sourcePath, destinationPath);
    else if (stat.isFile()) fs.copyFileSync(sourcePath, destinationPath);
    else throw new AgentImportGitError("unsafe_git_entry", "workspace contains an unsupported filesystem entry");
  }
}

function clearWorkingTree(repoDir: string): void {
  for (const entry of fs.readdirSync(repoDir)) {
    if (entry !== ".git") fs.rmSync(path.join(repoDir, entry), { recursive: true, force: true });
  }
}

function preserveTargetPath(targetDir: string, stageDir: string, relativePath: string): void {
  const source = path.join(targetDir, relativePath);
  const destination = path.join(stageDir, relativePath);
  fs.rmSync(destination, { recursive: true, force: true });
  if (!fs.existsSync(source)) return;
  const stat = fs.lstatSync(source);
  if (stat.isSymbolicLink()) throw new AgentImportGitError("unsafe_platform_path", `${relativePath} is a symlink`);
  if (stat.isDirectory()) readDirectory(source, destination);
  else {
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(source, destination);
  }
}

function mergeGitignore(targetDir: string, stageDir: string): void {
  const sourcePath = path.join(stageDir, ".gitignore");
  const targetPath = path.join(targetDir, ".gitignore");
  const lines = [sourcePath, targetPath].flatMap((filePath) =>
    fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8").split(/\r?\n/) : []
  );
  const merged = [...new Set(lines.map((line) => line.trimEnd()).filter(Boolean))];
  if (merged.length > 0) fs.writeFileSync(sourcePath, `${merged.join("\n")}\n`);
}

function walkFiles(root: string, current = root): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
    if (current === root && entry.name === ".git") continue;
    const absolute = path.join(current, entry.name);
    const relative = path.relative(root, absolute).split(path.sep).join("/");
    const stat = fs.lstatSync(absolute);
    if (stat.isSymbolicLink()) throw new AgentImportGitError("unsafe_git_entry", `workspace path ${relative} is a symlink`);
    if (stat.isDirectory()) files.push(...walkFiles(root, absolute));
    else if (stat.isFile()) files.push(relative);
    else throw new AgentImportGitError("unsafe_git_entry", `workspace path ${relative} has an unsupported type`);
  }
  return files.sort();
}

function probablyText(filePath: string, contents: Buffer): boolean {
  if (isTextFile(filePath) || path.basename(filePath) === ".gitignore") return true;
  if (contents.includes(0)) return false;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(contents);
    return true;
  } catch {
    return false;
  }
}

function readManifest(targetDir: string): Record<string, AgentImportManifestEntry> {
  const manifestPath = path.join(targetDir, ".files", "manifest.json");
  if (!fs.existsSync(manifestPath)) return {};
  try {
    const parsed = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
    return parsed as Record<string, AgentImportManifestEntry>;
  } catch {
    throw new AgentImportGitError("invalid_platform_manifest", "destination blob manifest is invalid");
  }
}

async function normalizeBinaryTip(options: {
  stageDir: string;
  targetDir: string;
  storeBlob: (filePath: string, contents: Buffer, mimeType: string) => Promise<AgentImportManifestEntry>;
}): Promise<void> {
  const manifest = readManifest(options.targetDir);
  for (const relative of walkFiles(options.stageDir)) {
    if (relative === ".files/manifest.json" || relative.startsWith(".files/") || relative.startsWith("projects/")) continue;
    const absolute = path.join(options.stageDir, relative);
    const size = fs.statSync(absolute).size;
    if (size > MAX_BINARY_BYTES) {
      throw new AgentImportGitError("binary_too_large", `${relative} exceeds the import blob limit`);
    }
    const contents = fs.readFileSync(absolute);
    if (probablyText(relative, contents)) continue;
    const mimeType = getMimeType(getExtension(relative));
    manifest[relative] = await options.storeBlob(relative, contents, mimeType);
    fs.rmSync(absolute);
  }
  if (Object.keys(manifest).length === 0) return;
  const manifestPath = path.join(options.stageDir, ".files", "manifest.json");
  fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

function commitTree(
  repoDir: string,
  tree: string,
  parents: string[],
  message: string,
): string {
  const env = buildAgentImportGitEnvironment(process.env, {
    GIT_AUTHOR_NAME: "Octogee Agent Import",
    GIT_AUTHOR_EMAIL: "agent-import@octogee.invalid",
    GIT_COMMITTER_NAME: "Octogee Agent Import",
    GIT_COMMITTER_EMAIL: "agent-import@octogee.invalid",
  });
  const result = spawnSync("/usr/bin/git", ["commit-tree", tree, ...parents.flatMap((parent) => ["-p", parent])], {
    cwd: repoDir,
    env,
    input: `${message}\n`,
    encoding: "utf8",
    timeout: 30_000,
    maxBuffer: MAX_COMMAND_OUTPUT,
  });
  if (result.error || result.status !== 0) {
    throw safeCommandError("git commit-tree", {
      status: result.status,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
      ...(result.error ? { error: result.error } : {}),
    });
  }
  return requireSha((result.stdout ?? "").trim(), "created commit");
}

function checkedImportId(importId: string): string {
  if (!IMPORT_ID_RE.test(importId)) throw new AgentImportGitError("invalid_import_id", "import id is invalid");
  return importId;
}

function currentMainHead(targetDir: string): string {
  const branch = git(targetDir, ["symbolic-ref", "--short", "HEAD"]);
  if (branch !== "main") throw new AgentImportGitError("destination_branch", "destination workspace must be on main");
  return requireSha(git(targetDir, ["rev-parse", "HEAD"]), "destination head");
}

function ensureCleanDestination(targetDir: string): void {
  if (git(targetDir, ["status", "--porcelain", "--untracked-files=all"])) {
    throw new AgentImportGitError("destination_dirty", "destination workspace has uncommitted changes");
  }
}

function updateTarget(options: {
  targetDir: string;
  destinationHead: string;
  nextHead: string;
  sourceHead?: string;
  sourceRef?: string;
  importRef?: string;
  push: boolean;
}): void {
  git(options.targetDir, ["update-ref", "refs/heads/main", options.nextHead, options.destinationHead]);
  try {
    if (options.sourceHead && options.sourceRef) {
      git(options.targetDir, ["update-ref", options.sourceRef, options.sourceHead, "0".repeat(40)]);
    }
    if (options.importRef) {
      git(options.targetDir, ["update-ref", options.importRef, options.nextHead, "0".repeat(40)]);
    }
    git(options.targetDir, ["reset", "--hard", options.nextHead]);
    if (options.push) {
      const refs = [
        "refs/heads/main:refs/heads/main",
        ...(options.sourceRef ? [`${options.sourceRef}:${options.sourceRef}`] : []),
        ...(options.importRef ? [`${options.importRef}:${options.importRef}`] : []),
      ];
      git(options.targetDir, ["push", "--atomic", "origin", ...refs], undefined, "Gitea push");
    }
  } catch (error) {
    try {
      git(options.targetDir, ["update-ref", "refs/heads/main", options.destinationHead, options.nextHead]);
      git(options.targetDir, ["reset", "--hard", options.destinationHead]);
      if (options.sourceHead && options.sourceRef) {
        git(options.targetDir, ["update-ref", "-d", options.sourceRef, options.sourceHead]);
      }
      if (options.importRef) {
        git(options.targetDir, ["update-ref", "-d", options.importRef, options.nextHead]);
      }
    } catch {
      throw new AgentImportGitError("destination_restore_failed", "workspace import failed and local restore also failed");
    }
    throw error;
  }
}

export async function applyAgentImportRepository(options: {
  sourceDir: string;
  sourceHead: string;
  targetDir: string;
  destinationHead: string;
  importId: string;
  slug: string;
  storeBlob: (filePath: string, contents: Buffer, mimeType: string) => Promise<AgentImportManifestEntry>;
  push?: boolean;
}): Promise<{ importCommit: string; sourceRef: string }> {
  const sourceHead = requireSha(options.sourceHead, "source head");
  const destinationHead = requireSha(options.destinationHead, "destination head");
  const importId = checkedImportId(options.importId);
  const sourceRef = `refs/octogee/imports/${importId}/source`;
  const importRef = `refs/octogee/imports/${importId}/commit`;
  ensureCleanDestination(options.targetDir);
  if (requireSha(git(options.sourceDir, ["rev-parse", "HEAD"]), "source head") !== sourceHead) {
    throw new AgentImportGitError("source_changed", "source workspace changed after preview");
  }
  trackedTree(options.sourceDir, sourceHead);
  const currentHead = currentMainHead(options.targetDir);
  if (currentHead !== destinationHead) {
    const parents = git(options.targetDir, ["rev-list", "--parents", "-n", "1", currentHead]).split(" ");
    const subject = git(options.targetDir, ["show", "-s", "--format=%s", currentHead]);
    if (
      readRef(options.targetDir, sourceRef) === sourceHead &&
      readRef(options.targetDir, importRef) === currentHead &&
      parents.length === 3 &&
      parents[1] === destinationHead &&
      parents[2] === sourceHead &&
      subject === `Import agent workspace (${importId})`
    ) {
      return { importCommit: currentHead, sourceRef };
    }
    throw new AgentImportGitError("destination_changed", "destination workspace changed after preview");
  }
  const stageRoot = fs.mkdtempSync(path.join(os.tmpdir(), "octogee-agent-import-apply-"));
  const stageDir = path.join(stageRoot, "source");
  try {
    command("git", ["clone", "--quiet", "--no-hardlinks", options.sourceDir, stageDir], { label: "source staging clone" });
    clearWorkingTree(stageDir);
    readDirectory(options.sourceDir, stageDir);
    preserveTargetPath(options.targetDir, stageDir, ".files");
    preserveTargetPath(options.targetDir, stageDir, "projects");
    mergeGitignore(options.targetDir, stageDir);
    await normalizeBinaryTip({ stageDir, targetDir: options.targetDir, storeBlob: options.storeBlob });
    git(stageDir, ["add", "-A", "--", "."]);
    const tree = requireSha(git(stageDir, ["write-tree"]), "import tree");
    git(stageDir, ["fetch", "--quiet", "--no-tags", options.targetDir, destinationHead]);
    const importCommit = commitTree(
      stageDir,
      tree,
      [destinationHead, sourceHead],
      `Import agent workspace (${importId})`,
    );
    git(options.targetDir, ["fetch", "--quiet", "--no-tags", stageDir, importCommit]);
    updateTarget({
      targetDir: options.targetDir,
      destinationHead,
      nextHead: importCommit,
      sourceHead,
      sourceRef,
      importRef,
      push: options.push !== false,
    });
    return { importCommit, sourceRef };
  } finally {
    fs.rmSync(stageRoot, { recursive: true, force: true });
  }
}

export async function rollbackAgentImportRepository(options: {
  targetDir: string;
  importCommit: string;
  destinationHead: string;
  importId: string;
  push?: boolean;
}): Promise<{ rollbackCommit: string }> {
  const importCommit = requireSha(options.importCommit, "import commit");
  const destinationHead = requireSha(options.destinationHead, "destination head");
  const importId = checkedImportId(options.importId);
  ensureCleanDestination(options.targetDir);
  const current = currentMainHead(options.targetDir);
  if (current !== importCommit) {
    throw new AgentImportGitError("rollback_window_closed", "workspace changed after import");
  }
  git(options.targetDir, ["cat-file", "-e", `${destinationHead}^{commit}`]);
  const destinationTree = requireSha(git(options.targetDir, ["rev-parse", `${destinationHead}^{tree}`]), "rollback tree");
  const rollbackCommit = commitTree(
    options.targetDir,
    destinationTree,
    [importCommit],
    `Rollback agent import (${importId})`,
  );
  updateTarget({
    targetDir: options.targetDir,
    destinationHead: importCommit,
    nextHead: rollbackCommit,
    push: options.push !== false,
  });
  return { rollbackCommit };
}

export async function scanAgentImportSecrets(
  repoDir: string,
  options: { currentOnly?: boolean; run?: CommandRunner } = {},
): Promise<AgentImportSecretFinding[]> {
  const reportDir = fs.mkdtempSync(path.join(os.tmpdir(), "octogee-agent-import-scan-"));
  const reportPath = path.join(reportDir, "report.json");
  try {
    const args = [
      "detect",
      "--source", repoDir,
      "--redact",
      "--report-format", "json",
      "--report-path", reportPath,
      "--exit-code", "1",
      ...(options.currentOnly ? ["--no-git"] : []),
    ];
    const result = (options.run ?? defaultRun)("/usr/local/bin/gitleaks", args, {
      cwd: repoDir,
      env: buildAgentImportGitEnvironment(process.env, {
        HOME: reportDir,
      }),
    });
    if (result.error || (result.status !== 0 && result.status !== 1)) {
      throw new AgentImportGitError("secret_scan_failed", "secret scanner failed closed");
    }
    if (result.status === 0) return [];
    let raw: unknown;
    try {
      raw = JSON.parse(fs.readFileSync(reportPath, "utf8"));
    } catch {
      throw new AgentImportGitError("secret_scan_failed", "secret scanner returned no valid report");
    }
    if (!Array.isArray(raw)) {
      throw new AgentImportGitError("secret_scan_failed", "secret scanner report is invalid");
    }
    return raw.map((finding) => {
      const item = finding && typeof finding === "object" && !Array.isArray(finding)
        ? finding as Record<string, unknown>
        : {};
      if (typeof item.RuleID !== "string" || typeof item.File !== "string") {
        throw new AgentImportGitError("secret_scan_failed", "secret scanner finding is invalid");
      }
      return {
        ruleId: item.RuleID,
        path: item.File,
        commit: typeof item.Commit === "string" && item.Commit ? item.Commit : null,
      };
    });
  } finally {
    fs.rmSync(reportDir, { recursive: true, force: true });
  }
}
