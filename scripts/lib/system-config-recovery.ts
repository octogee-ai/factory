import fs from "node:fs";
import path from "node:path";

import { customerSshKeyPath, gitExec as defaultGitExec } from "./git.js";
import {
  assertPlatformInvariants,
  reconcilePlatformInvariants,
} from "./system-config-invariants.js";
import {
  assertSystemConfigGitignore,
  assertSystemConfigMetadata,
  SYSTEM_CONFIG_GITIGNORE_FILENAME,
  SYSTEM_CONFIG_METADATA_FILENAME,
} from "./system-config-durable-files.js";

type GitExec = typeof defaultGitExec;
const GIT_SHA_RE = /^[0-9a-f]{40,64}$/;

export type SystemConfigCommitSource =
  | "auto-watch"
  | "boot-migration"
  | "recovery"
  | "migration-checkpoint"
  | "migration-restore";

export type SystemConfigRecoveryResult =
  | { outcome: "accepted"; acceptedCommit: string }
  | {
      outcome: "recovered";
      rejectedCommit: string;
      recoveredFromCommit: string;
      acceptedCommit: string;
    }
  | { outcome: "unavailable"; rejectedCommit: string; errorCode?: string };

interface SystemConfigRecoveryOptions {
  slug: string;
  openclawDir: string;
  repoDir: string;
  configPath: string;
  env?: NodeJS.ProcessEnv;
  gitExec?: GitExec;
  validateConfig: (configPath: string) => void;
  now?: () => Date;
  keyPath?: string;
  acceptCurrent?: boolean;
}

interface DurableCandidate {
  config: string;
  metadata: string;
  gitignore: string;
}

function parseConfig(contents: string): Record<string, unknown> {
  const parsed = JSON.parse(contents) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("openclaw.json must contain an object");
  }
  return parsed as Record<string, unknown>;
}

function atomicWrite(filePath: string, contents: string): void {
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, contents, { mode: 0o600 });
  fs.renameSync(tmp, filePath);
  fs.chmodSync(filePath, 0o600);
}

function safeTrailerValue(value: string | undefined): string {
  const normalized = value?.trim().replace(/[^A-Za-z0-9._-]/g, "_");
  return normalized || "unknown";
}

export function attributedCommitArgs(
  subject: string,
  source: SystemConfigCommitSource,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return [
    "commit",
    `-m "${subject.replace(/["\\]/g, "_")}"`,
    `-m "Octogee-Config-Source: ${source}\nOctogee-Gateway-Revision: ${safeTrailerValue(env.GATEWAY_REVISION_ID)}\nOpenClaw-Version: ${safeTrailerValue(env.OPENCLAW_VERSION)}"`,
  ].join(" ");
}

function normalizedCandidate(
  candidate: DurableCandidate,
  candidatePath: string,
  env: NodeJS.ProcessEnv,
  validateConfig: (configPath: string) => void,
  reconcile: boolean,
): string | null {
  try {
    assertSystemConfigMetadata(candidate.metadata);
    assertSystemConfigGitignore(candidate.gitignore);
    const config = parseConfig(candidate.config);
    if (reconcile) reconcilePlatformInvariants(config, env);
    assertPlatformInvariants(config, env);
    let normalized = candidate.config;
    if (reconcile) {
      normalized = `${JSON.stringify(config, null, 2)}\n`;
    } else if (!candidate.config.endsWith("\n")) {
      normalized = `${candidate.config}\n`;
    }
    atomicWrite(candidatePath, normalized);
    validateConfig(candidatePath);
    return normalized;
  } catch {
    return null;
  } finally {
    fs.rmSync(candidatePath, { force: true });
  }
}

interface RecoveryHistoryContext {
  options: SystemConfigRecoveryOptions;
  env: NodeJS.ProcessEnv;
  execGit: GitExec;
  keyPath: string;
  rejectedCommit: string;
  candidatePath: string;
  history: string;
}

function historyCandidate(
  options: SystemConfigRecoveryOptions,
  execGit: GitExec,
  keyPath: string,
  commit: string,
): DurableCandidate | null {
  const config = execGit(options.repoDir, `show ${commit}:openclaw.json`, keyPath);
  const metadata = execGit(
    options.repoDir,
    `show ${commit}:${SYSTEM_CONFIG_METADATA_FILENAME}`,
    keyPath,
  );
  const gitignore = execGit(
    options.repoDir,
    `show ${commit}:${SYSTEM_CONFIG_GITIGNORE_FILENAME}`,
    keyPath,
  );
  if (config === null || metadata === null || gitignore === null) return null;
  return { config, metadata, gitignore };
}

