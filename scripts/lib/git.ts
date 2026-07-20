// All fs.* call sites here take paths rooted at CUSTOMERS_DIR/<slug>
// or CUSTOMER_KEYS_DIR/<slug>. Slugs reach this module already
// validated by isValidUsername() at the only entry point that produces
// a slug from user input — buildProvisioningContext in
// scripts/lib/provisionSteps.ts. The remaining slug sources here are
// either operator-supplied (deleteCustomerSshKey, archive*) which the
// operator owns, or on-disk listings of already-provisioned customer
// directories (syncAllWorkspaces). isValidUsername() at that entry point
// is the path-traversal defense.
//
// Gitea ADMIN operations (create user, register the SSH key, create
// orgs/repos, repo-exists, archive) are NOT performed here. The provisioner
// runs in the shell-bearing openclaw container, which holds no Gitea admin
// token; those calls go through the no-shell gateway-edge sidecar via
// gitea-admin-broker-client (PLATFORM-CREDENTIAL-BROKERING). What stays here
// is local git on the per-customer SSH key — clone/init/commit/push.
import { execFileSync, execSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import {
  log, dlog, GIT_API_URL, GIT_SSH_HOST,
  CUSTOMERS_DIR, CUSTOMER_KEYS_DIR,
} from "./config.js";
import {
  workspaceGiteaOrg, workspaceRepoName, projectRepoName,
} from "./gitea-naming.js";
import * as giteaBroker from "./gitea-admin-broker-client.js";
import { notesWelcomeSeed } from "@octogee/core/templates/project-seeds";
import { acquireWorkspaceMutationLeaseSync } from "@octogee/core/workspace-mutation-lease";
import { pubKeysMatch } from "@octogee/core/customer-lifecycle";

export function errMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

export function execErrStderr(err: unknown): string {
  return execErrStream(err, "stderr");
}

export function execErrStdout(err: unknown): string {
  return execErrStream(err, "stdout");
}

export function execErrCode(err: unknown): number | null {
  const status = (err as { status?: unknown } | null)?.status;
  return typeof status === "number" ? status : null;
}

function execErrStream(err: unknown, stream: "stderr" | "stdout"): string {
  if (
    err &&
    typeof err === "object" &&
    stream in err &&
    typeof (err as Record<string, { toString?: () => string } | undefined>)[stream]?.toString ===
      "function"
  ) {
    return (err as Record<string, { toString: () => string }>)[stream].toString().trim();
  }
  return "";
}

export function customerSshKeyPath(slug: string): string {
  return path.join(CUSTOMER_KEYS_DIR, slug, "id_ed25519");
}

export function setRepoSshCommand(repoDir: string, slug: string): void {
  const keyPath = customerSshKeyPath(slug);
  if (!fs.existsSync(keyPath)) return;
  const sshCmd = `ssh -i ${keyPath} -F /home/node/.ssh/config -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR`;
  gitExec(repoDir, ["config", "core.sshCommand", sshCmd]);
}

export function generateCustomerSshKey(slug: string): string {
  const keyDir = path.join(CUSTOMER_KEYS_DIR, slug);
  const keyPath = path.join(keyDir, "id_ed25519");
  const pubPath = keyPath + ".pub";

  if (fs.existsSync(keyPath)) {
    log(`[git] SSH key already exists for ${slug}`);
    return fs.readFileSync(pubPath, "utf-8").trim();
  }

  fs.mkdirSync(keyDir, { recursive: true });
  execSync(`ssh-keygen -t ed25519 -N "" -f "${keyPath}" -C "octogee-${slug}@gateway" -q`, {
    stdio: "pipe",
  });
  /* eslint-disable sonarjs/file-permissions -- restrictive (private key dir), correct */
  fs.chmodSync(keyDir, 0o700);
  fs.chmodSync(keyPath, 0o600);
  fs.chmodSync(pubPath, 0o644);
  /* eslint-enable sonarjs/file-permissions */

  log(`[git] SSH keypair generated for ${slug}`);
  return fs.readFileSync(pubPath, "utf-8").trim();
}

// Reads the Gitea-registered "octogee-gateway" pubkey via the gateway-edge
// admin broker — used by the mount flow to detect SSH-key drift. Returns null
// when the user/key is absent.
export async function readGiteaCustomerPubKey(slug: string): Promise<string | null> {
  const localPubKey = readLocalCustomerPubKey(slug);
  if (localPubKey === null) return null;
  return findMatchingGiteaPubKey(localPubKey, await giteaBroker.readGiteaUserPubKeys(slug));
}

export function findMatchingGiteaPubKey(
  localPubKey: string,
  registeredPubKeys: readonly string[],
): string | null {
  return registeredPubKeys.find((candidate) => pubKeysMatch(candidate, localPubKey)) ?? null;
}

export async function deleteCustomerSshKey(slug: string): Promise<void> {
  const keyDir = path.join(CUSTOMER_KEYS_DIR, slug);
  await fs.promises.rm(keyDir, { recursive: true, force: true });
}

export function readLocalCustomerPubKey(slug: string): string | null {
  const pubPath = path.join(CUSTOMER_KEYS_DIR, slug, "id_ed25519.pub");
  try {
    return fs.readFileSync(pubPath, "utf-8").trim();
  } catch {
    return null;
  }
}

export interface LocalCustomerPubKey {
  slug: string;
  pubKey: string;
}

export function listLocalCustomerPubKeys(): LocalCustomerPubKey[] {
  if (!fs.existsSync(CUSTOMER_KEYS_DIR)) return [];
  return fs.readdirSync(CUSTOMER_KEYS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const pubKey = readLocalCustomerPubKey(entry.name);
      if (pubKey === null) {
        throw new Error(`[git] local SSH public key is missing for ${entry.name}`);
      }
      return { slug: entry.name, pubKey };
    })
    .sort((a, b) => a.slug.localeCompare(b.slug));
}

