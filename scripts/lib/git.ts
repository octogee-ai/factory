/**
 * Octogee Provisioner — Git Operations
 *
 * Per-customer SSH keys: each customer gets their own ed25519 keypair at
 * customers/{slug}/.ssh/id_ed25519. The key is registered as a user SSH key
 * on a per-customer Gitea user (ws-{slug}), which is a collaborator on
 * only that customer's repos.
 *
 * The provisioner uses the global GIT_API_TOKEN (admin) for repo creation,
 * user management, and deploy key registration. Git operations (clone, push,
 * pull) use per-customer SSH keys via GIT_SSH_COMMAND.
 */

import { execSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import { log, GIT_API_URL, GIT_API_TOKEN, GIT_ORG, GIT_SSH_HOST, CUSTOMERS_DIR } from "./config.js";

/** Admin API headers for Gitea. Content-Type included for POST/PUT/PATCH. */
function adminHeaders(includeContentType = true): Record<string, string> {
  return {
    Authorization: `token ${GIT_API_TOKEN}`,
    Accept: "application/json",
    ...(includeContentType ? { "Content-Type": "application/json" } : {}),
  };
}

// ── SSH Key Management ────────────────────────────────────────────────────────

/** Path to a customer's SSH private key. */
export function customerSshKeyPath(slug: string): string {
  return path.join(CUSTOMERS_DIR, slug, ".ssh", "id_ed25519");
}

/** Generate an SSH keypair for a customer. Returns the public key. */
export function generateCustomerSshKey(slug: string): string {
  const sshDir = path.join(CUSTOMERS_DIR, slug, ".ssh");
  const keyPath = path.join(sshDir, "id_ed25519");
  const pubPath = keyPath + ".pub";

  if (fs.existsSync(keyPath)) {
    log(`[git] SSH key already exists for ${slug}`);
    return fs.readFileSync(pubPath, "utf-8").trim();
  }

  fs.mkdirSync(sshDir, { recursive: true });
  execSync(`ssh-keygen -t ed25519 -N "" -f "${keyPath}" -C "octogee-${slug}@gateway" -q`, {
    stdio: "pipe",
  });
  // Harden permissions — prevent other customers' agents from reading
  fs.chmodSync(sshDir, 0o700);
  fs.chmodSync(keyPath, 0o600);
  fs.chmodSync(pubPath, 0o644);

  log(`[git] SSH keypair generated for ${slug}`);
  return fs.readFileSync(pubPath, "utf-8").trim();
}

// ── Gitea User Management (admin API — provisioner only) ──────────────────────

/** Gitea username for a customer workspace. */
export function giteaUsername(slug: string): string {
  return `ws-${slug}`;
}

/**
 * Create a per-customer Gitea user, add their SSH key, and generate an API token.
 * Returns the API token (personal access token) for the user.
 * Idempotent — if user already exists, recreates SSH key and token.
 */
export async function createGiteaUser(slug: string, pubKey: string): Promise<string | null> {
  if (!GIT_API_TOKEN) return null;

  const username = giteaUsername(slug);
  const password = crypto.randomBytes(32).toString("hex");
  const headers = adminHeaders();

  // 1. Create user (idempotent — 422 if exists)
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

  // 2. Add SSH key (delete existing first for idempotency)
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

  // 3. Generate personal access token (delete existing first via admin Sudo)
  const sudoHeaders = { ...headers, Sudo: username };
  const tokensResp = await fetch(`${GIT_API_URL}/users/${username}/tokens`, {
    method: "GET",
    headers: sudoHeaders,
  });
  if (tokensResp.ok) {
    const tokens = (await tokensResp.json()) as any[];
    for (const t of tokens) {
      if (t.name === "workspace-api") {
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
      name: "workspace-api",
      scopes: ["write:repository"],
    }),
  });
  if (!tokenResp.ok) {
    // Gitea's `POST /users/{name}/tokens` requires Basic Auth; admin token
    // + Sudo isn't accepted, so this returns 401 by design. The per-customer
    // SSH keypair registered above is the primary git auth path;
    // workspace-api falls back to the global admin token for REST calls.
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

/**
 * Grant a per-customer Gitea user collaborator access to a repo.
 * Called after repo creation and when sharing workspaces.
 */
export async function grantRepoAccess(repoName: string, slug: string, permission = "write"): Promise<void> {
  if (!GIT_API_TOKEN) return;

  const username = giteaUsername(slug);
  const resp = await fetch(`${GIT_API_URL}/repos/${GIT_ORG}/${repoName}/collaborators/${username}`, {
    method: "PUT",
    headers: adminHeaders(),
    body: JSON.stringify({ permission }),
  });

  if (resp.ok || resp.status === 204) {
    log(`[git] Granted ${permission} on ${repoName} to ${username}`);
  } else {
    const body = await resp.text();
    log(`⚠ [git] Failed to grant ${permission} on ${repoName} to ${username}: ${resp.status} ${body}`);
  }
}

/**
 * Delete a per-customer Gitea user. Cascades: removes SSH keys, tokens,
 * and all collaborator grants. Called during nuke.
 */
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

// ── Remote URLs ──────────────────────────────────────────────────────────────

/** SSH remote URL — requires per-customer key via GIT_SSH_COMMAND. */
function sshRemoteUrl(repoName: string): string {
  return `git@${GIT_SSH_HOST}:${GIT_ORG}/${repoName}.git`;
}

/** HTTP clone URL with admin token — used only by boot-sync for initial clone.
 *  The admin token is embedded in the URL for the clone, but the remote is
 *  immediately switched to SSH after clone (don't persist credentials). */
function httpCloneUrl(repoName: string): string {
  const gitHost = new URL(GIT_API_URL).origin;
  return `${gitHost.replace("://", `://octogee-admin:${GIT_API_TOKEN}@`)}/${GIT_ORG}/${repoName}.git`;
}

// ── Git Exec ────────────────────────────────────────────────────────────────────

/**
 * Run a git command in a directory.
 * When sshKeyPath is provided, sets GIT_SSH_COMMAND to use that specific key.
 * Returns stdout or null on failure.
 */
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
  } catch (err: any) {
    const stderr = err.stderr?.toString?.()?.trim() ?? "";
    const safeArgs = args.replace(/x-access-token:[^\s@]+/g, "x-access-token:***");
    const safeErr  = (stderr || err.message).replace(/x-access-token:[^\s@]+/g, "x-access-token:***");
    log(`⚠ [git] exec failed: git ${safeArgs} → ${safeErr}`);
    return null;
  }
}

