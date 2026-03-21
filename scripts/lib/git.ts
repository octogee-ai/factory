/**
 * Octogee Provisioner — Git Operations
 */

import { execSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { log, GIT_API_URL, GIT_API_TOKEN, GIT_ORG, CUSTOMERS_DIR } from "./config.js";

// ── Git Exec ────────────────────────────────────────────────────────────────────

/** Run a git command in a directory. Returns stdout or null on failure. */
export function gitExec(cwd: string, args: string): string | null {
  try {
    return execSync(`git ${args}`, {
      cwd,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    }).trim();
  } catch (err: any) {
    const stderr = err.stderr?.toString?.()?.trim() ?? "";
    const safeArgs = args.replace(/x-access-token:[^\s@]+/g, "x-access-token:***");
    const safeErr  = (stderr || err.message).replace(/x-access-token:[^\s@]+/g, "x-access-token:***");
    log(`⚠ [git] exec failed: git ${safeArgs} → ${safeErr}`);
    return null;
  }
}

// ── Workspace Repo ──────────────────────────────────────────────────────────────

/** Initialize a git repo for a customer workspace and push to Gitea. */
export async function initWorkspaceRepo(coachDir: string, slug: string): Promise<string | null> {
  if (!GIT_API_TOKEN) {
    log(`[git] Skipping repo init for ${slug} — GIT_API_TOKEN not set`);
    return null;
  }

  const repoName = `${slug}-workspace`;

  // Write .gitignore — flat workspace layout
  const gitignore = [
    "# Octogee workspace — track user-visible files, exclude system/build artifacts",
    "",
    "# System files (provisioner-managed, not user-visible)",
    "AGENTS.md",
    "TOOLS.md",
    "PROJECTS.md",
    "HEARTBEAT.md",
    // IDENTITY.md removed (Issue #23) — not used by OpenClaw, redundant with SOUL.md
    "_throttle.json",
    "customer-config.json",
    "crew-webhooks.json",
    "_pending_*.json",
    ".system/",
    ".openclaw/",
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
  gitExec(coachDir, 'config user.email "octo@octogee.com"');
  gitExec(coachDir, 'config user.name "Octogee"');
  const addResult = gitExec(coachDir, "add -A");
  log(`[git] add: ${addResult === "" ? "OK" : addResult ?? "FAILED"}`);
  const commitResult = gitExec(coachDir, 'commit -m "initial: workspace provisioned"');
  log(`[git] commit: ${commitResult?.substring(0, 80) ?? "FAILED"}`);

  // Create Gitea repo
  try {
    const resp = await fetch(`${GIT_API_URL}/orgs/${GIT_ORG}/repos`, {
      method: "POST",
      headers: {
        Authorization: `token ${GIT_API_TOKEN}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        name: repoName,
        private: true,
        description: `Octogee workspace for ${slug}`,
        auto_init: false,
      }),
    });

    if (!resp.ok && resp.status !== 409) { // Gitea uses 409 for existing repo
      const body = await resp.text();
      log(`⚠ [git] Failed to create repo ${GIT_ORG}/${repoName}: ${resp.status} ${body}`);
      return null;
    }
  } catch (err) {
    log(`⚠ [git] Gitea API error creating repo: ${err}`);
    return null;
  }

  // Add remote + push (Gitea internal URL with auth)
  const gitHost = new URL(GIT_API_URL).origin;
  const remoteUrl = `${gitHost.replace("://", `://octogee-admin:${GIT_API_TOKEN}@`)}/${GIT_ORG}/${repoName}.git`;
  const remoteResult = gitExec(coachDir, `remote add origin ${remoteUrl}`);
  log(`[git] remote add: ${remoteResult === "" ? "OK" : remoteResult ?? "FAILED"}`);
  const pushResult = gitExec(coachDir, "push -u origin main");
  log(`[git] push: ${pushResult !== null ? "OK" : "FAILED"}`);

  if (pushResult === null) {
    log(`⚠ [git] Failed to push initial commit for ${slug}`);
    return null;
  }

  const repoUrl = `${gitHost}/${GIT_ORG}/${repoName}`;
  log(`[git] ✅ Workspace repo created: ${repoUrl}`);
  return repoUrl;
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

  // Create Gitea repo
  try {
    const resp = await fetch(`${GIT_API_URL}/orgs/${GIT_ORG}/repos`, {
      method: "POST",
      headers: {
        Authorization: `token ${GIT_API_TOKEN}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        name: repoName,
        private: true,
        description: `Octogee project: ${projectName} for ${slug}`,
        auto_init: false,
      }),
    });

    if (!resp.ok && resp.status !== 409) { // Gitea uses 409 for existing repo
      const body = await resp.text();
      log(`⚠ [git] Failed to create project repo ${GIT_ORG}/${repoName}: ${resp.status} ${body}`);
      return null;
    }
  } catch (err) {
    log(`⚠ [git] Gitea API error creating project repo: ${err}`);
    return null;
  }

  const gitHost = new URL(GIT_API_URL).origin;
  const remoteUrl = `${gitHost.replace("://", `://octogee-admin:${GIT_API_TOKEN}@`)}/${GIT_ORG}/${repoName}.git`;
  gitExec(projectDir, `remote add origin ${remoteUrl}`);
  const pushResult = gitExec(projectDir, "push -u origin main");
  log(`[git] project push: ${pushResult !== null ? "OK" : "FAILED"}`);

  if (pushResult === null) {
    log(`⚠ [git] Failed to push project ${slug}/${projectName}`);
    return null;
  }

  const repoUrl = `${gitHost}/${GIT_ORG}/${repoName}`;
  log(`[git] ✅ Project repo created: ${repoUrl}`);
  return repoUrl;
}

// ── Commit and Push ─────────────────────────────────────────────────────────

/** Stage all changes, commit, and push to origin main. Returns true on success. */
export async function commitAndPush(repoDir: string, message: string): Promise<boolean> {
  if (!GIT_API_TOKEN) {
    log(`[git] Skipping commitAndPush — GIT_API_TOKEN not set`);
    return false;
  }
  const status = gitExec(repoDir, "status --porcelain");
  if (!status) {
    log(`[git] commitAndPush: nothing to commit in ${repoDir}`);
    return true; // nothing to do is success
  }
  gitExec(repoDir, "add -A");
  const commitResult = gitExec(repoDir, `commit -m "${message.replace(/"/g, '\\"')}"`);
  if (commitResult === null) {
    log(`⚠ [git] commitAndPush: commit failed in ${repoDir}`);
    return false;
  }
  const pushResult = gitExec(repoDir, "push origin main");
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

    // If no remote is set, the workspace was provisioned before Gitea was available.
    // Initialize the remote now so subsequent syncs work correctly.
    const remoteCheck = gitExec(coachDir, "remote get-url origin");
    if (remoteCheck === null) {
      log(`[git-sync] ${slug}: no remote — initializing Gitea repo`);
      await initWorkspaceRepo(coachDir, slug);
      continue; // initWorkspaceRepo commits + pushes; skip normal sync this cycle
    }

    const status = gitExec(coachDir, "status --porcelain");
    let committed = false;
    if (status) {
      gitExec(coachDir, "add -A");
      committed = gitExec(coachDir, `commit -m "auto: ${new Date().toISOString()}"`) !== null;
    }

    gitExec(coachDir, "pull --rebase origin main");

    if (committed) {
      const pushResult = gitExec(coachDir, "push origin main");
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
      headers: {
        Authorization: `token ${GIT_API_TOKEN}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
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
      headers: {
        Authorization: `token ${GIT_API_TOKEN}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({ archived: true }),
    });
    log(`[git] Archived project repo: ${GIT_ORG}/${repoName}`);
  } catch (err) {
    log(`⚠ [git] Failed to archive project repo ${repoName}: ${err}`);
  }
}

// ── Delete Repo (Nuke) ──────────────────────────────────────────────────────

/**
 * Permanently delete a Gitea repo. Irreversible.
 * Idempotent: 404 is treated as success.
 */
export async function deleteRepo(repoName: string): Promise<void> {
  if (!GIT_API_TOKEN || !GIT_ORG) return;

  const resp = await fetch(`${GIT_API_URL}/repos/${GIT_ORG}/${repoName}`, {
    method: "DELETE",
    headers: {
      Authorization: `token ${GIT_API_TOKEN}`,
      Accept: "application/json",
    },
  });

  if (resp.status === 204 || resp.status === 404) {
    log(`[git-nuke] Repo ${GIT_ORG}/${repoName} deleted (or already gone)`);
  } else {
    log(`⚠ [git-nuke] Failed to delete repo ${repoName}: ${resp.status}`);
  }
}