// Ensures the per-customer Gitea user exists and its SSH key is registered.
// The admin work happens in the gateway-edge sidecar; this is the provisioner's
// thin call into it. Throws (loud) on failure — the mount retries.
export async function createGiteaUser(slug: string, pubKey: string): Promise<void> {
  await giteaBroker.ensureGiteaUser(slug, pubKey);
}

function sshRemoteUrl(org: string, repoName: string): string {
  return `git@${GIT_SSH_HOST}:${org}/${repoName}.git`;
}

export function gitExec(cwd: string, argv: string[], sshKeyPath?: string): string | null {
  try {
    const env: Record<string, string | undefined> = {
      ...process.env,
      GIT_TERMINAL_PROMPT: "0",
    };
    if (sshKeyPath) {
      env.GIT_SSH_COMMAND = `ssh -i "${sshKeyPath}" -F /home/node/.ssh/config -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR`;
    }
    return execFileSync("/usr/bin/git", argv, {
      cwd,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
      env,
    }).trim();
  } catch (err: unknown) {
    const detail =
      [execErrStderr(err), execErrStdout(err)].filter(Boolean).join(" | ") || errMessage(err);
    const code = execErrCode(err);
    const safeArgs = argv.join(" ").replace(/x-access-token:[^\s@]+/g, "x-access-token:***");
    const safeDetail = detail.replace(/x-access-token:[^\s@]+/g, "x-access-token:***");
    log(`⚠ [git] exec failed: git ${safeArgs} → code=${code ?? "?"} ${safeDetail}`);
    return null;
  }
}

// Workspace + project clones run over the per-customer SSH key. The key is
// registered (createGiteaUser) before any clone in the mount flow, so there is
// no admin-token HTTP fallback: a missing key is a loud failure the reconcile
// heals by regenerating + re-registering. Repo existence is checked through the
// admin broker (no admin token on this container).
export async function cloneWorkspaceRepo(slug: string, _repoUrl?: string): Promise<boolean> {
  const dest = path.join(CUSTOMERS_DIR, slug);
  const gitDir = path.join(dest, ".git");

  if (fs.existsSync(gitDir)) return true;

  const org = workspaceGiteaOrg(slug);
  const repoName = workspaceRepoName();
  const sshKey = customerSshKeyPath(slug);
  if (!fs.existsSync(sshKey)) {
    log(`⚠ [git] Cannot clone ${slug} — per-customer SSH key missing (registered before clone in the mount flow)`);
    return false;
  }

  let exists: boolean;
  try {
    exists = await giteaBroker.repoExists(org, repoName);
  } catch (err: unknown) {
    log(`⚠ [git] Gitea repo-exists check failed for ${org}/${repoName}: ${errMessage(err)}`);
    return false;
  }
  if (!exists) {
    log(`[git] Repo ${org}/${repoName} not found on Gitea — skipping clone`);
    return false;
  }

  const result = gitExec(path.dirname(dest), ["clone", sshRemoteUrl(org, repoName), slug], sshKey);
  if (result === null) {
    log(`⚠ [git] Clone failed for ${slug}`);
    try { fs.rmSync(dest, { recursive: true, force: true }); } catch {}
    return false;
  }

  gitExec(dest, ["config", "user.email", `${slug}@octogee.com`]);
  gitExec(dest, ["config", "user.name", `Octo (${slug})`]);

  setRepoSshCommand(dest, slug);

  log(`[git] ✅ Cloned ${org}/${repoName} → customers/${slug}/`);
  return true;
}

