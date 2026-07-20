import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import JSZip from "jszip";

import {
  AGENT_IMPORT_FORMAT_VERSION,
  classifyAgentImportArchivePath,
  validateAgentImportConfigArtifacts,
  type AgentImportConfigArtifacts,
} from "@octogee/shared/types/agent-import";

const OWNER_RE = /^[A-Za-z0-9-]{1,39}$/;
const REPO_RE = /^[A-Za-z0-9._-]{1,100}$/;
const SHA_RE = /^[0-9a-f]{40}$/;
const MAX_ARCHIVE_BYTES = 250 * 1024 * 1024;
const MAX_UNPACKED_BYTES = 1024 * 1024 * 1024;
const MAX_ENTRY_BYTES = 100 * 1024 * 1024;
const MAX_ENTRIES = 25_000;

export interface LocalAgentImportManifest {
  formatVersion: typeof AGENT_IMPORT_FORMAT_VERSION;
  sourceAgentId: string;
  hadGit: boolean;
  uncommittedFileCount: number;
}

export interface ExtractedAgentImportSource {
  repoDir: string;
  sourceHead: string;
  artifacts: AgentImportConfigArtifacts;
  manifest: LocalAgentImportManifest;
  cleanup(): void;
}

export interface ClonedGithubAgentImportSource {
  repoDir: string;
  sourceHead: string;
  cleanup(): void;
}

export class AgentImportSourceError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "AgentImportSourceError";
  }
}

