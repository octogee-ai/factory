import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { isValidProjectId, isValidUsername } from "@octogee/shared/types/identity";
import { PROJECT_AGENT_REPO, PROJECT_AGENT_WORKSPACE_PARTS } from "@octogee/shared/types/project";
import { GIT_SSH_HOST } from "./config.js";
import { workspaceGiteaOrg } from "./gitea-naming.js";
import { withPinnedDirectory } from "./pinned-directory.js";

const run = promisify(execFile);
const INSTRUCTIONS_FILE = "AGENTS.md";
const IDENTITY_FILE = "IDENTITY.md";
const PROJECT_AGENT_FILES = [INSTRUCTIONS_FILE, IDENTITY_FILE, "SOUL.md", "USER.md", "TOOLS.md", "HEARTBEAT.md", "BOOTSTRAP.md", "BRIEF.md", "MEMORY.md"];
const RESTORE_LAST = new Set([INSTRUCTIONS_FILE, IDENTITY_FILE]);
const MAX_FILE_BYTES = 4 * 1024 ** 2;
const MAX_WORKSPACE_BYTES = 64 * 1024 ** 2;
const MEMORY_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*\.md$/u;
const snapshotsSaved = new Map<string, string>();

export function projectAgentWorkspace(customerDir: string, project: string): string {
  if (!isValidProjectId(project)) throw new Error("Invalid project agent workspace");
  return path.join(customerDir, ...PROJECT_AGENT_WORKSPACE_PARTS, project);
}

interface ProjectAgentWorkspaceSync {
  customerDir: string;
  slug: string;
  projects: readonly string[];
  checkpointEpoch?: number;
  assertCurrent?: () => Promise<void>;
}

interface GitTransport { remote: string; ssh: string }
type FileSnapshot = Map<string, Buffer>;

function missing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

async function readManagedFile(filename: string): Promise<Buffer | null> {
  let handle;
  try { handle = await fs.open(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) {
    if (missing(error)) return null;
    throw error;
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > MAX_FILE_BYTES) throw new Error(`Unsafe project agent file: ${path.basename(filename)}`);
    const bytes = Buffer.alloc(stat.size + 1);
    const { bytesRead } = await handle.read(bytes);
    const after = await handle.stat();
    if (bytesRead !== stat.size || stat.mtimeMs !== after.mtimeMs || stat.ctimeMs !== after.ctimeMs) {
      throw new Error(`Project agent file changed: ${path.basename(filename)}`);
    }
    return bytes.subarray(0, bytesRead);
  } finally { await handle.close(); }
}

async function readSnapshot(root: string, parts: readonly string[]): Promise<FileSnapshot> {
  const snapshot: FileSnapshot = new Map();
  let bytes = 0;
  const read = async (dir: string, files: string[], prefix = "") => {
    for (const file of files) {
      const content = await readManagedFile(path.join(dir, file));
      if (!content) continue;
      bytes += content.byteLength;
      if (bytes > MAX_WORKSPACE_BYTES) throw new Error("Project agent workspace exceeds its save limit");
      snapshot.set(prefix + file, content);
    }
  };
  try {
    await withPinnedDirectory(root, parts, async dir => {
      await read(dir, PROJECT_AGENT_FILES);
      try {
        await withPinnedDirectory(root, [...parts, "memory"], async memory => {
          await read(memory, (await fs.readdir(memory)).filter(name => MEMORY_NAME.test(name)).sort(), "memory/");
        });
      } catch (error) { if (!missing(error)) throw error; }
    });
  } catch (error) { if (!missing(error)) throw error; }
  return snapshot;
}

async function writeSnapshot(root: string, parts: readonly string[], snapshot: FileSnapshot, prior: FileSnapshot, restore: boolean): Promise<void> {
  const names = new Set([...snapshot.keys(), ...prior.keys()]);
  const write = async (dir: string, name: string, key: string) => {
    const bytes = snapshot.get(key);
    const before = prior.get(key);
    if ((restore && before) || (bytes && before?.equals(bytes))) return;
    const filename = path.join(dir, name);
    if (!bytes) {
      await fs.unlink(filename);
      return;
    }
    if (!restore) {
      await fs.writeFile(filename, bytes, { flag: constants.O_NOFOLLOW | constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC, mode: 0o600 });
      return;
    }
    const temp = path.join(dir, `.restore-${randomUUID()}`);
    try {
      await fs.writeFile(temp, bytes, { flag: "wx", mode: 0o600 });
      await fs.link(temp, filename);
    } finally { await fs.rm(temp, { force: true }); }
  };
  await withPinnedDirectory(root, parts, async dir => {
    for (const name of names) {
      if (!name.startsWith("memory/") && !(restore && RESTORE_LAST.has(name))) await write(dir, name, name);
    }
  }, true);
  const memory = [...names].filter(name => name.startsWith("memory/"));
  if (memory.length > 0) {
    await withPinnedDirectory(root, [...parts, "memory"], async dir => {
      for (const name of memory) await write(dir, path.basename(name), name);
    }, true);
  }
  if (restore) {
    await withPinnedDirectory(root, parts, async dir => {
      for (const name of RESTORE_LAST) if (snapshot.has(name)) await write(dir, name, name);
    });
  }
}