export async function cloneProjectRepo(
  slug: string,
  projectSlug: string,
  giteaRepoName: string,
): Promise<boolean> {
  const dest = path.join(CUSTOMERS_DIR, slug, "projects", projectSlug);
  const gitDir = path.join(dest, ".git");

  if (fs.existsSync(gitDir)) return true;

  const org = workspaceGiteaOrg(slug);
  const sshKey = customerSshKeyPath(slug);
  if (!fs.existsSync(sshKey)) {
    log(`⚠ [git] Cannot clone ${slug}/${projectSlug} — per-customer SSH key missing`);
    return false;
  }

  let exists: boolean;
  try {
    exists = await giteaBroker.repoExists(org, giteaRepoName);
  } catch (err: unknown) {
    log(`⚠ [git] Gitea repo-exists check failed for ${org}/${giteaRepoName}: ${errMessage(err)}`);
    return false;
  }
  if (!exists) {
    log(`[git] Project repo ${org}/${giteaRepoName} not found on Gitea — skipping clone`);
    return false;
  }

  const parent = path.dirname(dest);
  fs.mkdirSync(parent, { recursive: true });
  const cloneDir = fs.existsSync(dest)
    ? fs.mkdtempSync(path.join(parent, `.${projectSlug}-clone-`))
    : dest;
  const result = gitExec(parent, ["clone", sshRemoteUrl(org, giteaRepoName), cloneDir], sshKey);
  if (result === null) {
    log(`⚠ [git] Clone failed for ${slug}/${projectSlug}`);
    fs.rmSync(cloneDir, { recursive: true, force: true });
    return false;
  }

  if (cloneDir !== dest) {
    try {
      adoptProjectClone(cloneDir, dest);
    } catch (err) {
      log(`⚠ [git] Failed to adopt clone for ${slug}/${projectSlug}: ${errMessage(err)}`);
      fs.rmSync(cloneDir, { recursive: true, force: true });
      return false;
    }
  }

  gitExec(dest, ["config", "user.email", `${slug}@octogee.com`]);
  gitExec(dest, ["config", "user.name", `Octo (${slug})`]);

  setRepoSshCommand(dest, slug);

  log(`[git] ✅ Cloned ${org}/${giteaRepoName} → customers/${slug}/projects/${projectSlug}/`);
  return true;
}

function copyMissingCloneTree(source: string, dest: string): void {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    if (entry.name === ".git") continue;
    const sourcePath = path.join(source, entry.name);
    const destPath = path.join(dest, entry.name);
    if (!fs.existsSync(destPath)) {
      fs.cpSync(sourcePath, destPath, { recursive: true, preserveTimestamps: true });
      continue;
    }
    if (entry.isDirectory() && fs.statSync(destPath).isDirectory()) {
      copyMissingCloneTree(sourcePath, destPath);
    }
  }
}

export function adoptProjectClone(cloneDir: string, dest: string): void {
  copyMissingCloneTree(cloneDir, dest);
  fs.renameSync(path.join(cloneDir, ".git"), path.join(dest, ".git"));
  fs.rmSync(cloneDir, { recursive: true, force: true });
}