function sourceGitEnvironment(
  source: NodeJS.ProcessEnv = process.env,
  extra: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv {
  return {
    PATH: "/usr/local/bin:/usr/bin:/bin",
    LANG: source.LANG ?? "C.UTF-8",
    LC_ALL: source.LC_ALL ?? "C.UTF-8",
    HOME: "/tmp",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
    ...extra,
  };
}

function runGit(cwd: string, args: string[], env: NodeJS.ProcessEnv = sourceGitEnvironment()): string {
  const result = spawnSync("/usr/bin/git", args, {
    cwd,
    env,
    encoding: "utf8",
    timeout: 120_000,
    maxBuffer: 16 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error || result.status !== 0) {
    throw new AgentImportSourceError("git_source_invalid", `source git operation failed (exit ${String(result.status)})`);
  }
  return (result.stdout ?? "").trim();
}

function validBranch(branch: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._/-]{0,249}$/.test(branch) &&
    !branch.includes("..") && !branch.includes("@{") && !branch.endsWith("/") &&
    !branch.endsWith(".") && !branch.endsWith(".lock");
}

export function githubAgentImportCloneUrl(owner: string, repo: string): string {
  if (!OWNER_RE.test(owner) || !REPO_RE.test(repo) || repo.startsWith("-")) {
    throw new AgentImportSourceError("invalid_github_source", "GitHub owner or repository is invalid");
  }
  return `https://github.com/${owner}/${repo}.git`;
}

export function githubAgentImportCloneEnvironment(
  token: string,
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  if (!token || /[\r\n]/.test(token)) {
    throw new AgentImportSourceError("invalid_github_token", "GitHub OAuth token is invalid");
  }
  return sourceGitEnvironment(source, {
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
    GIT_CONFIG_VALUE_0: `Authorization: Bearer ${token}`,
  });
}

export function cloneGithubAgentImportSource(options: {
  owner: string;
  repo: string;
  branch: string;
  token: string;
  tmpRoot?: string;
}): ClonedGithubAgentImportSource {
  if (!validBranch(options.branch)) {
    throw new AgentImportSourceError("invalid_github_source", "GitHub branch is invalid");
  }
  const root = fs.mkdtempSync(path.join(options.tmpRoot ?? os.tmpdir(), "octogee-agent-import-github-"));
  const repoDir = path.join(root, "source");
  try {
    const result = spawnSync("/usr/bin/git", [
      "clone", "--quiet", "--single-branch", "--no-tags", "--branch", options.branch,
      githubAgentImportCloneUrl(options.owner, options.repo), repoDir,
    ], {
      env: githubAgentImportCloneEnvironment(options.token),
      encoding: "utf8",
      timeout: 120_000,
      maxBuffer: 16 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (result.error || result.status !== 0) {
      throw new AgentImportSourceError("github_clone_failed", "GitHub repository could not be cloned");
    }
    const sourceHead = runGit(repoDir, ["rev-parse", "HEAD"]);
    if (!SHA_RE.test(sourceHead)) throw new AgentImportSourceError("git_source_invalid", "GitHub source has no commit");
    return {
      repoDir,
      sourceHead,
      cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
    };
  } catch (error) {
    fs.rmSync(root, { recursive: true, force: true });
    throw error;
  }
}

function jsonObject(buffer: Buffer, label: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(buffer.toString("utf8"));
  } catch {
    throw new AgentImportSourceError("invalid_archive_metadata", `${label} must contain a JSON object`);
  }
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    return parsed as Record<string, unknown>;
  }
  throw new AgentImportSourceError("invalid_archive_metadata", `${label} must contain a JSON object`);
}

function localManifest(value: unknown): LocalAgentImportManifest {
  const manifest = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  if (
    Object.keys(manifest).some((key) => ![
      "formatVersion", "sourceAgentId", "hadGit", "uncommittedFileCount",
    ].includes(key)) ||
    manifest.formatVersion !== AGENT_IMPORT_FORMAT_VERSION ||
    typeof manifest.sourceAgentId !== "string" || !manifest.sourceAgentId || manifest.sourceAgentId.length > 160 ||
    typeof manifest.hadGit !== "boolean" ||
    typeof manifest.uncommittedFileCount !== "number" ||
    !Number.isInteger(manifest.uncommittedFileCount) || manifest.uncommittedFileCount < 0
  ) {
    throw new AgentImportSourceError("invalid_archive_metadata", "manifest.json is invalid");
  }
  return manifest as unknown as LocalAgentImportManifest;
}

function zipEntryIsSymlink(entry: JSZip.JSZipObject): boolean {
  const permissions = typeof entry.unixPermissions === "number" ? entry.unixPermissions : 0;
  return (permissions & 0o170000) === 0o120000;
}

async function validatedArchiveEntries(
  buffer: Buffer,
  limits: { maxEntryBytes: number; maxUnpackedBytes: number },
): Promise<Map<string, Buffer>> {
  if (buffer.length > MAX_ARCHIVE_BYTES) {
    throw new AgentImportSourceError("archive_too_large", "agent import archive exceeds 250 MiB");
  }
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(buffer, { checkCRC32: true });
  } catch {
    throw new AgentImportSourceError("invalid_archive", "agent import archive is not a valid ZIP");
  }
  const files = Object.values(zip.files).filter((entry) => !entry.dir);
  if (files.length > MAX_ENTRIES) {
    throw new AgentImportSourceError("archive_too_large", "agent import archive has too many entries");
  }
  const result = new Map<string, Buffer>();
  let total = 0;
  for (const entry of files) {
    if (!classifyAgentImportArchivePath(entry.name) || zipEntryIsSymlink(entry)) {
      throw new AgentImportSourceError("unsafe_archive_entry", `archive entry is not allowed: ${entry.name}`);
    }
    const declaredSize = (entry as unknown as { _data?: { uncompressedSize?: unknown } })._data?.uncompressedSize;
    if (typeof declaredSize !== "number" || !Number.isSafeInteger(declaredSize) || declaredSize < 0) {
      throw new AgentImportSourceError("invalid_archive", "agent import archive has invalid size metadata");
    }
    if (declaredSize > limits.maxEntryBytes || total + declaredSize > limits.maxUnpackedBytes) {
      throw new AgentImportSourceError("archive_too_large", `archive entry exceeds its expansion limit: ${entry.name}`);
    }
    const contents = await entry.async("nodebuffer");
    if (contents.length > limits.maxEntryBytes) {
      throw new AgentImportSourceError("archive_too_large", `archive entry exceeds 100 MiB: ${entry.name}`);
    }
    total += contents.length;
    if (total > limits.maxUnpackedBytes) {
      throw new AgentImportSourceError("archive_too_large", "agent import archive exceeds 1 GiB unpacked");
    }
    result.set(entry.name, contents);
  }
  return result;
}

function requireMetadata(entries: Map<string, Buffer>, pathName: string): Buffer {
  const value = entries.get(pathName);
  if (!value) throw new AgentImportSourceError("invalid_archive_metadata", `${pathName} is required`);
  return value;
}

function writeEntry(root: string, relative: string, contents: Buffer): void {
  const destination = path.resolve(root, relative);
  const rootPrefix = `${path.resolve(root)}${path.sep}`;
  if (!destination.startsWith(rootPrefix)) {
    throw new AgentImportSourceError("unsafe_archive_entry", "archive path escapes its destination");
  }
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, contents, { mode: 0o600 });
}

