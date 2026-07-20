import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { classifyAgentImportArchivePath } from "@octogee/shared/types/agent-import";
import { getExtension, getMimeType, isTextFile } from "../routes/workspace/helpers.js";

const SHA_RE = /^[0-9a-f]{40}$/;
const IMPORT_ID_RE = /^[A-Za-z0-9._-]{1,160}$/;
const MAX_COMMAND_OUTPUT = 16 * 1024 * 1024;
const MAX_TREE_METADATA_OUTPUT = 64 * 1024 * 1024;
const MAX_BINARY_BYTES = 100 * 1024 * 1024;
const MAX_IMPORT_COMMITS = 10_000;
const MAIN_REF = "refs/heads/main";
const EMPTY_REF = "0".repeat(40);

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
  options: { cwd?: string; env?: NodeJS.ProcessEnv; input?: string | Buffer },
) => CommandResult | Promise<CommandResult>;

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
    GIT_NO_REPLACE_OBJECTS: "1",
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

async function runChild(
  command: string,
  args: string[],
  options: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    input?: string | Buffer;
    maxOutput?: number;
  },
): Promise<{ status: number | null; stdout: Buffer; stderr: Buffer; error?: Error }> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? buildAgentImportGitEnvironment(),
      stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let error: Error | undefined;
    const maxOutput = options.maxOutput ?? MAX_COMMAND_OUTPUT;
    const timer = setTimeout(() => {
      error = Object.assign(new Error("command timed out"), { code: "ETIMEDOUT" });
      child.kill("SIGKILL");
    }, 120_000);
    const collect = (chunks: Buffer[], chunk: Buffer, total: number): void => {
      if (total > maxOutput) {
        error = Object.assign(new Error("command output exceeded limit"), { code: "ENOBUFS" });
        child.kill("SIGKILL");
        return;
      }
      chunks.push(chunk);
    };
    child.stdout!.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      collect(stdout, chunk, stdoutBytes);
    });
    child.stderr!.on("data", (chunk: Buffer) => {
      stderrBytes += chunk.length;
      collect(stderr, chunk, stderrBytes);
    });
    child.on("error", (spawnError) => { error = spawnError; });
    child.on("close", (status) => {
      clearTimeout(timer);
      resolve({
        status,
        stdout: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr),
        ...(error ? { error } : {}),
      });
    });
    if (options.input !== undefined) child.stdin!.end(options.input);
  });
}

async function defaultRun(
  command: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; input?: string | Buffer },
): Promise<CommandResult> {
  const result = await runChild(command, args, options);
  return {
    status: result.status,
    stdout: result.stdout.toString("utf8"),
    stderr: result.stderr.toString("utf8"),
    ...(result.error ? { error: result.error } : {}),
  };
}

function safeCommandError(label: string, result: CommandResult): AgentImportGitError {
  const diagnostic = (result.error as NodeJS.ErrnoException | undefined)?.code === "ENOENT"
    ? "command unavailable"
    : `exit ${String(result.status)}`;
  return new AgentImportGitError("git_command_failed", `${label} failed (${diagnostic})`);
}

async function command(
  executable: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; label?: string; input?: string | Buffer } = {},
): Promise<string> {
  const result = await defaultRun(executable, args, options);
  if (result.error || result.status !== 0) throw safeCommandError(options.label ?? executable, result);
  return result.stdout.trim();
}

function git(cwd: string, args: string[], env?: NodeJS.ProcessEnv, label = "git"): Promise<string> {
  return command("/usr/bin/git", args, { cwd, env, label });
}

async function readRef(cwd: string, ref: string): Promise<string | null> {
  const result = await defaultRun("/usr/bin/git", ["rev-parse", "--verify", ref], { cwd });
  if (!result.error && (result.status === 1 || result.status === 128)) return null;
  if (result.error || result.status !== 0) throw safeCommandError("git ref lookup", result);
  return requireSha(result.stdout.trim(), "git ref");
}

function requireSha(value: string, label: string): string {
  if (!SHA_RE.test(value)) throw new AgentImportGitError("invalid_git_head", `${label} is not a commit SHA`);
  return value;
}