// ── Clone Workspace Repo ────────────────────────────────────────────────────────

/**
 * Clone a customer workspace repo from Gitea to the local PVC.
 *
 * Uses per-customer SSH key if available. Falls back to HTTP clone
 * with the admin token (for boot-sync, where per-customer keys don't
 * exist yet). HTTP credentials are not persisted in the remote URL —
 * after clone, the remote is switched to SSH.
 */
export async function cloneWorkspaceRepo(slug: string, _repoUrl?: string): Promise<boolean> {
  const dest = path.join(CUSTOMERS_DIR, slug);
  const gitDir = path.join(dest, ".git");

  if (fs.existsSync(gitDir)) return true;

  if (!GIT_API_TOKEN) {
    log(`[git] Cannot clone ${slug} — GIT_API_TOKEN not set`);
    return false;
  }

  const repoName = `${slug}-workspace`;
  const sshKey = customerSshKeyPath(slug);
  const hasCustomerKey = fs.existsSync(sshKey);

  // Verify repo exists on Gitea
  try {
    const resp = await fetch(`${GIT_API_URL}/repos/${GIT_ORG}/${repoName}`, {
      headers: adminHeaders(false),
    });
    if (!resp.ok) {
      log(`[git] Repo ${GIT_ORG}/${repoName} not found on Gitea (${resp.status}) — skipping clone`);
      return false;
    }
  } catch (err: any) {
    log(`⚠ [git] Gitea API check failed for ${repoName}: ${err.message}`);
    return false;
  }

  // Clone: SSH with per-customer key if available, HTTP with admin token otherwise
  let result: string | null;
  if (hasCustomerKey) {
    const cloneUrl = sshRemoteUrl(repoName);
    result = gitExec(path.dirname(dest), `clone ${cloneUrl} ${slug}`, sshKey);
  } else {
    // HTTP clone for boot-sync (no per-customer key yet)
    const cloneUrl = httpCloneUrl(repoName);
    log(`[git] Cloning ${slug} via HTTP (no per-customer SSH key yet)`);
    result = gitExec(path.dirname(dest), `clone ${cloneUrl} ${slug}`);
    // Switch remote to SSH (don't persist admin token in remote URL)
    if (result !== null) {
      gitExec(dest, `remote set-url origin ${sshRemoteUrl(repoName)}`);
    }
  }

  if (result === null) {
    log(`⚠ [git] Clone failed for ${slug}`);
    try { fs.rmSync(dest, { recursive: true, force: true }); } catch {}
    return false;
  }

  gitExec(dest, `config user.email "${slug}@octogee.com"`);
  gitExec(dest, `config user.name "Octo (${slug})"`);

  log(`[git] ✅ Cloned ${GIT_ORG}/${repoName} → customers/${slug}/`);
  return true;
}

