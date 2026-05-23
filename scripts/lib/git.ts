import { execSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import { log, dlog, GIT_API_URL, GIT_API_TOKEN, GIT_SSH_HOST, CUSTOMERS_DIR, CUSTOMER_KEYS_DIR } from "./config.js";
import { workspaceGiteaOrg, workspaceRepoName, projectRepoName, giteaUsername } from "./gitea-naming.js";

export { giteaUsername };

function adminHeaders(includeContentType = true): Record<string, string> {
  return {
    Authorization: `token ${GIT_API_TOKEN}`,
    Accept: "application/json",
    ...(includeContentType ? { "Content-Type": "application/json" } : {}),
  };
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
  // eslint-disable-next-line sonarjs/os-command -- PATH controlled, args validated
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

export async function readGiteaCustomerPubKey(slug: string): Promise<string | null> {
  if (!GIT_API_TOKEN) return null;
  const username = giteaUsername(slug);
  const resp = await fetch(`${GIT_API_URL}/users/${username}/keys`, {
    headers: adminHeaders(false),
  });
  if (resp.status === 404) return null; 
  if (!resp.ok) {

const body = await resp.text().catch(() => "<no body>");
    throw new Error(
      `Gitea key read for ${username} returned ${resp.status}: ${body.slice(0, 200)}`,
    );
  }
  const keys = (await resp.json()) as Array<{ title?: string; key?: string }>;
  for (const k of keys) {
    if (k.title === "octogee-gateway" && typeof k.key === "string") {
      return k.key.trim();
    }
  }
  return null;
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

export async function createGiteaUser(slug: string, pubKey: string): Promise<string | null> {
  if (!GIT_API_TOKEN) return null;

  const username = giteaUsername(slug);
  const password = crypto.randomBytes(32).toString("hex");
  const headers = adminHeaders();

  const createResp = await fetch(`${GIT_API_URL}/admin/users`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      username,
      email: `${slug}@octogee.local`,
      password,
      must_change_password: false,
      visibility: "private",
    }),
  });
  if (createResp.ok) {
    log(`[git] Gitea user created: ${username}`);
  } else if (createResp.status === 422) {
    log(`[git] Gitea user already exists: ${username}`);
  } else {
    const body = await createResp.text();
    log(`⚠ [git] Failed to create Gitea user ${username}: ${createResp.status} ${body}`);
    return null;
  }

  const keysResp = await fetch(`${GIT_API_URL}/users/${username}/keys`, { headers });
  if (keysResp.ok) {
    const keys = (await keysResp.json()) as any[];
    for (const key of keys) {
      if (key.title === "octogee-gateway") {
        await fetch(`${GIT_API_URL}/admin/users/${username}/keys/${key.id}`, {
          method: "DELETE",
          headers,
        });
      }
    }
  }

  const keyResp = await fetch(`${GIT_API_URL}/admin/users/${username}/keys`, {
    method: "POST",
    headers,
    body: JSON.stringify({ title: "octogee-gateway", key: pubKey }),
  });
  if (keyResp.ok) {
    log(`[git] SSH key registered for ${username}`);
  } else {
    const body = await keyResp.text();
    log(`⚠ [git] Failed to register SSH key for ${username}: ${keyResp.status} ${body}`);
  }

  const sudoHeaders = { ...headers, Sudo: username };
  const tokensResp = await fetch(`${GIT_API_URL}/users/${username}/tokens`, {
    method: "GET",
    headers: sudoHeaders,
  });
  if (tokensResp.ok) {
    const tokens = (await tokensResp.json()) as any[];
    for (const t of tokens) {
      if (t.name === "gateway-edge") {
        await fetch(`${GIT_API_URL}/users/${username}/tokens/${t.id}`, {
          method: "DELETE",
          headers: sudoHeaders,
        });
      }
    }
  }

  const tokenResp = await fetch(`${GIT_API_URL}/users/${username}/tokens`, {
    method: "POST",
    headers: sudoHeaders,
    body: JSON.stringify({
      name: "gateway-edge",
      scopes: ["write:repository"],
    }),
  });
  if (!tokenResp.ok) {
    log(`[git] PAT skipped for ${username} (Gitea admin-sudo limitation on /users/${username}/tokens) — SSH is the primary auth path`);
    return null;
  }

  const tokenData = (await tokenResp.json()) as any;
  const token = tokenData.sha1 || tokenData.token || "";
  if (!token) {
    log(`⚠ [git] Token created but no value returned for ${username}`);
    return null;
  }

  log(`[git] API token created for ${username}`);
  return token;
}

