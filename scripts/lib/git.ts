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
import { execSync } from "child_process";
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
import { notesWelcomeSeed } from "./projects/playbook-seeds.js";

export function errMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

export function execErrStderr(err: unknown): string {
  if (
    err &&
    typeof err === "object" &&
    "stderr" in err &&
    typeof (err as { stderr?: { toString?: () => string } }).stderr?.toString === "function"
  ) {
    return (err as { stderr: { toString: () => string } }).stderr.toString().trim();
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
  gitExec(repoDir, `config core.sshCommand "${sshCmd}"`);
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
  return giteaBroker.readGiteaUserPubKey(slug);
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

// Ensures the per-customer Gitea user exists and its SSH key is registered.
// The admin work happens in the gateway-edge sidecar; this is the provisioner's
// thin call into it. Throws (loud) on failure — the mount retries.
export async function createGiteaUser(slug: string, pubKey: string): Promise<void> {
  await giteaBroker.ensureGiteaUser(slug, pubKey);
}

function sshRemoteUrl(org: string, repoName: string): string {
  return `git@${GIT_SSH_HOST}:${org}/${repoName}.git`;
}

export function gitExec(cwd: string, args: string, sshKeyPath?: string): string | null {
  try {
    const env: Record<string, string | undefined> = {
      ...process.env,
      GIT_TERMINAL_PROMPT: "0",
    };
    if (sshKeyPath) {
      env.GIT_SSH_COMMAND = `ssh -i "${sshKeyPath}" -F /home/node/.ssh/config -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR`;
    }
    return execSync(`git ${args}`, {
      cwd,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
      env,
    }).trim();
  } catch (err: unknown) {
    const stderr = execErrStderr(err);
    const safeArgs = args.replace(/x-access-token:[^\s@]+/g, "x-access-token:***");
    const safeErr = (stderr || errMessage(err)).replace(/x-access-token:[^\s@]+/g, "x-access-token:***");
    log(`⚠ [git] exec failed: git ${safeArgs} → ${safeErr}`);
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

  const result = gitExec(path.dirname(dest), `clone ${sshRemoteUrl(org, repoName)} ${slug}`, sshKey);
  if (result === null) {
    log(`⚠ [git] Clone failed for ${slug}`);
    try { fs.rmSync(dest, { recursive: true, force: true }); } catch {}
    return false;
  }

  gitExec(dest, `config user.email "${slug}@octogee.com"`);
  gitExec(dest, `config user.name "Octo (${slug})"`);

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

  fs.mkdirSync(path.dirname(dest), { recursive: true });

  const result = gitExec(path.dirname(dest), `clone ${sshRemoteUrl(org, giteaRepoName)} ${projectSlug}`, sshKey);
  if (result === null) {
    log(`⚠ [git] Clone failed for ${slug}/${projectSlug}`);
    try { fs.rmSync(dest, { recursive: true, force: true }); } catch {}
    return false;
  }

  gitExec(dest, `config user.email "${slug}@octogee.com"`);
  gitExec(dest, `config user.name "Octo (${slug})"`);

  setRepoSshCommand(dest, slug);

  log(`[git] ✅ Cloned ${org}/${giteaRepoName} → customers/${slug}/projects/${projectSlug}/`);
  return true;
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
  const initResult = gitExec(coachDir, "init -b main");
  if (initResult === null) {
    log(`⚠ [git] git init failed for ${slug} — aborting repo setup`);
    return null;
  }
  log(`[git] init: ${initResult}`);
  gitExec(coachDir, `config user.email "${slug}@octogee.com"`);
  gitExec(coachDir, `config user.name "Octo (${slug})"`);

  setRepoSshCommand(coachDir, slug);

  try {
    await giteaBroker.ensureWorkspaceRepo(slug);
  } catch (err) {
    log(`⚠ [git] Failed to create repo ${org}/${repoName}: ${errMessage(err)}`);
    return null;
  }

  const originUrl = sshRemoteUrl(org, repoName);
  const remoteResult = gitExec(coachDir, `remote add origin ${originUrl}`);
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

function workspaceGitignore(): string {
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
    "# Build artifacts",
    "projects/*/preview/",
    "projects/*/src/node_modules/",
    "node_modules/",
    "",
    "# User-visible files are tracked:",
    "# AGENTS.md, TOOLS.md, SOUL.md, USER.md, MEMORY.md, memory/*, projects/*/src/",
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
  gitExec(projectDir, "init -b main");
  gitExec(projectDir, `config user.email "${committerEmail}"`);
  gitExec(projectDir, `config user.name "${committerName}"`);

  setRepoSshCommand(projectDir, slug);
  gitExec(projectDir, "add -A");
  const commitResult = gitExec(projectDir, `commit -m "initial: ${projectName} project created"`);
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
  gitExec(projectDir, `remote add origin ${originUrl}`);
  const pushResult = gitExec(projectDir, "push -u origin main", keyArg);
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
  if (gitExec(coachDir, "status --porcelain")) {
    gitExec(coachDir, "add -A");
    if (gitExec(coachDir, `commit -m "initial workspace skeleton"`) === null) {
      log(`⚠ [git] ${slug} initial commit failed — sync will retry`);
    }
  }
  if (gitExec(coachDir, "push -u origin main", sshKeyPath) === null) {
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

  const status = gitExec(repoDir, "status --porcelain");
  if (!status) {
    log(`[git] commitAndPush: nothing to commit in ${repoDir}`);
    return true;
  }
  gitExec(repoDir, "add -A");
  const safeMessage = `'${message.replace(/'/g, "'\\''")}'`;
  const commitResult = gitExec(repoDir, `commit -m ${safeMessage}`);
  if (commitResult === null) {
    log(`⚠ [git] commitAndPush: commit failed in ${repoDir}`);
    return false;
  }
  const pushResult = gitExec(repoDir, "push origin main", keyArg);
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

function migrateHttpRemoteToSsh(coachDir: string, slug: string): void {
  gitExec(
    coachDir,
    `remote set-url origin ${sshRemoteUrl(workspaceGiteaOrg(slug), workspaceRepoName())}`,
  );
  log(`[git-sync] ${slug}: migrated remote to SSH`);
}

function commitLocalChanges(coachDir: string): boolean {
  const status = gitExec(coachDir, "status --porcelain");
  if (!status) return false;
  gitExec(coachDir, "add -A");
  return gitExec(coachDir, `commit -m "auto: ${new Date().toISOString()}"`) !== null;
}

function rebaseFromOriginIfPresent(coachDir: string, keyArg: string | undefined): void {
  const remoteMain = gitExec(coachDir, "ls-remote --heads origin main", keyArg);
  if (remoteMain) {
    gitExec(coachDir, "pull --rebase origin main", keyArg);
  }
}

function pushAndLog(coachDir: string, slug: string, keyArg: string | undefined): void {
  const pushResult = gitExec(coachDir, "push origin main", keyArg);
  if (pushResult !== null) {
    log(`[git-sync] ${slug}: pushed changes`);
  } else {
    log(`⚠ [git-sync] ${slug}: push failed`);
  }
}

function syncOneWorkspace(slug: string): void {
  const coachDir = path.join(CUSTOMERS_DIR, slug);
  const gitDir = path.join(coachDir, ".git");
  if (!fs.existsSync(gitDir)) return;

  setRepoSshCommand(coachDir, slug);

  const sshKey = customerSshKeyPath(slug);
  const keyArg = fs.existsSync(sshKey) ? sshKey : undefined;

  const remoteCheck = getOriginRemoteSilent(coachDir);
  if (remoteCheck === null) {
    dlog(`[git-sync] ${slug}: no remote — skipping (lifecycle contract will heal on next restore)`);
    return;
  }

  if (remoteCheck.startsWith("http")) {
    migrateHttpRemoteToSsh(coachDir, slug);
  }

  const committed = commitLocalChanges(coachDir);
  rebaseFromOriginIfPresent(coachDir, keyArg);

  if (committed) {
    pushAndLog(coachDir, slug, keyArg);
  }
}

// Workspace auto-sync is pure SSH/git on the per-customer key — no admin token.
// The fleet controller decides whether this runs; this loops
// the on-disk customers and pushes their local changes.
export async function syncAllWorkspaces(): Promise<void> {
  for (const slug of listOnDiskCustomerSlugs()) {
    syncOneWorkspace(slug);
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