function recoverFromHistory(context: RecoveryHistoryContext): SystemConfigRecoveryResult {
  const { options, env, execGit, keyPath, rejectedCommit, candidatePath, history } = context;
  for (const commit of history.split("\n").map((value) => value.trim()).filter(Boolean).slice(1)) {
    if (!GIT_SHA_RE.test(commit)) continue;
    const candidate = historyCandidate(options, execGit, keyPath, commit);
    if (!candidate) continue;
    const normalized = normalizedCandidate(candidate, candidatePath, env, options.validateConfig, true);
    if (normalized === null) continue;
    atomicWrite(options.configPath, normalized);
    atomicWrite(path.join(options.repoDir, SYSTEM_CONFIG_METADATA_FILENAME), candidate.metadata);
    atomicWrite(path.join(options.repoDir, SYSTEM_CONFIG_GITIGNORE_FILENAME), candidate.gitignore);
    if (execGit(
      options.repoDir,
      `add openclaw.json ${SYSTEM_CONFIG_METADATA_FILENAME} ${SYSTEM_CONFIG_GITIGNORE_FILENAME}`,
      keyPath,
    ) === null) {
      return { outcome: "unavailable", rejectedCommit, errorCode: "recovery-stage-failed" };
    }
    const stamp = (options.now ?? (() => new Date()))().toISOString();
    const commitArgs = attributedCommitArgs(
      `recovery: restore accepted openclaw config ${stamp}`,
      "recovery",
      env,
    );
    if (execGit(options.repoDir, commitArgs, keyPath) === null) {
      return { outcome: "unavailable", rejectedCommit, errorCode: "recovery-commit-failed" };
    }
    if (execGit(options.repoDir, "push origin main", keyPath) === null) {
      return { outcome: "unavailable", rejectedCommit, errorCode: "recovery-push-failed" };
    }
    const acceptedCommit = execGit(options.repoDir, "rev-parse HEAD", keyPath);
    if (!acceptedCommit) {
      return { outcome: "unavailable", rejectedCommit, errorCode: "recovery-head-unavailable" };
    }
    return {
      outcome: "recovered",
      rejectedCommit,
      recoveredFromCommit: commit,
      acceptedCommit,
    };
  }
  return { outcome: "unavailable", rejectedCommit };
}

export function recoverSystemConfigHead(
  options: SystemConfigRecoveryOptions,
): SystemConfigRecoveryResult {
  const env = options.env ?? process.env;
  const execGit = options.gitExec ?? defaultGitExec;
  const keyPath = options.keyPath ?? customerSshKeyPath(options.slug);
  const rejectedCommit = execGit(options.repoDir, "rev-parse HEAD", keyPath);
  if (!rejectedCommit) {
    return { outcome: "unavailable", rejectedCommit: "unknown", errorCode: "head-unavailable" };
  }
  const candidatePath = path.join(options.openclawDir, "system_config.recovery-candidate.json");
  if (options.acceptCurrent !== false) {
    try {
      const current = {
        config: fs.readFileSync(options.configPath, "utf8"),
        metadata: fs.readFileSync(
          path.join(options.repoDir, SYSTEM_CONFIG_METADATA_FILENAME),
          "utf8",
        ),
        gitignore: fs.readFileSync(
          path.join(options.repoDir, SYSTEM_CONFIG_GITIGNORE_FILENAME),
          "utf8",
        ),
      };
      if (normalizedCandidate(current, candidatePath, env, options.validateConfig, false)) {
        return { outcome: "accepted", acceptedCommit: rejectedCommit };
      }
    } catch {
      fs.rmSync(candidatePath, { force: true });
    }
  }

  const history = execGit(options.repoDir, "rev-list HEAD", keyPath);
  if (history === null) {
    return { outcome: "unavailable", rejectedCommit, errorCode: "history-unavailable" };
  }
  return recoverFromHistory({
    options,
    env,
    execGit,
    keyPath,
    rejectedCommit,
    candidatePath,
    history,
  });
}