export async function deleteGiteaUser(slug: string): Promise<void> {
  if (!GIT_API_TOKEN) return;

  const username = giteaUsername(slug);
  const resp = await fetch(`${GIT_API_URL}/admin/users/${username}`, {
    method: "DELETE",
    headers: adminHeaders(false),
  });

  if (resp.ok || resp.status === 404) {
    log(`[git] Gitea user deleted: ${username}`);
  } else {
    const body = await resp.text();
    log(`⚠ [git] Failed to delete Gitea user ${username}: ${resp.status} ${body}`);
  }
}

function sshRemoteUrl(org: string, repoName: string): string {
  return `git@${GIT_SSH_HOST}:${org}/${repoName}.git`;
}

function httpCloneUrl(org: string, repoName: string): string {
  const gitHost = new URL(GIT_API_URL).origin;
  const authPrefix = `://octogee-admin:${GIT_API_TOKEN}@`;
  return `${gitHost.replace("://", authPrefix)}/${org}/${repoName}.git`;
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
    // eslint-disable-next-line sonarjs/os-command -- args constructed by trusted callers; each input validated upstream
    return execSync(`git ${args}`, {
      cwd,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
      env,
    }).trim();
  } catch (err: any) {
    const stderr = err.stderr?.toString?.()?.trim() ?? "";
    const safeArgs = args.replace(/x-access-token:[^\s@]+/g, "x-access-token:***");
    const safeErr  = (stderr || err.message).replace(/x-access-token:[^\s@]+/g, "x-access-token:***");
    log(`⚠ [git] exec failed: git ${safeArgs} → ${safeErr}`);
    return null;
  }
}