async function trackedTree(repoDir: string, head: string, commit = head): Promise<{
  serialized: string;
  fileCount: number;
  totalBytes: number;
}> {
  const serialized = await git(repoDir, ["ls-tree", "-r", "-l", "-z", head], undefined, "git tree inspection");
  let fileCount = 0;
  let totalBytes = 0;
  for (const raw of serialized.split("\0").filter(Boolean)) {
    const tab = raw.indexOf("\t");
    if (tab < 0) throw new AgentImportGitError("invalid_git_tree", "git tree output is malformed");
    const relative = raw.slice(tab + 1);
    if (classifyAgentImportArchivePath(`workspace/${relative}`) !== "workspace") {
      throw new AgentImportGitError("unsafe_git_entry", `source history contains blocked path ${relative} at ${commit}`);
    }
    const metadata = raw.slice(0, tab).trim().split(/\s+/);
    const mode = metadata[0];
    if (mode === "120000" || mode === "160000") {
      throw new AgentImportGitError("unsafe_git_entry", `source history contains unsafe path ${relative} at ${commit}`);
    }
    if (mode !== "100644" && mode !== "100755") {
      throw new AgentImportGitError("unsafe_git_entry", `source history contains mode ${mode} at ${relative} in ${commit}`);
    }
    fileCount += 1;
    const size = Number.parseInt(metadata[3] ?? "0", 10);
    if (Number.isFinite(size)) totalBytes += size;
  }
  return { serialized, fileCount, totalBytes };
}

interface RawTreeEntry {
  mode: string;
  name: string;
  objectId: string;
}

function parseRawTree(contents: Buffer): RawTreeEntry[] {
  const entries: RawTreeEntry[] = [];
  let offset = 0;
  const decoder = new TextDecoder("utf-8", { fatal: true });
  while (offset < contents.length) {
    const space = contents.indexOf(0x20, offset);
    const nul = contents.indexOf(0, space + 1);
    if (space < 0 || nul < 0 || nul + 21 > contents.length) {
      throw new AgentImportGitError("invalid_git_tree", "git tree object is malformed");
    }
    let name: string;
    try {
      name = decoder.decode(contents.subarray(space + 1, nul));
    } catch {
      throw new AgentImportGitError("invalid_git_tree", "git tree path is not valid UTF-8");
    }
    entries.push({
      mode: contents.subarray(offset, space).toString("ascii").padStart(6, "0"),
      name,
      objectId: contents.subarray(nul + 1, nul + 21).toString("hex"),
    });
    offset = nul + 21;
  }
  return entries;
}

function parseBatchObjects(buffer: Buffer): Map<string, Buffer> {
  const objects = new Map<string, Buffer>();
  let offset = 0;
  while (offset < buffer.length) {
    const newline = buffer.indexOf(0x0a, offset);
    if (newline < 0) throw new AgentImportGitError("invalid_git_tree", "git object batch header is malformed");
    const header = buffer.subarray(offset, newline).toString("ascii").split(" ");
    const size = Number.parseInt(header[2] ?? "", 10);
    if (!SHA_RE.test(header[0] ?? "") || header[1] !== "tree" || !Number.isSafeInteger(size) || size < 0) {
      throw new AgentImportGitError("invalid_git_tree", "git object batch response is malformed");
    }
    const start = newline + 1;
    const end = start + size;
    if (end >= buffer.length || buffer[end] !== 0x0a) {
      throw new AgentImportGitError("invalid_git_tree", "git object batch payload is truncated");
    }
    objects.set(header[0]!, buffer.subarray(start, end));
    offset = end + 1;
  }
  return objects;
}

async function historyTrees(repoDir: string, head: string): Promise<Map<string, RawTreeEntry[]>> {
  const reachable = await git(repoDir, ["rev-list", "--objects", "--filter=object:type=tree", head]);
  const objectIds = [...new Set(reachable.split(/\r?\n/).flatMap((line) => {
    const id = line.split(" ", 1)[0];
    return SHA_RE.test(id) ? [id] : [];
  }))];
  const check = await command("/usr/bin/git", ["cat-file", "--batch-check"], {
    cwd: repoDir,
    input: `${objectIds.join("\n")}\n`,
    label: "git tree batch check",
  });
  const treeIds = check.split(/\r?\n/).flatMap((line) => {
    const [id, type] = line.split(" ", 3);
    return SHA_RE.test(id) && type === "tree" ? [id] : [];
  });
  const batch = await runChild("/usr/bin/git", ["cat-file", "--batch"], {
    cwd: repoDir,
    input: `${treeIds.join("\n")}\n`,
    maxOutput: MAX_TREE_METADATA_OUTPUT,
  });
  if (batch.error || batch.status !== 0) {
    throw safeCommandError("git tree batch", {
      status: batch.status,
      stdout: "",
      stderr: batch.stderr.toString("utf8"),
      ...(batch.error ? { error: batch.error } : {}),
    });
  }
  return new Map([...parseBatchObjects(batch.stdout)].map(([id, contents]) => [id, parseRawTree(contents)]));
}