export async function initWorkspaceRepo(coachDir: string, slug: string): Promise<string | null> {
  const org = workspaceGiteaOrg(slug);
  const repoName = workspaceRepoName();

  fs.writeFileSync(path.join(coachDir, ".gitignore"), workspaceGitignore(), "utf-8");

  const welcome = notesWelcomeSeed("this workspace");
  const welcomeDest = path.join(coachDir, welcome.relPath);
  fs.mkdirSync(path.dirname(welcomeDest), { recursive: true });
  if (!fs.existsSync(welcomeDest)) fs.writeFileSync(welcomeDest, welcome.content, "utf-8");

  log(`[git] Initializing repo in ${coachDir}`);
  const initResult = gitExec(coachDir, ["init", "-b", "main"]);
  if (initResult === null) {
    log(`⚠ [git] git init failed for ${slug} — aborting repo setup`);
    return null;
  }
  log(`[git] init: ${initResult}`);
  gitExec(coachDir, ["config", "user.email", `${slug}@octogee.com`]);
  gitExec(coachDir, ["config", "user.name", `Octo (${slug})`]);

  setRepoSshCommand(coachDir, slug);

  try {
    await giteaBroker.ensureWorkspaceRepo(slug);
  } catch (err) {
    log(`⚠ [git] Failed to create repo ${org}/${repoName}: ${errMessage(err)}`);
    return null;
  }

  const originUrl = sshRemoteUrl(org, repoName);
  const remoteResult = gitExec(coachDir, ["remote", "add", "origin", originUrl]);
  if (remoteResult === null) {
    log(`⚠ [git] remote add failed for ${slug} — aborting (would leak orphan Firestore repoUrl)`);
    return null;
  }
  log(`[git] remote add: ${remoteResult === "" ? "OK" : remoteResult}`);

  const sshKey = customerSshKeyPath(slug);
  const keyArg = fs.existsSync(sshKey) ? sshKey : undefined;
  pushInitialSkeleton(coachDir, slug, keyArg);

  const gitHost = new URL(GIT_API_URL).origin;
  const repoUrlDisplay = `${gitHost}/${org}/${repoName}`;
  log(`[git] ✅ Workspace repo ready: ${repoUrlDisplay}`);
  return repoUrlDisplay;
}

export function workspaceGitignore(): string {
  return [
    "# Octogee workspace — track user-visible files, exclude system/build artifacts",
    "",
    "# System files (provisioner-managed, not user-visible)",
    "PROJECTS.md",
    "HEARTBEAT.md",
    "crew-webhooks.json",
    "_pending_*.json",
    ".byot-managed",
    ".system/",
    ".openclaw/",
    ".ssh/",
    "",
    "# Blob cache (provisioner-managed, synced from GCS)",
    ".blobs/",
    "",
    "# Inbound media (ephemeral, 7-day retention)",
    "media/",
    "",
    "# Project repos are their own Gitea clones — committed via their own",
    "# commit path (octogee_project_commit), never swept by workspace commits",
    "projects/",
    "",
    "# Build artifacts",
    "node_modules/",
    "",
    "# User-visible files are tracked:",
    "# AGENTS.md, TOOLS.md, SOUL.md, USER.md, MEMORY.md, memory/*",
  ].join("\n") + "\n";
}

function projectGitignore(): string {
  return [
    "# Build artifacts",
    "node_modules/",
    ".astro/",
    "dist/",
    "",
    "# OS files",
    ".DS_Store",
  ].join("\n") + "\n";
}

export async function initProjectRepo(
  projectDir: string,
  slug: string,
  projectName: string,
  committerName = "Octogee",
  committerEmail = "octo@octogee.com",
): Promise<string | null> {
  const org = workspaceGiteaOrg(slug);
  const repoName = projectRepoName(projectName);
  const sshKey = customerSshKeyPath(slug);
  const keyArg = fs.existsSync(sshKey) ? sshKey : undefined;

  fs.writeFileSync(path.join(projectDir, ".gitignore"), projectGitignore(), "utf-8");

  log(`[git] Initializing project repo: ${slug}/${projectName}`);
  gitExec(projectDir, ["init", "-b", "main"]);
  gitExec(projectDir, ["config", "user.email", committerEmail]);
  gitExec(projectDir, ["config", "user.name", committerName]);

  setRepoSshCommand(projectDir, slug);
  gitExec(projectDir, ["add", "-A"]);
  const commitResult = gitExec(projectDir, ["commit", "-m", `initial: ${projectName} project created`]);
  if (commitResult === null) {
    log(`⚠ [git] Failed to create initial commit for project ${slug}/${projectName}`);
    return null;
  }

  try {
    await giteaBroker.ensureProjectRepo(slug, projectName);
  } catch (err) {
    log(`⚠ [git] Failed to create project repo ${org}/${repoName}: ${errMessage(err)}`);
    return null;
  }

  const originUrl = sshRemoteUrl(org, repoName);
  gitExec(projectDir, ["remote", "add", "origin", originUrl]);
  const pushResult = gitExec(projectDir, ["push", "-u", "origin", "main"], keyArg);
  log(`[git] project push: ${pushResult !== null ? "OK" : "FAILED"}`);

  if (pushResult === null) {
    log(`⚠ [git] Failed to push project ${slug}/${projectName}`);
    return null;
  }

  const gitHost = new URL(GIT_API_URL).origin;
  const repoUrlDisplay = `${gitHost}/${org}/${repoName}`;
  log(`[git] ✅ Project repo created: ${repoUrlDisplay}`);
  return repoUrlDisplay;
}