// ── Workspace Repo ──────────────────────────────────────────────────────────────

/** Initialize a git repo for a customer workspace and push to Gitea. */
export async function initWorkspaceRepo(coachDir: string, slug: string): Promise<string | null> {
  if (!GIT_API_TOKEN) {
    log(`[git] Skipping repo init for ${slug} — GIT_API_TOKEN not set`);
    return null;
  }

  const repoName = `${slug}-workspace`;
  const sshKey = customerSshKeyPath(slug);
  const keyArg = fs.existsSync(sshKey) ? sshKey : undefined;

  // Write .gitignore
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
  log(`[git] init: ${initResult ?? "FAILED"}`);
  gitExec(coachDir, `config user.email "${slug}@octogee.com"`);
  gitExec(coachDir, `config user.name "Octo (${slug})"`);
  const addResult = gitExec(coachDir, "add -A");
  log(`[git] add: ${addResult === "" ? "OK" : addResult ?? "FAILED"}`);
  const commitResult = gitExec(coachDir, 'commit -m "initial: workspace provisioned"');
  log(`[git] commit: ${commitResult?.substring(0, 80) ?? "FAILED"}`);

  // Create Gitea repo (admin token)
  try {
    const resp = await fetch(`${GIT_API_URL}/orgs/${GIT_ORG}/repos`, {
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
      log(`⚠ [git] Failed to create repo ${GIT_ORG}/${repoName}: ${resp.status} ${body}`);
      return null;
    }
  } catch (err) {
    log(`⚠ [git] Gitea API error creating repo: ${err}`);
    return null;
  }

  // Grant per-customer Gitea user access to the repo
  await grantRepoAccess(repoName, slug);

  // Add remote + push (SSH with per-customer key)
  const originUrl = sshRemoteUrl(repoName);
  const remoteResult = gitExec(coachDir, `remote add origin ${originUrl}`);
  log(`[git] remote add: ${remoteResult === "" ? "OK" : remoteResult ?? "FAILED"}`);
  const pushResult = gitExec(coachDir, "push -u origin main", keyArg);
  log(`[git] push: ${pushResult !== null ? "OK" : "FAILED"}`);

  if (pushResult === null) {
    log(`⚠ [git] Failed to push initial commit for ${slug}`);
    return null;
  }

  const gitHost = new URL(GIT_API_URL).origin;
  const repoUrlDisplay = `${gitHost}/${GIT_ORG}/${repoName}`;
  log(`[git] ✅ Workspace repo created: ${repoUrlDisplay}`);
  return repoUrlDisplay;
}

// ── Project Repo ────────────────────────────────────────────────────────────────

/** Initialize a git repo for a project and push to Gitea. */
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

  const repoName = `${slug}-${projectName}`;
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
  gitExec(projectDir, "add -A");
  const commitResult = gitExec(projectDir, `commit -m "initial: ${projectName} project created"`);
  if (commitResult === null) {
    log(`⚠ [git] Failed to create initial commit for project ${slug}/${projectName}`);
    return null;
  }

  // Create Gitea repo (admin token)
  try {
    const resp = await fetch(`${GIT_API_URL}/orgs/${GIT_ORG}/repos`, {
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
      log(`⚠ [git] Failed to create project repo ${GIT_ORG}/${repoName}: ${resp.status} ${body}`);
      return null;
    }
  } catch (err) {
    log(`⚠ [git] Gitea API error creating project repo: ${err}`);
    return null;
  }

  // Grant per-customer Gitea user access
  await grantRepoAccess(repoName, slug);

  const originUrl = sshRemoteUrl(repoName);
  gitExec(projectDir, `remote add origin ${originUrl}`);
  const pushResult = gitExec(projectDir, "push -u origin main", keyArg);
  log(`[git] project push: ${pushResult !== null ? "OK" : "FAILED"}`);

  if (pushResult === null) {
    log(`⚠ [git] Failed to push project ${slug}/${projectName}`);
    return null;
  }

  const gitHost = new URL(GIT_API_URL).origin;
  const repoUrlDisplay = `${gitHost}/${GIT_ORG}/${repoName}`;
  log(`[git] ✅ Project repo created: ${repoUrlDisplay}`);
  return repoUrlDisplay;
}

// ── Commit and Push ─────────────────────────────────────────────────────────

/** Stage all changes, commit, and push to origin main. */
export async function commitAndPush(repoDir: string, message: string): Promise<boolean> {
  // Derive slug from path: customers/{slug}/... → slug
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
  const commitResult = gitExec(repoDir, `commit -m "${message.replace(/"/g, '\\"')}"`);
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

// ── Sync All Workspaces ─────────────────────────────────────────────────────────

/** Sync all dirty workspaces to Gitea. Pulls remote changes. */
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

    const sshKey = customerSshKeyPath(slug);
    const keyArg = fs.existsSync(sshKey) ? sshKey : undefined;

    // If no remote, initialize
    const remoteCheck = gitExec(coachDir, "remote get-url origin");
    if (remoteCheck === null) {
      log(`[git-sync] ${slug}: no remote — initializing Gitea repo`);
      await initWorkspaceRepo(coachDir, slug);
      continue;
    }

    // Ensure remote uses SSH (migrate old HTTP remotes)
    if (remoteCheck.startsWith("http")) {
      const repoName = `${slug}-workspace`;
      gitExec(coachDir, `remote set-url origin ${sshRemoteUrl(repoName)}`);
      log(`[git-sync] ${slug}: migrated remote to SSH`);
    }

    const status = gitExec(coachDir, "status --porcelain");
    let committed = false;
    if (status) {
      gitExec(coachDir, "add -A");
      committed = gitExec(coachDir, `commit -m "auto: ${new Date().toISOString()}"`) !== null;
    }

    gitExec(coachDir, "pull --rebase origin main", keyArg);

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

// ── Archive Repos ───────────────────────────────────────────────────────────────

/** Archive a Gitea workspace repo. */
export async function archiveWorkspaceRepo(slug: string): Promise<void> {
  if (!GIT_API_TOKEN) return;

  const repoName = `${slug}-workspace`;
  try {
    await fetch(`${GIT_API_URL}/repos/${GIT_ORG}/${repoName}`, {
      method: "PATCH",
      headers: adminHeaders(),
      body: JSON.stringify({ archived: true }),
    });
    log(`[git] Archived repo: ${GIT_ORG}/${repoName}`);
  } catch (err) {
    log(`⚠ [git] Failed to archive repo ${repoName}: ${err}`);
  }
}

/** Archive a project Gitea repo. */
export async function archiveProjectRepo(slug: string, projectName: string): Promise<void> {
  if (!GIT_API_TOKEN) return;

  const repoName = `${slug}-${projectName}`;
  try {
    await fetch(`${GIT_API_URL}/repos/${GIT_ORG}/${repoName}`, {
      method: "PATCH",
      headers: adminHeaders(),
      body: JSON.stringify({ archived: true }),
    });
    log(`[git] Archived project repo: ${GIT_ORG}/${repoName}`);
  } catch (err) {
    log(`⚠ [git] Failed to archive project repo ${repoName}: ${err}`);
  }
}

// ── Delete Repo (Nuke) ──────────────────────────────────────────────────────

/** Permanently delete a Gitea repo. Irreversible. Idempotent. */
export async function deleteRepo(repoName: string): Promise<void> {
  if (!GIT_API_TOKEN || !GIT_ORG) return;

  const resp = await fetch(`${GIT_API_URL}/repos/${GIT_ORG}/${repoName}`, {
    method: "DELETE",
    headers: adminHeaders(false),
  });

  if (resp.status === 204 || resp.status === 404) {
    log(`[git-nuke] Repo ${GIT_ORG}/${repoName} deleted (or already gone)`);
  } else {
    log(`⚠ [git-nuke] Failed to delete repo ${repoName}: ${resp.status}`);
  }
}