async function assertSafeHistoryTrees(repoDir: string, head: string): Promise<void> {
  const commits = (await git(repoDir, ["log", "--format=%H%x09%T", head])).split(/\r?\n/).map((line) => {
    const [commit, tree] = line.split("\t", 2);
    return { commit: requireSha(commit, "history commit"), tree: requireSha(tree, "history tree") };
  });
  const trees = await historyTrees(repoDir, head);
  const checked = new Set<string>();
  for (const { commit, tree } of commits) {
    const stack = [{ objectId: tree, prefix: "" }];
    while (stack.length > 0) {
      const current = stack.pop()!;
      const cacheKey = `${current.objectId}\0${current.prefix}`;
      if (checked.has(cacheKey)) continue;
      checked.add(cacheKey);
      const entries = trees.get(current.objectId);
      if (!entries) throw new AgentImportGitError("invalid_git_tree", "reachable git tree object is missing");
      for (const entry of entries) {
        const relative = current.prefix ? `${current.prefix}/${entry.name}` : entry.name;
        if (entry.mode === "040000") {
          stack.push({ objectId: entry.objectId, prefix: relative });
          continue;
        }
        if (classifyAgentImportArchivePath(`workspace/${relative}`) !== "workspace") {
          throw new AgentImportGitError("unsafe_git_entry", `source history contains blocked path ${relative} at ${commit}`);
        }
        if (entry.mode === "120000" || entry.mode === "160000") {
          throw new AgentImportGitError("unsafe_git_entry", `source history contains unsafe path ${relative} at ${commit}`);
        }
        if (entry.mode !== "100644" && entry.mode !== "100755") {
          throw new AgentImportGitError("unsafe_git_entry", `source history contains mode ${entry.mode} at ${relative} in ${commit}`);
        }
      }
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
  await git(repoDir, ["fsck", "--strict", "--no-dangling"], undefined, "git fsck");
  const head = requireSha(options.head ?? await git(repoDir, ["rev-parse", "HEAD"]), "source head");
  await git(repoDir, ["cat-file", "-e", `${head}^{commit}`], undefined, "source commit lookup");
  const tree = await trackedTree(repoDir, head);
  const commitCount = Number.parseInt(await git(repoDir, ["rev-list", "--count", head]), 10);
  if (!Number.isFinite(commitCount) || commitCount < 1) {
    throw new AgentImportGitError("invalid_git_history", "source history has no reachable commit");
  }
  if (commitCount > MAX_IMPORT_COMMITS) {
    throw new AgentImportGitError("invalid_git_history", `source history exceeds ${MAX_IMPORT_COMMITS} commits`);
  }
  await assertSafeHistoryTrees(repoDir, head);
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

async function commitTree(
  repoDir: string,
  tree: string,
  parents: string[],
  message: string,
): Promise<string> {
  const env = buildAgentImportGitEnvironment(process.env, {
    GIT_AUTHOR_NAME: "Octogee Agent Import",
    GIT_AUTHOR_EMAIL: "agent-import@octogee.invalid",
    GIT_COMMITTER_NAME: "Octogee Agent Import",
    GIT_COMMITTER_EMAIL: "agent-import@octogee.invalid",
  });
  return requireSha(await command(
    "/usr/bin/git",
    ["commit-tree", tree, ...parents.flatMap((parent) => ["-p", parent])],
    { cwd: repoDir, env, input: `${message}\n`, label: "git commit-tree" },
  ), "created commit");
}

function checkedImportId(importId: string): string {
  if (!IMPORT_ID_RE.test(importId)) throw new AgentImportGitError("invalid_import_id", "import id is invalid");
  return importId;
}

async function currentMainHead(targetDir: string): Promise<string> {
  const branch = await git(targetDir, ["symbolic-ref", "--short", "HEAD"]);
  if (branch !== "main") throw new AgentImportGitError("destination_branch", "destination workspace must be on main");
  return requireSha(await git(targetDir, ["rev-parse", "HEAD"]), "destination head");
}

async function ensureCleanDestination(targetDir: string): Promise<void> {
  if (await git(targetDir, ["status", "--porcelain", "--untracked-files=all"])) {
    throw new AgentImportGitError("destination_dirty", "destination workspace has uncommitted changes");
  }
}

interface PublishedRef {
  ref: string;
  expected: string;
}

interface TargetUpdate {
  targetDir: string;
  destinationHead: string;
  nextHead: string;
  sourceHead?: string;
  sourceRef?: string;
  importRef?: string;
  rollbackRef?: string;
  push: boolean;
}

async function remoteRefsMatch(targetDir: string, refs: PublishedRef[]): Promise<boolean> {
  const output = await git(
    targetDir,
    ["ls-remote", "--refs", "origin", ...refs.map(({ ref }) => ref)],
    undefined,
    "Gitea ref verification",
  );
  const remote = new Map(output.split(/\r?\n/).filter(Boolean).map((line) => {
    const [head, ref] = line.split("\t", 2);
    return [ref, head];
  }));
  return refs.every(({ ref, expected }) => remote.get(ref) === expected);
}

async function publishRefs(targetDir: string, refs: PublishedRef[]): Promise<void> {
  try {
    await git(
      targetDir,
      ["push", "--atomic", "origin", ...refs.map(({ ref }) => `${ref}:${ref}`)],
      undefined,
      "Gitea push",
    );
  } catch (error) {
    try {
      if (await remoteRefsMatch(targetDir, refs)) return;
    } catch {
      throw new AgentImportGitError(
        "push_outcome_unknown",
        "Gitea push outcome could not be verified; retry the same import",
      );
    }
    throw error;
  }
}

function targetRefs(options: TargetUpdate): PublishedRef[] {
  const refs: PublishedRef[] = [{ ref: MAIN_REF, expected: options.nextHead }];
  if (options.sourceHead && options.sourceRef) refs.push({ ref: options.sourceRef, expected: options.sourceHead });
  if (options.importRef) refs.push({ ref: options.importRef, expected: options.nextHead });
  if (options.rollbackRef) refs.push({ ref: options.rollbackRef, expected: options.nextHead });
  return refs;
}

async function restoreTarget(options: TargetUpdate, refs: PublishedRef[]): Promise<void> {
  await git(options.targetDir, ["update-ref", MAIN_REF, options.destinationHead, options.nextHead]);
  await git(options.targetDir, ["reset", "--hard", options.destinationHead]);
  for (const { ref, expected } of refs.slice(1)) {
    await git(options.targetDir, ["update-ref", "-d", ref, expected]);
  }
}

async function updateTarget(options: TargetUpdate): Promise<void> {
  const refs = targetRefs(options);
  await git(options.targetDir, ["update-ref", MAIN_REF, options.nextHead, options.destinationHead]);
  try {
    for (const { ref, expected } of refs.slice(1)) {
      await git(options.targetDir, ["update-ref", ref, expected, EMPTY_REF]);
    }
    await git(options.targetDir, ["reset", "--hard", options.nextHead]);
    if (options.push) await publishRefs(options.targetDir, refs);
  } catch (error) {
    if (error instanceof AgentImportGitError && error.code === "push_outcome_unknown") throw error;
    try {
      await restoreTarget(options, refs);
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
  cleanupBlobs: () => Promise<void>;
  push?: boolean;
}): Promise<{ importCommit: string; sourceRef: string }> {
  const sourceHead = requireSha(options.sourceHead, "source head");
  const destinationHead = requireSha(options.destinationHead, "destination head");
  const importId = checkedImportId(options.importId);
  const sourceRef = `refs/octogee/imports/${importId}/source`;
  const importRef = `refs/octogee/imports/${importId}/commit`;
  await ensureCleanDestination(options.targetDir);
  if (requireSha(await git(options.sourceDir, ["rev-parse", "HEAD"]), "source head") !== sourceHead) {
    throw new AgentImportGitError("source_changed", "source workspace changed after preview");
  }
  await trackedTree(options.sourceDir, sourceHead);
  const currentHead = await currentMainHead(options.targetDir);
  if (currentHead !== destinationHead) {
    const parents = (await git(options.targetDir, ["rev-list", "--parents", "-n", "1", currentHead])).split(" ");
    const subject = await git(options.targetDir, ["show", "-s", "--format=%s", currentHead]);
    if (
      await readRef(options.targetDir, sourceRef) === sourceHead &&
      await readRef(options.targetDir, importRef) === currentHead &&
      parents.length === 3 &&
      parents[1] === destinationHead &&
      parents[2] === sourceHead &&
      subject === `Import agent workspace (${importId})`
    ) {
      if (options.push !== false) {
        await publishRefs(options.targetDir, [
          { ref: MAIN_REF, expected: currentHead },
          { ref: sourceRef, expected: sourceHead },
          { ref: importRef, expected: currentHead },
        ]);
      }
      return { importCommit: currentHead, sourceRef };
    }
    throw new AgentImportGitError("destination_changed", "destination workspace changed after preview");
  }
  const stageRoot = fs.mkdtempSync(path.join(os.tmpdir(), "octogee-agent-import-apply-"));
  const stageDir = path.join(stageRoot, "source");
  let retainBlobs = false;
  try {
    await command("/usr/bin/git", ["clone", "--quiet", "--no-hardlinks", options.sourceDir, stageDir], { label: "source staging clone" });
    clearWorkingTree(stageDir);
    readDirectory(options.sourceDir, stageDir);
    preserveTargetPath(options.targetDir, stageDir, ".files");
    preserveTargetPath(options.targetDir, stageDir, "projects");
    mergeGitignore(options.targetDir, stageDir);
    await normalizeBinaryTip({ stageDir, targetDir: options.targetDir, storeBlob: options.storeBlob });
    await git(stageDir, ["add", "-A", "--", "."]);
    const tree = requireSha(await git(stageDir, ["write-tree"]), "import tree");
    await git(stageDir, ["fetch", "--quiet", "--no-tags", options.targetDir, destinationHead]);
    const importCommit = await commitTree(
      stageDir,
      tree,
      [destinationHead, sourceHead],
      `Import agent workspace (${importId})`,
    );
    await git(options.targetDir, ["fetch", "--quiet", "--no-tags", stageDir, importCommit]);
    await updateTarget({
      targetDir: options.targetDir,
      destinationHead,
      nextHead: importCommit,
      sourceHead,
      sourceRef,
      importRef,
      push: options.push !== false,
    });
    retainBlobs = true;
    return { importCommit, sourceRef };
  } catch (error) {
    if (error instanceof AgentImportGitError && error.code === "push_outcome_unknown") retainBlobs = true;
    if (!retainBlobs) {
      try {
        await options.cleanupBlobs();
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], "agent import failed and blob cleanup also failed", {
          cause: error,
        });
      }
    }
    throw error;
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
  const rollbackRef = `refs/octogee/imports/${importId}/rollback`;
  await ensureCleanDestination(options.targetDir);
  const current = await currentMainHead(options.targetDir);
  if (current !== importCommit) {
    const parents = (await git(options.targetDir, ["rev-list", "--parents", "-n", "1", current])).split(" ");
    const subject = await git(options.targetDir, ["show", "-s", "--format=%s", current]);
    const currentTree = requireSha(await git(options.targetDir, ["rev-parse", `${current}^{tree}`]), "rollback tree");
    const destinationTree = requireSha(await git(options.targetDir, ["rev-parse", `${destinationHead}^{tree}`]), "destination tree");
    if (
      await readRef(options.targetDir, rollbackRef) === current &&
      parents.length === 2 &&
      parents[1] === importCommit &&
      subject === `Rollback agent import (${importId})` &&
      currentTree === destinationTree
    ) {
      if (options.push !== false) {
        await publishRefs(options.targetDir, [
          { ref: MAIN_REF, expected: current },
          { ref: rollbackRef, expected: current },
        ]);
      }
      return { rollbackCommit: current };
    }
    throw new AgentImportGitError("rollback_window_closed", "workspace changed after import");
  }
  await git(options.targetDir, ["cat-file", "-e", `${destinationHead}^{commit}`]);
  const destinationTree = requireSha(await git(options.targetDir, ["rev-parse", `${destinationHead}^{tree}`]), "rollback tree");
  const rollbackCommit = await commitTree(
    options.targetDir,
    destinationTree,
    [importCommit],
    `Rollback agent import (${importId})`,
  );
  await updateTarget({
    targetDir: options.targetDir,
    destinationHead: importCommit,
    nextHead: rollbackCommit,
    rollbackRef,
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
    const result = await (options.run ?? defaultRun)("/usr/local/bin/gitleaks", args, {
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
