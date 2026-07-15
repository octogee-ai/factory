import fs from "node:fs";
import path from "node:path";

import { customerSshKeyPath, gitExec as defaultGitExec } from "./git.js";
import {
  assertPlatformInvariants,
  reconcilePlatformInvariants,
} from "./system-config-invariants.js";

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
  contents: string,
  candidatePath: string,
  env: NodeJS.ProcessEnv,
  validateConfig: (configPath: string) => void,
  reconcile: boolean,
): string | null {
  try {
    const config = parseConfig(contents);
    if (reconcile) reconcilePlatformInvariants(config, env);
    assertPlatformInvariants(config, env);
    let normalized = contents;
    if (reconcile) {
      normalized = `${JSON.stringify(config, null, 2)}\n`;
    } else if (!contents.endsWith("\n")) {
      normalized = `${contents}\n`;
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

function recoverFromHistory(context: RecoveryHistoryContext): SystemConfigRecoveryResult {
  const { options, env, execGit, keyPath, rejectedCommit, candidatePath, history } = context;
  for (const commit of history.split("\n").map((value) => value.trim()).filter(Boolean).slice(1)) {
    if (!GIT_SHA_RE.test(commit)) continue;
    const contents = execGit(options.repoDir, `show ${commit}:openclaw.json`, keyPath);
    if (contents === null) continue;
    const normalized = normalizedCandidate(contents, candidatePath, env, options.validateConfig, true);
    if (normalized === null) continue;
    atomicWrite(options.configPath, normalized);
    if (execGit(options.repoDir, "add openclaw.json", keyPath) === null) {
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
  const current = fs.readFileSync(options.configPath, "utf8");
  if (normalizedCandidate(current, candidatePath, env, options.validateConfig, false)) {
    return { outcome: "accepted", acceptedCommit: rejectedCommit };
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