export async function cloneWorkspaceRepo(slug: string, _repoUrl?: string): Promise<boolean> {
  const dest = path.join(CUSTOMERS_DIR, slug);
  const gitDir = path.join(dest, ".git");

  if (fs.existsSync(gitDir)) return true;

  if (!GIT_API_TOKEN) {
    log(`[git] Cannot clone ${slug} — GIT_API_TOKEN not set`);
    return false;
  }

  const org = workspaceGiteaOrg(slug);
  const repoName = workspaceRepoName();
  const sshKey = customerSshKeyPath(slug);
  const hasCustomerKey = fs.existsSync(sshKey);

  try {
    const resp = await fetch(`${GIT_API_URL}/repos/${org}/${repoName}`, {
      headers: adminHeaders(false),
    });
    if (!resp.ok) {
      log(`[git] Repo ${org}/${repoName} not found on Gitea (${resp.status}) — skipping clone`);
      return false;
    }
  } catch (err: any) {
    log(`⚠ [git] Gitea API check failed for ${org}/${repoName}: ${err.message}`);
    return false;
  }

  let result: string | null;
  if (hasCustomerKey) {
    const cloneUrl = sshRemoteUrl(org, repoName);
    result = gitExec(path.dirname(dest), `clone ${cloneUrl} ${slug}`, sshKey);
  } else {
    const cloneUrl = httpCloneUrl(org, repoName);
    log(`[git] Cloning ${slug} via HTTP (no per-customer SSH key yet)`);
    result = gitExec(path.dirname(dest), `clone ${cloneUrl} ${slug}`);
    if (result !== null) {
      gitExec(dest, `remote set-url origin ${sshRemoteUrl(org, repoName)}`);
    }
  }

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

  if (!GIT_API_TOKEN) {
    log(`[git] Cannot clone ${slug}/${projectSlug} — GIT_API_TOKEN not set`);
    return false;
  }

  const org = workspaceGiteaOrg(slug);
  const sshKey = customerSshKeyPath(slug);
  const hasCustomerKey = fs.existsSync(sshKey);

  try {
    const resp = await fetch(`${GIT_API_URL}/repos/${org}/${giteaRepoName}`, {
      headers: adminHeaders(false),
    });
    if (!resp.ok) {
      log(`[git] Project repo ${org}/${giteaRepoName} not found on Gitea (${resp.status}) — skipping clone`);
      return false;
    }
  } catch (err: any) {
    log(`⚠ [git] Gitea API check failed for ${org}/${giteaRepoName}: ${err.message}`);
    return false;
  }

  fs.mkdirSync(path.dirname(dest), { recursive: true });

  let result: string | null;
  if (hasCustomerKey) {
    const cloneUrl = sshRemoteUrl(org, giteaRepoName);
    result = gitExec(path.dirname(dest), `clone ${cloneUrl} ${projectSlug}`, sshKey);
  } else {
    const cloneUrl = httpCloneUrl(org, giteaRepoName);
    log(`[git] Cloning ${slug}/${projectSlug} via HTTP (no per-customer SSH key yet)`);
    result = gitExec(path.dirname(dest), `clone ${cloneUrl} ${projectSlug}`);
    if (result !== null) {
      gitExec(dest, `remote set-url origin ${sshRemoteUrl(org, giteaRepoName)}`);
    }
  }

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
  if (!GIT_API_TOKEN) {
    log(`[git] Skipping repo init for ${slug} — GIT_API_TOKEN not set`);
    return null;
  }

  const org = workspaceGiteaOrg(slug);
  const repoName = workspaceRepoName();

  const gitignore = [
    "# Octogee workspace — track user-visible files, exclude system/build artifacts",
    "",
    "# System files (provisioner-managed, not user-visible)",
    "AGENTS.md",
    "TOOLS.md",
    "PROJECTS.md",
    "HEARTBEAT.md",
    "_throttle.json",
    "customer-config.json",
    "crew-webhooks.json",
    "_pending_*.json",
    ".byot-managed",
    ".system/",
    ".openclaw/",
    ".ssh/",
    "brain/",
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
    "# SOUL.md, USER.md, MEMORY.md, memory/*, projects/*/src/",
  ].join("\n") + "\n";
  fs.writeFileSync(path.join(coachDir, ".gitignore"), gitignore, "utf-8");

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
    const resp = await fetch(`${GIT_API_URL}/orgs/${org}/repos`, {
      method: "POST",
      headers: adminHeaders(),
      body: JSON.stringify({
        name: repoName,
        private: true,
        description: `Octogee workspace for ${slug}`,
        auto_init: false,
      }),
    });

    if (!resp.ok && resp.status !== 409) {
      const body = await resp.text();
      log(`⚠ [git] Failed to create repo ${org}/${repoName}: ${resp.status} ${body}`);
      return null;
    }
  } catch (err) {
    log(`⚠ [git] Gitea API error creating repo: ${err}`);
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

export async function initProjectRepo(
  projectDir: string,
  slug: string,
  projectName: string,
  committerName = "Octogee",
  committerEmail = "octo@octogee.com",
): Promise<string | null> {
  if (!GIT_API_TOKEN) {
    log(`[git] Skipping project repo init for ${slug}/${projectName} — GIT_API_TOKEN not set`);
    return null;
  }

  const org = workspaceGiteaOrg(slug);
  const repoName = projectRepoName(projectName);
  const sshKey = customerSshKeyPath(slug);
  const keyArg = fs.existsSync(sshKey) ? sshKey : undefined;

  const gitignore = [
    "# Build artifacts",
    "node_modules/",
    ".astro/",
    "dist/",
    "",
    "# OS files",
    ".DS_Store",
  ].join("\n") + "\n";
  fs.writeFileSync(path.join(projectDir, ".gitignore"), gitignore, "utf-8");

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
    const resp = await fetch(`${GIT_API_URL}/orgs/${org}/repos`, {
      method: "POST",
      headers: adminHeaders(),
      body: JSON.stringify({
        name: repoName,
        private: true,
        description: `Octogee project: ${projectName} for ${slug}`,
        auto_init: false,
      }),
    });

    if (!resp.ok && resp.status !== 409) {
      const body = await resp.text();
      log(`⚠ [git] Failed to create project repo ${org}/${repoName}: ${resp.status} ${body}`);
      return null;
    }
  } catch (err) {
    log(`⚠ [git] Gitea API error creating project repo: ${err}`);
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

export async function syncAllWorkspaces(): Promise<void> {
  if (!GIT_API_TOKEN) return;
  if (!fs.existsSync(CUSTOMERS_DIR)) return;

  const slugs = fs.readdirSync(CUSTOMERS_DIR).filter(d =>
    fs.statSync(path.join(CUSTOMERS_DIR, d)).isDirectory()
  );

  for (const slug of slugs) {
    const coachDir = path.join(CUSTOMERS_DIR, slug);
    const gitDir = path.join(coachDir, ".git");
    if (!fs.existsSync(gitDir)) continue;

setRepoSshCommand(coachDir, slug);

    const sshKey = customerSshKeyPath(slug);
    const keyArg = fs.existsSync(sshKey) ? sshKey : undefined;

    const remoteCheck = ((): string | null => {
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
    })();
    if (remoteCheck === null) {
      dlog(`[git-sync] ${slug}: no remote — skipping (lifecycle contract will heal on next restore)`);
      continue;
    }

    if (remoteCheck.startsWith("http")) {
      gitExec(
        coachDir,
        `remote set-url origin ${sshRemoteUrl(workspaceGiteaOrg(slug), workspaceRepoName())}`,
      );
      log(`[git-sync] ${slug}: migrated remote to SSH`);
    }

    const status = gitExec(coachDir, "status --porcelain");
    let committed = false;
    if (status) {
      gitExec(coachDir, "add -A");
      committed = gitExec(coachDir, `commit -m "auto: ${new Date().toISOString()}"`) !== null;
    }

    const remoteMain = gitExec(coachDir, "ls-remote --heads origin main", keyArg);
    if (remoteMain) {
      gitExec(coachDir, "pull --rebase origin main", keyArg);
    }

    if (committed) {
      const pushResult = gitExec(coachDir, "push origin main", keyArg);
      if (pushResult !== null) {
        log(`[git-sync] ${slug}: pushed changes`);
      } else {
        log(`⚠ [git-sync] ${slug}: push failed`);
      }
    }
  }
}

export async function archiveWorkspaceRepo(slug: string): Promise<void> {
  if (!GIT_API_TOKEN) return;

  const org = workspaceGiteaOrg(slug);
  const repoName = workspaceRepoName();
  try {
    await fetch(`${GIT_API_URL}/repos/${org}/${repoName}`, {
      method: "PATCH",
      headers: adminHeaders(),
      body: JSON.stringify({ archived: true }),
    });
    log(`[git] Archived repo: ${org}/${repoName}`);
  } catch (err) {
    log(`⚠ [git] Failed to archive repo ${org}/${repoName}: ${err}`);
  }
}

export async function archiveProjectRepo(slug: string, projectName: string): Promise<void> {
  if (!GIT_API_TOKEN) return;

  const org = workspaceGiteaOrg(slug);
  const repoName = projectRepoName(projectName);
  try {
    await fetch(`${GIT_API_URL}/repos/${org}/${repoName}`, {
      method: "PATCH",
      headers: adminHeaders(),
      body: JSON.stringify({ archived: true }),
    });
    log(`[git] Archived project repo: ${org}/${repoName}`);
  } catch (err) {
    log(`⚠ [git] Failed to archive project repo ${org}/${repoName}: ${err}`);
  }
}