function clearRepoWorktree(repoDir: string): void {
  for (const entry of fs.readdirSync(repoDir)) {
    if (entry !== ".git") fs.rmSync(path.join(repoDir, entry), { recursive: true, force: true });
  }
}

function commitCurrentTip(repoDir: string, message: string): string {
  runGit(repoDir, ["add", "--all", "--force", "--", "."]);
  const status = runGit(repoDir, ["status", "--porcelain", "--untracked-files=all"]);
  if (status) {
    const env = sourceGitEnvironment(process.env, {
      GIT_AUTHOR_NAME: "Octogee Agent Import",
      GIT_AUTHOR_EMAIL: "agent-import@octogee.invalid",
      GIT_COMMITTER_NAME: "Octogee Agent Import",
      GIT_COMMITTER_EMAIL: "agent-import@octogee.invalid",
    });
    runGit(repoDir, ["commit", "--quiet", "-m", message], env);
  }
  const head = runGit(repoDir, ["rev-parse", "HEAD"]);
  if (!SHA_RE.test(head)) throw new AgentImportSourceError("git_source_invalid", "local source has no commit");
  return head;
}

export async function extractLocalAgentImportArchive(
  buffer: Buffer,
  options: { tmpRoot?: string; maxEntryBytes?: number; maxUnpackedBytes?: number } = {},
): Promise<ExtractedAgentImportSource> {
  const entries = await validatedArchiveEntries(buffer, {
    maxEntryBytes: options.maxEntryBytes ?? MAX_ENTRY_BYTES,
    maxUnpackedBytes: options.maxUnpackedBytes ?? MAX_UNPACKED_BYTES,
  });
  const manifest = localManifest(jsonObject(requireMetadata(entries, "manifest.json"), "manifest.json"));
  const artifacts = validateAgentImportConfigArtifacts({
    formatVersion: AGENT_IMPORT_FORMAT_VERSION,
    portableAgent: jsonObject(requireMetadata(entries, "portable-agent.json"), "portable-agent.json"),
    configInventory: (() => {
      try {
        return JSON.parse(requireMetadata(entries, "config-inventory.json").toString("utf8"));
      } catch {
        throw new AgentImportSourceError("invalid_archive_metadata", "config-inventory.json is invalid");
      }
    })(),
    doctorCandidate: jsonObject(requireMetadata(entries, "doctor-candidate.json"), "doctor-candidate.json"),
  });
  if (artifacts.portableAgent.sourceAgentId !== manifest.sourceAgentId) {
    throw new AgentImportSourceError("invalid_archive_metadata", "manifest source agent does not match config artifacts");
  }
  const root = fs.mkdtempSync(path.join(options.tmpRoot ?? os.tmpdir(), "octogee-agent-import-local-"));
  const repoDir = path.join(root, "source");
  fs.mkdirSync(repoDir, { recursive: true, mode: 0o700 });
  try {
    const gitEntries = [...entries.entries()].filter(([entry]) => entry.startsWith("git/"));
    if (manifest.hadGit !== (gitEntries.length > 0)) {
      throw new AgentImportSourceError("invalid_archive_metadata", "manifest Git flag does not match archive contents");
    }
    if (manifest.hadGit) {
      for (const [entry, contents] of gitEntries) {
        writeEntry(path.join(repoDir, ".git"), entry.slice("git/".length), contents);
      }
      runGit(repoDir, ["fsck", "--strict", "--no-dangling"]);
      const committedHead = runGit(repoDir, ["rev-parse", "HEAD"]);
      if (!SHA_RE.test(committedHead)) throw new AgentImportSourceError("git_source_invalid", "local Git HEAD is invalid");
      runGit(repoDir, ["reset", "--hard", committedHead]);
      clearRepoWorktree(repoDir);
    } else {
      runGit(repoDir, ["init", "--quiet", "--initial-branch", "main"]);
    }
    for (const [entry, contents] of entries) {
      if (!entry.startsWith("workspace/")) continue;
      writeEntry(repoDir, entry.slice("workspace/".length), contents);
    }
    const sourceHead = commitCurrentTip(
      repoDir,
      manifest.hadGit ? "Capture imported local workspace changes" : "Import local agent workspace",
    );
    return {
      repoDir,
      sourceHead,
      artifacts,
      manifest,
      cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
    };
  } catch (error) {
    fs.rmSync(root, { recursive: true, force: true });
    throw error;
  }
}