export function pushInitialSkeleton(
  coachDir: string,
  slug: string,
  sshKeyPath?: string,
): void {
  if (gitExec(coachDir, ["status", "--porcelain"])) {
    gitExec(coachDir, ["add", "-A"]);
    if (gitExec(coachDir, ["commit", "-m", "initial workspace skeleton"]) === null) {
      log(`⚠ [git] ${slug} initial commit failed — sync will retry`);
    }
  }
  if (gitExec(coachDir, ["push", "-u", "origin", "main"], sshKeyPath) === null) {
    log(`⚠ [git] ${slug} initial push failed — sync will retry`);
  } else {
    log(`[git] ${slug} initial push: OK`);
  }
}

export async function commitAndPush(repoDir: string, message: string): Promise<boolean> {
  const relPath = path.relative(CUSTOMERS_DIR, repoDir);
  const slug = relPath.split(path.sep)[0];
  const sshKey = customerSshKeyPath(slug);
  const keyArg = fs.existsSync(sshKey) ? sshKey : undefined;

  const status = gitExec(repoDir, ["status", "--porcelain"]);
  if (!status) {
    log(`[git] commitAndPush: nothing to commit in ${repoDir}`);
    return true;
  }
  gitExec(repoDir, ["add", "-A"]);
  const commitResult = gitExec(repoDir, ["commit", "-m", message]);
  if (commitResult === null) {
    log(`⚠ [git] commitAndPush: commit failed in ${repoDir}`);
    return false;
  }
  const pushResult = gitExec(repoDir, ["push", "origin", "main"], keyArg);
  if (pushResult === null) {
    log(`⚠ [git] commitAndPush: push failed in ${repoDir}`);
    return false;
  }
  log(`[git] commitAndPush: OK in ${repoDir}`);
  return true;
}

export function listOnDiskCustomerSlugs(): string[] {
  if (!fs.existsSync(CUSTOMERS_DIR)) return [];
  return fs.readdirSync(CUSTOMERS_DIR).filter((d) => {
    try {
      return fs.statSync(path.join(CUSTOMERS_DIR, d)).isDirectory();
    } catch {
      return false;
    }
  });
}