export function projectAgentRepoTransport({ slug, customerDir }: Pick<ProjectAgentWorkspaceSync, "slug" | "customerDir">): GitTransport {
  const key = path.resolve(customerDir, "..", "..", "customer-keys", slug, "id_ed25519");
  if (/["`$\\]/u.test(key)) throw new Error("Invalid project agent Git transport");
  return {
    remote: `git@${GIT_SSH_HOST}:${workspaceGiteaOrg(slug)}/${PROJECT_AGENT_REPO}.git`,
    ssh: `/usr/bin/ssh -i "${key}" -F /home/node/.ssh/config -o IdentitiesOnly=yes -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR`,
  };
}

function validateInput(input: ProjectAgentWorkspaceSync): void {
  if (!isValidUsername(input.slug) || path.basename(input.customerDir) !== input.slug ||
      !input.projects.every(isValidProjectId) || new Set(input.projects).size !== input.projects.length) {
    throw new Error("Invalid project agent workspace scope");
  }
}

async function withProjectAgentRepo<T>(input: ProjectAgentWorkspaceSync, use: (checkout: string, git: (args: string[]) => Promise<string>) => Promise<T>, transport = projectAgentRepoTransport(input)): Promise<T> {
  const staging = await fs.mkdtemp(path.join(await fs.realpath(tmpdir()), "octogee-project-coaches-"));
  const checkout = path.join(staging, "checkout");
  const env = {
    PATH: process.env.PATH, HOME: process.env.HOME,
    GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0",
    GIT_SSH_COMMAND: transport.ssh,
  };
  const git = async (args: string[], cwd = checkout) => (await run("/usr/bin/git", [
    "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false",
    "-c", "protocol.ext.allow=never", ...args,
  ], { cwd, env, timeout: 30_000 })).stdout;
  try {
    await git(["init", "--initial-branch=main", checkout], staging);
    await git(["remote", "add", "origin", transport.remote]);
    const remoteMain = await git(["ls-remote", "--heads", "origin", "refs/heads/main"]);
    if (remoteMain.trim()) {
      await git(["fetch", "--no-tags", "origin", "refs/heads/main"]);
      await git(["reset", "--hard", "FETCH_HEAD"]);
    }
    return await use(checkout, git);
  } finally { await fs.rm(staging, { recursive: true, force: true }); }
}

function workspaceParts(project: string): string[] {
  return [...PROJECT_AGENT_WORKSPACE_PARTS, project];
}

export async function initializeRelocatedProjectAgent(input: { customerDir: string; project: string; name: string; emoji: string }): Promise<void> {
  if (!isValidProjectId(input.project)) throw new Error("Invalid project agent workspace");
  const parts = workspaceParts(input.project);
  const local = await readSnapshot(input.customerDir, parts);
  if (local.has(INSTRUCTIONS_FILE) && local.has(IDENTITY_FILE)) return;
  const line = (value: string) => value.replace(/[\r\n]/gu, " ").trim();
  await writeSnapshot(input.customerDir, parts, new Map([
    [INSTRUCTIONS_FILE, Buffer.from("# Project agent\n\nKeep your agent files and memory in this private workspace. Use the connected repository, when available, for source code and its own instructions.\n")],
    [IDENTITY_FILE, Buffer.from(`# IDENTITY.md\n\n- Name: ${line(input.name)}\n- Emoji: ${line(input.emoji)}\n`)],
  ]), local, true);
}

export async function restoreProjectAgentWorkspaces(input: ProjectAgentWorkspaceSync, transport?: GitTransport): Promise<void> {
  validateInput(input);
  const missing = new Map<string, FileSnapshot>();
  for (const project of input.projects) {
    const local = await readSnapshot(input.customerDir, workspaceParts(project));
    if (!local.has(INSTRUCTIONS_FILE) || !local.has(IDENTITY_FILE)) missing.set(project, local);
  }
  if (missing.size === 0) return;
  await withProjectAgentRepo(input, async checkout => {
    for (const [project, local] of missing) {
      await input.assertCurrent?.();
      const remote = await readSnapshot(checkout, [project]);
      if (remote.size === 0) continue;
      await writeSnapshot(input.customerDir, workspaceParts(project), remote, local, true);
    }
  }, transport);
}

export async function saveProjectAgentWorkspaces(input: ProjectAgentWorkspaceSync, transport?: GitTransport): Promise<void> {
  validateInput(input);
  if (input.projects.length === 0) return;
  const locals = new Map<string, FileSnapshot>();
  const hash = createHash("sha256").update(JSON.stringify(input.checkpointEpoch ?? null));
  for (const project of input.projects) {
    const files = await readSnapshot(input.customerDir, workspaceParts(project));
    if (files.size === 0) throw new Error(`Project agent workspace has no durable files: ${project}`);
    locals.set(project, files);
    hash.update(JSON.stringify([project, [...files].map(([name, data]) => [name, createHash("sha256").update(data).digest("hex")])]));
  }
  const fingerprint = hash.digest("hex");
  if (snapshotsSaved.get(input.customerDir) === fingerprint) return;
  await withProjectAgentRepo(input, async (checkout, git) => {
    for (const [project, files] of locals) {
      await input.assertCurrent?.();
      await writeSnapshot(checkout, [project], files, await readSnapshot(checkout, [project]), false);
    }
    if (!(await git(["status", "--porcelain"])).trim()) return;
    await git(["add", "-A", "--", ...input.projects]);
    await git(["-c", "user.name=Octogee autosave", "-c", `user.email=${input.slug}@octogee.com`, "commit", "-m", "autosave: project agent workspace"]);
    await input.assertCurrent?.();
    await git(["push", "origin", "refs/heads/main:refs/heads/main"]);
    await input.assertCurrent?.();
  }, transport);
  if (snapshotsSaved.size >= 4096) snapshotsSaved.clear();
  snapshotsSaved.set(input.customerDir, fingerprint);
}