function getOriginRemoteSilent(coachDir: string): string | null {
  try {
    // eslint-disable-next-line sonarjs/no-os-command-from-path -- frozen literal, no input; silent probe (gitExec would log every no-origin as ⚠ at default level)
    return execSync("git remote get-url origin", {
      cwd: coachDir,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
  } catch {
    return null;
  }
}

function migrateHttpRemoteToSsh(coachDir: string, slug: string): boolean {
  const result = gitExec(coachDir, [
    "remote", "set-url", "origin",
    sshRemoteUrl(workspaceGiteaOrg(slug), workspaceRepoName()),
  ]);
  if (result === null) return false;
  log(`[git-sync] ${slug}: migrated remote to SSH`);
  return true;
}

function commitLocalChanges(coachDir: string, slug: string, strict: boolean): boolean {
  const status = gitExec(coachDir, ["status", "--porcelain"]);
  if (status === null) {
    if (strict) throw new Error(`${slug}: git status failed`);
    return false;
  }
  if (status === "") return false;
  if (gitExec(coachDir, ["add", "-A"]) === null) {
    if (strict) throw new Error(`${slug}: git add failed`);
    return false;
  }
  const committed = gitExec(
    coachDir,
    ["commit", "-m", `auto: ${new Date().toISOString()}`],
  ) !== null;
  if (!committed && strict) throw new Error(`${slug}: git commit failed`);
  return committed;
}

function rebaseFromOriginIfPresent(coachDir: string, keyArg: string | undefined): void {
  const remoteMain = gitExec(coachDir, ["ls-remote", "--heads", "origin", "main"], keyArg);
  if (remoteMain) {
    gitExec(coachDir, ["pull", "--rebase", "origin", "main"], keyArg);
  }
}

function pushAndLog(coachDir: string, slug: string, keyArg: string | undefined): boolean {
  const pushResult = gitExec(coachDir, ["push", "origin", "main"], keyArg);
  if (pushResult !== null) {
    log(`[git-sync] ${slug}: pushed changes`);
    return true;
  } else {
    log(`⚠ [git-sync] ${slug}: push failed`);
    return false;
  }
}

interface WorkspaceSyncLease {
  release(): void;
}

type WorkspaceSyncLeaseFactory = (workspaceDir: string) => WorkspaceSyncLease | null;

export function runWorkspaceSyncMutation(
  coachDir: string,
  slug: string,
  work: () => void,
  acquire: WorkspaceSyncLeaseFactory = (workspaceDir) =>
    acquireWorkspaceMutationLeaseSync({ workspaceDir }),
  logFn: (message: string) => void = dlog,
  strict = false,
): boolean {
  const lease = acquire(coachDir);
  if (!lease) {
    logFn(`[git-sync] ${slug}: workspace busy — autosave deferred`);
    if (strict) throw new Error(`${slug}: workspace mutation lease unavailable`);
    return false;
  }
  try {
    work();
    return true;
  } finally {
    lease.release();
  }
}

function syncOneWorkspace(slug: string, strict: boolean): void {
  const coachDir = path.join(CUSTOMERS_DIR, slug);
  const gitDir = path.join(coachDir, ".git");
  if (!fs.existsSync(gitDir)) return;
  runWorkspaceSyncMutation(coachDir, slug, () => {
    setRepoSshCommand(coachDir, slug);

    const sshKey = customerSshKeyPath(slug);
    const keyArg = fs.existsSync(sshKey) ? sshKey : undefined;

    const remoteCheck = getOriginRemoteSilent(coachDir);
    if (remoteCheck === null) {
      if (strict) throw new Error(`${slug}: git origin is missing`);
      dlog(`[git-sync] ${slug}: no remote — skipping (lifecycle contract will heal on next restore)`);
      return;
    }

    if (remoteCheck.startsWith("http")) {
      const migrated = migrateHttpRemoteToSsh(coachDir, slug);
      if (!migrated && strict) throw new Error(`${slug}: SSH remote migration failed`);
    }

    const committed = commitLocalChanges(coachDir, slug, strict);
    rebaseFromOriginIfPresent(coachDir, keyArg);

    if (committed || strict) {
      const pushed = pushAndLog(coachDir, slug, keyArg);
      if (!pushed && strict) throw new Error(`${slug}: git push failed`);
    }
  }, undefined, dlog, strict);
}

// Workspace auto-sync is pure SSH/git on the per-customer key — no admin token.
// The fleet controller decides whether this runs; this loops
// the on-disk customers and pushes their local changes.
export interface SyncAllWorkspacesOptions {
  strict?: boolean;
}

export async function syncAllWorkspaces(opts: SyncAllWorkspacesOptions = {}): Promise<void> {
  const failures: string[] = [];
  for (const slug of listOnDiskCustomerSlugs()) {
    try {
      syncOneWorkspace(slug, opts.strict === true);
    } catch (err) {
      const failure = errMessage(err);
      log(`⚠ [git-sync] ${failure}`);
      failures.push(failure);
    }
  }
  if (opts.strict && failures.length > 0) {
    throw new Error(`[git-sync] durable flush failed: ${failures.join("; ")}`);
  }
}

export async function archiveWorkspaceRepo(slug: string): Promise<void> {
  const org = workspaceGiteaOrg(slug);
  const repoName = workspaceRepoName();
  try {
    await giteaBroker.archiveRepo(org, repoName);
    log(`[git] Archived repo: ${org}/${repoName}`);
  } catch (err) {
    log(`⚠ [git] Failed to archive repo ${org}/${repoName}: ${errMessage(err)}`);
  }
}

export async function archiveProjectRepo(slug: string, projectName: string): Promise<void> {
  const org = workspaceGiteaOrg(slug);
  const repoName = projectRepoName(projectName);
  try {
    await giteaBroker.archiveRepo(org, repoName);
    log(`[git] Archived project repo: ${org}/${repoName}`);
  } catch (err) {
    log(`⚠ [git] Failed to archive project repo ${org}/${repoName}: ${errMessage(err)}`);
  }
}
