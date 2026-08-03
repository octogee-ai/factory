import { createHash } from "node:crypto";
import * as fs from "fs";
import * as path from "path";

import {
  acquireSystemConfigSyncLeaseSync,
} from "@octogee/core/system-config-mutation-lease";

import { isValidUsername } from "../../shared/types/identity.js";
import {
  log as defaultLog,
  OPENCLAW_DIR,
  TEMPLATES_DIR,
  GIT_SSH_HOST,
} from "./config.js";
import {
  createGiteaUser,
  generateCustomerSshKey,
  gitExec,
  customerSshKeyPath,
  setRepoSshCommand,
} from "./git.js";
import {
  systemConfigRepoName,
  workspaceGiteaOrg,
} from "./gitea-naming.js";
import {
  ensureGiteaOrgForWorkspace,
  ensureSystemConfigRepo,
} from "./gitea-admin-broker-client.js";
import { systemConfigFingerprint } from "./system-config-watcher.js";
import {
  mattermostAccountSecretRef,
  updateMattermostAccountSecrets,
} from "./mattermost-account-secrets.js";
import {
  PlatformInvariantPolicyError,
  assertPlatformInvariants,
  reconcilePlatformInvariants,
} from "./system-config-invariants.js";
import {
  attributedCommitArgs,
  convergeSystemConfigToRemoteCommit,
  recoverSystemConfigHead,
  type SystemConfigCommitSource,
  type SystemConfigRecoveryResult,
  type SystemConfigRemoteConvergenceOptions,
  type SystemConfigRemoteConvergenceResult,
} from "./system-config-recovery.js";
import {
  readSystemConfigStatus,
  updateSystemConfigStatus,
} from "./system-config-status.js";
import {
  assertSystemConfigGitignore,
  assertSystemConfigMetadata,
  readSystemConfigCommitBlob,
  SYSTEM_CONFIG_LEGACY_MAC_STATE_CLEANUP,
  type ReadSystemConfigCommitBlob,
  type SystemConfigDurableFilename,
  SYSTEM_CONFIG_DURABLE_FILENAMES,
} from "./system-config-durable-files.js";

type UnknownRecord = Record<string, unknown>;

function acceptRuntimeManagedConfig(): void {
  return;
}

const CURRENT_SYSTEM_CONFIG_SCHEMA_VERSION = 1;
const SYSTEM_CONFIG_PATHSPEC_ARGS = ["openclaw.json", ".octogee.json", ".gitignore"];
const SYSTEM_CONFIG_GITIGNORE = "*.bak\n*.tmp\n";
const GIT_SHA_RE = /^[0-9a-f]{40,64}$/;
const OPENCLAW_CONFIG_FILENAME = "openclaw.json";
const SYSTEM_CONFIG_METADATA_FILENAME = ".octogee.json";
const SYSTEM_CONFIG_GITIGNORE_FILENAME = ".gitignore";
const GIT_REV_PARSE_HEAD = ["rev-parse", "HEAD"];
const MAIN_REF = "refs/heads/main";
const ACCEPTED_HEAD_UNAVAILABLE = "accepted-head-unavailable";
const VALIDATION_RESTORE_FAILED = "validation-restore-failed";

function fingerprintContents(contents: Buffer): string {
  return createHash("sha256").update(contents).digest("hex");
}

export interface SystemConfigRestoreResult {
  skipped?: string;
  seeded: boolean;
  restored: boolean;
  configPath?: string;
}

export interface SystemConfigSyncResult {
  skipped?: string;
  committed: boolean;
  pushed: boolean;
  pending?: boolean;
  processedFingerprint?: string;
  rejected?: boolean;
  errorCode?: string;
  policyPaths?: string[];
  acceptedCommit?: string;
  configHash?: string;
}

interface SystemConfigRestoreOptions {
  openclawDir?: string;
  templatePath?: string;
  env?: NodeJS.ProcessEnv;
  log?: (msg: string) => void;
  recover?: typeof recoverSystemConfigHead;
  validateConfig?: (configPath: string) => void;
}

export interface SystemConfigSyncOptions {
  openclawDir?: string;
  now?: () => Date;
  log?: (msg: string) => void;
  gitExec?: typeof gitExec;
  setRepoSshCommand?: typeof setRepoSshCommand;
  customerSshKeyPath?: typeof customerSshKeyPath;
  validateConfig?: (configPath: string) => void;
  durablePolicy?: boolean;
  env?: NodeJS.ProcessEnv;
  source?: SystemConfigCommitSource;
  lockHeld?: boolean;
  readCommitBlob?: ReadSystemConfigCommitBlob;
  expectedRemoteCommit?: string;
  convergeRemoteCommit?: (
    options: SystemConfigRemoteConvergenceOptions,
  ) => SystemConfigRemoteConvergenceResult;
}

interface SystemConfigAuditOptions {
  openclawDir?: string;
  gitExec?: typeof gitExec;
  customerSshKeyPath?: typeof customerSshKeyPath;
}

export interface SystemConfigAuditResult {
  state: "clean" | "dirty" | "error" | "unavailable";
  needsSync: boolean;
  head?: string;
  remoteHead?: string;
  headTree?: string;
  indexTree?: string;
  worktreeDirty?: boolean;
  configHash?: string;
  errorCode?: string;
}

export type SystemConfigBootCheckpointResult =
  | {
      ready: true;
      acceptedCommit: string;
      recoveredFromCommit?: string;
    }
  | { ready: false; errorCode: string; rejectedCommit?: string };

interface SystemConfigBootCheckpointOptions {
  openclawDir?: string;
  env?: NodeJS.ProcessEnv;
  log?: (message: string) => void;
  validateConfig: (configPath: string) => void;
  recover?: typeof recoverSystemConfigHead;
  sync?: typeof syncSystemConfigForSlug;
  now?: () => Date;
  doctorResult?: "ok" | "error";
  verifyAcceptedDurableSet?: (repoDir: string, acceptedCommit: string) => boolean;
}

export function systemConfigDir(openclawDir = OPENCLAW_DIR): string {
  return path.join(openclawDir, "system_config");
}

export function systemConfigPath(openclawDir = OPENCLAW_DIR): string {
  return path.join(systemConfigDir(openclawDir), OPENCLAW_CONFIG_FILENAME);
}

function remoteUrl(slug: string): string {
  return `git@${GIT_SSH_HOST}:${workspaceGiteaOrg(slug)}/${systemConfigRepoName()}.git`;
}

function atomicWrite(filePath: string, contents: string | Buffer, mode = 0o600): void {
  const tmp = `${filePath}.tmp`;
  const fd = fs.openSync(
    tmp,
    fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC,
    mode,
  );
  try {
    fs.writeFileSync(fd, contents);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, filePath);
}

function asRecord(value: unknown): UnknownRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as UnknownRecord
    : null;
}

function readSystemConfigMetadata(filePath: string): UnknownRecord | undefined {
  if (!fs.existsSync(filePath)) return undefined;
  try {
    const value = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    const metadata = asRecord(value);
    if (!metadata || !Number.isInteger(metadata.schemaVersion)) {
      throw new Error("schemaVersion must be an integer");
    }
    if (metadata.pendingStateCleanup !== undefined &&
        metadata.pendingStateCleanup !== SYSTEM_CONFIG_LEGACY_MAC_STATE_CLEANUP) {
      throw new Error("pendingStateCleanup is invalid");
    }
    return metadata;
  } catch {
    throw new Error(`[system_config] invalid system_config metadata at ${filePath}`);
  }
}

function recordString(record: UnknownRecord, key: string): string {
  const value = record[key];
  return typeof value === "string" ? value : "";
}

function legacyMacAgentIds(env: NodeJS.ProcessEnv): Set<string> {
  const ids = new Set(["${OPERATOR_AGENT_ID}", "octogee-ops-${GATEWAY_ID}"]);
  for (const value of [
    env.OPERATOR_AGENT_ID,
    env.GATEWAY_ID,
    env.GATEWAY_BUILDER_SLUG,
    env.OPERATOR_AGENT_SLUG,
  ]) {
    if (!value) continue;
    ids.add(value.startsWith("octogee-ops-") ? value : `octogee-ops-${value}`);
  }
  return ids;
}

function isLegacyMacAgent(agent: UnknownRecord, exactIds: ReadonlySet<string>): boolean {
  const id = recordString(agent, "id");
  if (exactIds.has(id)) return true;
  const identity = asRecord(agent.identity);
  return id.startsWith("octogee-ops-") &&
    recordString(identity ?? {}, "name") === "Mac" &&
    recordString(agent, "workspace") === "/home/node/.openclaw/workspace/ops";
}

function removeLegacyMacAgents(
  agents: UnknownRecord | null,
  env: NodeJS.ProcessEnv,
): { changed: boolean; removedIds: Set<string> } {
  const removedIds = new Set<string>();
  if (!Array.isArray(agents?.list)) return { changed: false, removedIds };
  const exactIds = legacyMacAgentIds(env);
  const kept = agents.list.filter((entry) => {
    const agent = asRecord(entry);
    if (!agent || !isLegacyMacAgent(agent, exactIds)) return true;
    const id = recordString(agent, "id");
    if (id) removedIds.add(id);
    return false;
  });
  const changed = kept.length !== agents.list.length;
  if (changed) agents.list = kept;
  return { changed, removedIds };
}

function removeLegacyMacBindings(
  config: UnknownRecord,
  legacyIds: ReadonlySet<string>,
): boolean {
  if (!Array.isArray(config.bindings)) return false;
  const kept = config.bindings.filter((entry) => {
    const binding = asRecord(entry);
    return binding === null || !legacyIds.has(recordString(binding, "agentId"));
  });
  const changed = kept.length !== config.bindings.length;
  if (changed) config.bindings = kept;
  return changed;
}

function removeDefaultMattermostAccount(
  mattermost: UnknownRecord | null,
  accounts: UnknownRecord | null,
  removeDefaultAccount: boolean,
): boolean {
  let defaultChanged = false;
  if (removeDefaultAccount && accounts && Object.prototype.hasOwnProperty.call(accounts, "default")) {
    delete accounts.default;
    defaultChanged = true;
  }
  if (removeDefaultAccount && mattermost?.defaultAccount === "default") {
    delete mattermost.defaultAccount;
    defaultChanged = true;
  }
  return defaultChanged;
}

function removeLegacyMattermostTokens(
  mattermost: UnknownRecord | null,
): boolean {
  let tokenChanged = false;
  for (const key of ["botToken", "token"]) {
    if (mattermost?.[key] === "${MM_BOT_TOKEN}") {
      delete mattermost[key];
      tokenChanged = true;
    }
  }
  return tokenChanged;
}

function removeLegacyMattermostConfig(
  config: UnknownRecord,
): boolean {
  const mattermost = asRecord(asRecord(config.channels)?.mattermost);
  const accounts = asRecord(mattermost?.accounts);
  const defaultAccount = asRecord(accounts?.default);
  const commands = asRecord(defaultAccount?.commands);
  const removeDefaultAccount = mattermost?.defaultAccount === "default" &&
    defaultAccount?.botToken === "${MM_BOT_TOKEN}" &&
    Object.keys(defaultAccount).sort().join(",") === "botToken,commands" &&
    commands?.native === false &&
    Object.keys(commands).length === 1;
  const defaultChanged = removeDefaultMattermostAccount(
    mattermost,
    accounts,
    removeDefaultAccount,
  );
  const tokenChanged = removeLegacyMattermostTokens(mattermost);
  return defaultChanged || tokenChanged;
}

function selectBuilderCoach(
  agents: UnknownRecord | null,
  env: NodeJS.ProcessEnv,
): boolean {
  const builderSlug = env.GATEWAY_BUILDER_SLUG?.trim();
  const builderCoachId = builderSlug ? `octogee-${builderSlug}-coach` : "";
  const builderCoach = Array.isArray(agents?.list)
    ? agents.list.find((entry) => asRecord(entry)?.id === builderCoachId)
    : undefined;
  const coach = asRecord(builderCoach);
  if (!coach || coach.default === true) return false;
  coach.default = true;
  return true;
}

export function removeLegacyMacConfig(
  config: UnknownRecord,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const agents = asRecord(config.agents);
  const removed = removeLegacyMacAgents(agents, env);
  const bindingIds = new Set([...legacyMacAgentIds(env), ...removed.removedIds]);
  const bindingsChanged = removeLegacyMacBindings(config, bindingIds);
  const mattermostChanged = removeLegacyMattermostConfig(config);
  const builderCoachChanged = selectBuilderCoach(agents, env);
  return removed.changed || bindingsChanged || mattermostChanged || builderCoachChanged;
}

export function removeLegacyMacState(
  openclawDir: string,
  env: NodeJS.ProcessEnv = process.env,
): void {
  for (const agentId of legacyMacAgentIds(env)) {
    if (!agentId.startsWith("octogee-ops-") || agentId.includes("${")) continue;
    fs.rmSync(path.join(openclawDir, "agents", agentId), { recursive: true, force: true });
    for (const suffix of [".sqlite", ".sqlite-wal", ".sqlite-shm"]) {
      fs.rmSync(path.join(openclawDir, "memory", `${agentId}${suffix}`), { force: true });
    }
  }
}

function legacyMacStateCleanupPending(openclawDir: string): boolean {
  const metadata = readSystemConfigMetadata(
    path.join(systemConfigDir(openclawDir), SYSTEM_CONFIG_METADATA_FILENAME),
  );
  return metadata?.pendingStateCleanup === SYSTEM_CONFIG_LEGACY_MAC_STATE_CLEANUP;
}

function clearLegacyMacStateCleanup(openclawDir: string): void {
  const metadataPath = path.join(systemConfigDir(openclawDir), SYSTEM_CONFIG_METADATA_FILENAME);
  const metadata = readSystemConfigMetadata(metadataPath);
  if (metadata?.pendingStateCleanup !== SYSTEM_CONFIG_LEGACY_MAC_STATE_CLEANUP) return;
  delete metadata.pendingStateCleanup;
  atomicWrite(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`);
}

async function ensureIdentityAndRepo(slug: string, log: (msg: string) => void): Promise<void> {
  const pubKey = generateCustomerSshKey(slug);
  await createGiteaUser(slug, pubKey);
  await ensureGiteaOrgForWorkspace(slug);
  await ensureSystemConfigRepo(slug);
  log(`[system_config] broker ensured Gitea user/org/${systemConfigRepoName()} for ${slug}`);
}

function retainedSeedGitStateMatches(repoDir: string, keyPath: string): boolean {
  if (gitExec(repoDir, ["ls-remote", "origin", MAIN_REF], keyPath) !== "") return false;
  const head = gitExec(repoDir, GIT_REV_PARSE_HEAD, keyPath);
  if (!head || !GIT_SHA_RE.test(head)) return false;
  if (gitExec(repoDir, ["symbolic-ref", "--short", "HEAD"], keyPath) !== "main") return false;
  if (gitExec(repoDir, ["rev-list", "--count", "HEAD"], keyPath) !== "1") return false;
  if (gitExec(repoDir, ["log", "-1", "--pretty=%s"], keyPath) !== "initial system_config openclaw template") {
    return false;
  }
  if (gitExec(repoDir, ["status", "--porcelain", "--", ...SYSTEM_CONFIG_PATHSPEC_ARGS], keyPath) !== "") {
    return false;
  }
  const tracked = gitExec(
    repoDir,
    ["diff-tree", "--root", "--no-commit-id", "--name-only", "-r", "HEAD"],
    keyPath,
  );
  const expected = [
    SYSTEM_CONFIG_GITIGNORE_FILENAME,
    SYSTEM_CONFIG_METADATA_FILENAME,
    OPENCLAW_CONFIG_FILENAME,
  ].sort().join("\n");
  return tracked !== null && tracked.split("\n").sort().join("\n") === expected;
}

function retainedSeedFilesMatch(repoDir: string, templatePath: string): boolean {
  try {
    const configContents = fs.readFileSync(path.join(repoDir, OPENCLAW_CONFIG_FILENAME), "utf8");
    const config = JSON.parse(configContents);
    if (!asRecord(config)) return false;
    const template = fs.readFileSync(templatePath, "utf8");
    JSON.parse(template);
    if (configContents !== (template.endsWith("\n") ? template : `${template}\n`)) return false;
    const metadata = readSystemConfigMetadata(path.join(repoDir, SYSTEM_CONFIG_METADATA_FILENAME));
    return metadata?.schemaVersion === CURRENT_SYSTEM_CONFIG_SCHEMA_VERSION &&
      metadata.lastMigration === "initial" &&
      fs.readFileSync(path.join(repoDir, SYSTEM_CONFIG_GITIGNORE_FILENAME), "utf8") ===
        SYSTEM_CONFIG_GITIGNORE;
  } catch {
    return false;
  }
}

function retryRetainedInitialSeedPush(
  slug: string,
  repoDir: string,
  templatePath: string,
  keyPath: string,
  log: (msg: string) => void,
): boolean {
  if (!retainedSeedGitStateMatches(repoDir, keyPath)) return false;
  if (!retainedSeedFilesMatch(repoDir, templatePath)) return false;
  if (gitExec(repoDir, ["push", "-u", "origin", "main"], keyPath) === null) {
    log(`[system_config] retained initial push retry failed for ${slug}/${systemConfigRepoName()}`);
    return false;
  }
  log(`[system_config] recovered retained initial commit for ${slug}/${systemConfigRepoName()}`);
  return true;
}

function cloneOrReuseSystemConfigRepo(
  slug: string,
  dir: string,
  templatePath: string,
  log: (msg: string) => void,
): boolean {
  if (fs.existsSync(path.join(dir, ".git"))) {
    setRepoSshCommand(dir, slug);
    const sshKey = customerSshKeyPath(slug);
    if (gitExec(dir, ["fetch", "origin", "main"], sshKey) === null) {
      if (retryRetainedInitialSeedPush(slug, dir, templatePath, sshKey, log)) return true;
      if (
        gitExec(dir, ["ls-remote", "origin", MAIN_REF], sshKey) === "" &&
        gitExec(dir, ["rev-parse", "--verify", "HEAD"], sshKey) === null
      ) {
        return true;
      }
      log(`[system_config] fetch failed for ${slug}/${systemConfigRepoName()}`);
      return false;
    }
    if (gitExec(dir, ["merge", "--ff-only", "origin/main"], sshKey) === null) {
      log(`[system_config] reused checkout is not a fast-forward for ${slug}/${systemConfigRepoName()}`);
      return false;
    }
    return true;
  }
  if (fs.existsSync(dir)) {
    log(`[system_config] ${dir} exists but is not a git repo; leaving it untouched`);
    return false;
  }
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  const sshKey = customerSshKeyPath(slug);
  const result = gitExec(path.dirname(dir), ["clone", remoteUrl(slug), path.basename(dir)], sshKey);
  if (result === null) {
    log(`[system_config] clone failed for ${slug}/${systemConfigRepoName()}`);
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch (error) {
      log(`[system_config] failed to remove partial checkout ${dir}: ${error instanceof Error ? error.message : String(error)}`);
    }
    return false;
  }
  gitExec(dir, ["config", "user.email", `${slug}@octogee.com`]);
  gitExec(dir, ["config", "user.name", `Octo (${slug})`]);
  setRepoSshCommand(dir, slug);
  log(`[system_config] cloned ${slug}/${systemConfigRepoName()} -> ${dir}`);
  return true;
}

function seedSystemConfigIfMissing(
  slug: string,
  repoDir: string,
  templatePath: string,
  log: (msg: string) => void,
): boolean {
  const configPath = path.join(repoDir, OPENCLAW_CONFIG_FILENAME);
  if (fs.existsSync(configPath)) return false;
  const template = fs.readFileSync(templatePath, "utf-8");
  JSON.parse(template);
  fs.writeFileSync(configPath, template.endsWith("\n") ? template : `${template}\n`, "utf-8");
  atomicWrite(path.join(repoDir, SYSTEM_CONFIG_METADATA_FILENAME), `${JSON.stringify({
    schemaVersion: CURRENT_SYSTEM_CONFIG_SCHEMA_VERSION,
    lastMigration: "initial",
  }, null, 2)}\n`);
  fs.writeFileSync(path.join(repoDir, SYSTEM_CONFIG_GITIGNORE_FILENAME), SYSTEM_CONFIG_GITIGNORE, "utf-8");
  const staged = gitExec(repoDir, ["add", ...SYSTEM_CONFIG_PATHSPEC_ARGS]);
  if (staged === null) {
    throw new Error(`[system_config] initial stage failed for ${slug}`);
  }
  const committed = gitExec(repoDir, ["commit", "-m", "initial system_config openclaw template"]);
  if (committed === null) {
    throw new Error(`[system_config] initial commit failed for ${slug}`);
  }
  const pushed = gitExec(repoDir, ["push", "-u", "origin", "main"], customerSshKeyPath(slug));
  if (pushed === null) {
    throw new Error(`[system_config] initial push failed for ${slug}`);
  }
  log(`[system_config] seeded ${slug}/${systemConfigRepoName()} with openclaw.json template`);
  return true;
}

function repositoryHasHead(slug: string, repoDir: string): boolean {
  return gitExec(
    repoDir,
    ["rev-parse", "--verify", "HEAD"],
    customerSshKeyPath(slug),
  ) !== null;
}

function recoverRestoredSystemConfig(
  slug: string,
  openclawDir: string,
  env: NodeJS.ProcessEnv,
  opts: SystemConfigRestoreOptions,
): SystemConfigRecoveryResult {
  return (opts.recover ?? recoverSystemConfigHead)({
    slug,
    openclawDir,
    repoDir: systemConfigDir(openclawDir),
    configPath: systemConfigPath(openclawDir),
    env,
    validateConfig: opts.validateConfig ?? acceptRuntimeManagedConfig,
  });
}

export function extractLegacyMattermostAccountSecrets(config: UnknownRecord): Record<string, string> {
  const accounts = asRecord(asRecord(asRecord(config.channels)?.mattermost)?.accounts);
  if (!accounts) return {};
  const secrets: Record<string, string> = {};
  for (const [accountId, value] of Object.entries(accounts)) {
    const account = asRecord(value);
    if (
      !account ||
      typeof account.botToken !== "string" ||
      account.botToken.length === 0 ||
      account.botToken === "${MM_BOT_TOKEN}"
    ) continue;
    secrets[accountId] = account.botToken;
    account.botToken = mattermostAccountSecretRef(accountId);
  }
  return secrets;
}

async function reconcileTrackedOpenClawConfig(
  repoConfigPath: string,
  openclawDir: string,
  env: NodeJS.ProcessEnv,
): Promise<boolean> {
  const repoDir = path.dirname(repoConfigPath);
  const metadataPath = path.join(repoDir, SYSTEM_CONFIG_METADATA_FILENAME);
  const metadata = readSystemConfigMetadata(metadataPath);
  const schemaVersion = metadata?.schemaVersion;
  if (schemaVersion !== undefined &&
      (!Number.isInteger(schemaVersion) || (schemaVersion as number) < 0 || (schemaVersion as number) > CURRENT_SYSTEM_CONFIG_SCHEMA_VERSION)) {
    throw new Error(`[system_config] unsupported schemaVersion ${String(schemaVersion)}`);
  }
  if (schemaVersion === CURRENT_SYSTEM_CONFIG_SCHEMA_VERSION) {
    if (!fs.existsSync(path.join(repoDir, SYSTEM_CONFIG_GITIGNORE_FILENAME))) {
      fs.writeFileSync(path.join(repoDir, SYSTEM_CONFIG_GITIGNORE_FILENAME), SYSTEM_CONFIG_GITIGNORE, "utf-8");
    }
    return false;
  }
  const before = fs.readFileSync(repoConfigPath, "utf-8");
  let tracked: Record<string, unknown>;
  try {
    const parsed = JSON.parse(before) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return false;
    tracked = parsed as Record<string, unknown>;
  } catch {
    return false;
  }

  removeLegacyMacConfig(tracked, env);
  const secrets = extractLegacyMattermostAccountSecrets(tracked);
  if (Object.keys(secrets).length > 0) await updateMattermostAccountSecrets(openclawDir, { set: secrets });
  const after = `${JSON.stringify(tracked, null, 2)}\n`;
  if (after !== before) atomicWrite(repoConfigPath, after);
  atomicWrite(metadataPath, `${JSON.stringify({
    schemaVersion: CURRENT_SYSTEM_CONFIG_SCHEMA_VERSION,
    lastMigration: "remove-mac-and-externalize-mattermost-tokens",
    pendingStateCleanup: SYSTEM_CONFIG_LEGACY_MAC_STATE_CLEANUP,
  }, null, 2)}\n`);
  if (!fs.existsSync(path.join(repoDir, SYSTEM_CONFIG_GITIGNORE_FILENAME))) {
    fs.writeFileSync(path.join(repoDir, SYSTEM_CONFIG_GITIGNORE_FILENAME), SYSTEM_CONFIG_GITIGNORE, "utf-8");
  }
  return true;
}

export async function reconcileSystemConfigSchema(
  openclawDir: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<boolean> {
  return reconcileTrackedOpenClawConfig(
    systemConfigPath(openclawDir),
    openclawDir,
    env,
  );
}

export async function restoreSystemConfigForSlug(
  slug: string,
  opts: SystemConfigRestoreOptions = {},
): Promise<SystemConfigRestoreResult> {
  const log = opts.log ?? defaultLog;
  if (!isValidUsername(slug)) {
    return { skipped: "invalid-builder-slug", seeded: false, restored: false };
  }

  const openclawDir = opts.openclawDir ?? OPENCLAW_DIR;
  const repoDir = systemConfigDir(openclawDir);
  const templatePath = opts.templatePath ?? path.join(TEMPLATES_DIR, "..", "infra", "gateway", "openclaw.template.json");

  await ensureIdentityAndRepo(slug, log);
  if (!cloneOrReuseSystemConfigRepo(slug, repoDir, templatePath, log)) {
    return { skipped: "checkout-unavailable", seeded: false, restored: false };
  }

  const configPath = systemConfigPath(openclawDir);
  const env = opts.env ?? process.env;
  let seeded = false;
  if (!fs.existsSync(configPath)) {
    if (repositoryHasHead(slug, repoDir)) {
      const recovery = recoverRestoredSystemConfig(slug, openclawDir, env, opts);
      if (recovery.outcome === "unavailable") {
        return { skipped: "accepted-head-unavailable", seeded: false, restored: false };
      }
    } else {
      seeded = seedSystemConfigIfMissing(slug, repoDir, templatePath, log);
    }
  }
  try {
    await reconcileSystemConfigSchema(openclawDir, env);
  } catch (error) {
    log(`[system_config] schema reconciliation deferred to accepted-head recovery: ${error instanceof Error ? error.message : String(error)}`);
    const recovery = recoverRestoredSystemConfig(slug, openclawDir, env, opts);
    if (recovery.outcome === "unavailable") {
      return { skipped: "accepted-head-unavailable", seeded: false, restored: false };
    }
    await reconcileSystemConfigSchema(openclawDir, env);
  }
  log(`[system_config] active openclaw.json is ${slug}/${systemConfigRepoName()}/openclaw.json`);
  return { seeded, restored: true, configPath };
}

export function acquireSystemConfigSyncLock(openclawDir: string): (() => void) | null {
  const lease = acquireSystemConfigSyncLeaseSync({ openclawDir });
  return lease ? () => lease.release() : null;
}

function remoteHeadFromLsRemote(output: string | null): string | null {
  if (output === null) return null;
  const head = output.trim().split(/\s+/)[0] ?? "";
  return GIT_SHA_RE.test(head) ? head : null;
}

export function readDurableSystemConfigHeadForSlug(
  slug: string,
  opts: {
    openclawDir?: string;
    gitExec?: typeof gitExec;
    customerSshKeyPath?: typeof customerSshKeyPath;
  } = {},
): string {
  if (!isValidUsername(slug)) {
    throw new Error(`invalid builder slug: ${slug}`);
  }
  const openclawDir = opts.openclawDir ?? OPENCLAW_DIR;
  const execGit = opts.gitExec ?? gitExec;
  const keyPath = (opts.customerSshKeyPath ?? customerSshKeyPath)(slug);
  const head = remoteHeadFromLsRemote(
    execGit(
      openclawDir,
      ["ls-remote", remoteUrl(slug), MAIN_REF],
      keyPath,
    ),
  );
  if (!head) {
    throw new Error(`durable system config head unavailable for ${slug}`);
  }
  return head;
}

function inspectRemoteRelation(
  repoDir: string,
  keyPath: string,
  execGit: typeof gitExec,
): { relation: "equal" | "local-ahead" | "conflict" | "unavailable"; head?: string; remoteHead?: string } {
  const head = execGit(repoDir, GIT_REV_PARSE_HEAD, keyPath);
  const remoteHead = remoteHeadFromLsRemote(
    execGit(repoDir, ["ls-remote", "origin", MAIN_REF], keyPath),
  );
  if (!head || !GIT_SHA_RE.test(head) || !remoteHead) return { relation: "unavailable" };
  if (head === remoteHead) return { relation: "equal", head, remoteHead };
  const mergeBase = execGit(repoDir, ["merge-base", head, remoteHead], keyPath);
  if (mergeBase === remoteHead) return { relation: "local-ahead", head, remoteHead };
  return { relation: "conflict", head, remoteHead };
}

function recordSyncError(
  openclawDir: string,
  errorCode: string,
  now: () => Date,
  patch: { rejected?: boolean } = {},
): void {
  const current = readSystemConfigStatus(openclawDir);
  const at = now().toISOString();
  updateSystemConfigStatus(openclawDir, {
    state: "error",
    dirtySince: current.dirtySince ?? at,
    lastErrorCode: errorCode,
    lastErrorAt: at,
    ...(patch.rejected ? { rejectedCount: (current.rejectedCount ?? 0) + 1 } : {}),
  }, now);
}

function recordSyncSuccess(
  openclawDir: string,
  acceptedCommit: string,
  configHash: string,
  env: NodeJS.ProcessEnv,
  now: () => Date,
): void {
  updateSystemConfigStatus(openclawDir, {
    state: "clean",
    acceptedCommit,
    configHash: `sha256:${configHash}`,
    dirtySince: null,
    lastSyncedAt: now().toISOString(),
    lastErrorCode: null,
    lastErrorAt: null,
    openclawVersion: env.OPENCLAW_VERSION?.trim() || "unknown",
    watcherState: "running",
  }, now);
}

interface SystemConfigSyncContext {
  slug: string;
  opts: SystemConfigSyncOptions;
  pushWhenClean: boolean;
  log: (message: string) => void;
  now: () => Date;
  env: NodeJS.ProcessEnv;
  openclawDir: string;
  repoDir: string;
  repoConfigPath: string;
  initialFingerprint: string;
  execGit: typeof gitExec;
  keyPath: string;
}

// Converge a remote-ahead checkout by rebasing onto origin/main. The remote is
// the durable source of truth (GATEWAY-SIMPLE-ROLL-SPEC): during a surge roll
// the predecessor pod's final flush can land after this pod cloned, and this
// pull is what absorbs it. A true content conflict aborts the rebase and leaves
// the checkout untouched for the typed non-fast-forward error path.
function pullRebaseRemote(context: SystemConfigSyncContext): boolean {
  const pulled = context.execGit(context.repoDir, ["pull", "--rebase", "origin", "main"], context.keyPath);
  if (pulled !== null) return true;
  context.execGit(context.repoDir, ["rebase", "--abort"], context.keyPath);
  context.log(
    `[system_config] ${context.slug}: pull --rebase could not converge with origin/main`,
  );
  return false;
}

function syncStatusFailure(context: SystemConfigSyncContext): SystemConfigSyncResult {
  if (context.opts.durablePolicy) {
    recordSyncError(context.openclawDir, "status-check-failed", context.now);
  }
  context.log(`[system_config] ${context.slug}: prestop status check failed`);
  return {
    skipped: "status-failed",
    committed: false,
    pushed: false,
    ...(context.opts.durablePolicy ? { errorCode: "status-check-failed" } : {}),
    ...(context.pushWhenClean ? {
      pending: true,
      processedFingerprint: context.initialFingerprint,
    } : {}),
  };
}

function syncCleanSystemConfig(context: SystemConfigSyncContext): SystemConfigSyncResult {
  if (!context.pushWhenClean) {
    context.log(`[system_config] ${context.slug}: no openclaw.json changes to flush`);
    return { committed: false, pushed: false };
  }
  let pushed = context.execGit(context.repoDir, ["push", "origin", "main"], context.keyPath);
  if (pushed === null && pullRebaseRemote(context)) {
    pushed = context.execGit(context.repoDir, ["push", "origin", "main"], context.keyPath);
  }
  if (pushed === null) {
    if (context.opts.durablePolicy) {
      recordSyncError(context.openclawDir, "push-failed", context.now);
    }
    context.log(`[system_config] ${context.slug}: pending push retry failed`);
    return {
      committed: false,
      pushed: false,
      pending: true,
      ...(context.opts.durablePolicy ? { errorCode: "push-failed" } : {}),
      processedFingerprint: context.initialFingerprint,
    };
  }
  // The heal pull may have fast-forwarded openclaw.json — fingerprint the
  // content that is actually accepted now, not the pre-pull snapshot.
  const acceptedFingerprint = systemConfigFingerprint(context.repoConfigPath);
  const acceptedCommit = context.execGit(context.repoDir, GIT_REV_PARSE_HEAD, context.keyPath);
  if (context.opts.durablePolicy && (!acceptedCommit || !GIT_SHA_RE.test(acceptedCommit))) {
    recordSyncError(context.openclawDir, ACCEPTED_HEAD_UNAVAILABLE, context.now);
    return {
      committed: false,
      pushed: true,
      pending: true,
      errorCode: ACCEPTED_HEAD_UNAVAILABLE,
      processedFingerprint: acceptedFingerprint,
    };
  }
  if (context.opts.durablePolicy && acceptedCommit && GIT_SHA_RE.test(acceptedCommit)) {
    recordSyncSuccess(
      context.openclawDir,
      acceptedCommit,
      acceptedFingerprint,
      context.env,
      context.now,
    );
  }
  return {
    committed: false,
    pushed: true,
    pending: false,
    processedFingerprint: acceptedFingerprint,
    ...(acceptedCommit && GIT_SHA_RE.test(acceptedCommit) ? {
      acceptedCommit,
      configHash: acceptedFingerprint,
    } : {}),
  };
}

type CandidateValidationResult =
  | { validatedFingerprint: string; validatedDurableFingerprint: string }
  | { result: SystemConfigSyncResult };

function durableFilesFingerprint(repoDir: string): string {
  const hash = createHash("sha256");
  for (const filename of [
    OPENCLAW_CONFIG_FILENAME,
    SYSTEM_CONFIG_METADATA_FILENAME,
    SYSTEM_CONFIG_GITIGNORE_FILENAME,
  ]) {
    hash.update(filename);
    const filePath = path.join(repoDir, filename);
    if (fs.existsSync(filePath)) hash.update(fs.readFileSync(filePath));
    else hash.update("<missing>");
  }
  return hash.digest("hex");
}

function durableDirtyPaths(status: string): Set<string> {
  return new Set(status.split("\n").map((line) => line.trim().slice(2).trim()).filter(Boolean));
}

type AcceptedDurableSet = ReadonlyMap<SystemConfigDurableFilename, Buffer>;

function acceptedCommitBlobReader(context: SystemConfigSyncContext): ReadSystemConfigCommitBlob {
  return context.opts.readCommitBlob ??
    (context.opts.gitExec
      ? ((_repoDir, commit, filename) => {
          const contents = context.execGit(
            context.repoDir,
            ["show", `${commit}:${filename}`],
            context.keyPath,
          );
          return contents === null ? null : Buffer.from(contents);
        })
      : readSystemConfigCommitBlob);
}

function loadAcceptedDurableSet(context: SystemConfigSyncContext): AcceptedDurableSet | null {
  const readBlob = acceptedCommitBlobReader(context);
  const accepted = new Map<SystemConfigDurableFilename, Buffer>();
  for (const filename of SYSTEM_CONFIG_DURABLE_FILENAMES) {
    const contents = readBlob(context.repoDir, "HEAD", filename);
    if (contents === null) return null;
    accepted.set(filename, contents);
  }
  return accepted;
}

function writeAcceptedDirtyFiles(
  context: SystemConfigSyncContext,
  dirtyPaths: ReadonlySet<string>,
  accepted: AcceptedDurableSet,
): boolean {
  for (const filename of SYSTEM_CONFIG_DURABLE_FILENAMES) {
    if (!dirtyPaths.has(filename)) continue;
    const contents = accepted.get(filename);
    if (!contents) return false;
    atomicWrite(path.join(context.repoDir, filename), contents);
  }
  return true;
}

function rejectedDeletionResult(context: SystemConfigSyncContext): SystemConfigSyncResult {
  const durablePaths = new Set([
    OPENCLAW_CONFIG_FILENAME,
    SYSTEM_CONFIG_METADATA_FILENAME,
    SYSTEM_CONFIG_GITIGNORE_FILENAME,
  ]);
  const deletedDurableFingerprint = durableFilesFingerprint(context.repoDir);
  const accepted = loadAcceptedDurableSet(context);
  if (durableFilesFingerprint(context.repoDir) !== deletedDurableFingerprint) {
    return changedRejectedCandidateResult(
      context,
      "openclaw-json-missing",
      undefined,
      context.initialFingerprint,
    );
  }
  if (accepted === null || !writeAcceptedDirtyFiles(context, durablePaths, accepted)) {
    recordSyncError(context.openclawDir, VALIDATION_RESTORE_FAILED, context.now, {
      rejected: true,
    });
    context.log(`[system_config] ${context.slug}: deleted config restore failed`);
    return {
      skipped: VALIDATION_RESTORE_FAILED,
      committed: false,
      pushed: false,
      rejected: true,
      errorCode: VALIDATION_RESTORE_FAILED,
    };
  }
  recordSyncError(context.openclawDir, "openclaw-json-missing", context.now, {
    rejected: true,
  });
  context.log(`[system_config] ${context.slug}: rejected config deletion and restored accepted durable set`);
  return {
    committed: false,
    pushed: false,
    rejected: true,
    errorCode: "openclaw-json-missing",
    processedFingerprint: systemConfigFingerprint(context.repoConfigPath),
  };
}

interface RejectedCandidateContext {
  context: SystemConfigSyncContext;
  candidateContents: Buffer;
  candidateFingerprint: string;
  candidateDurableFingerprint: string;
  dirtyPaths: ReadonlySet<string>;
  error: unknown;
}

function changedRejectedCandidateResult(
  context: SystemConfigSyncContext,
  errorCode: string,
  policyPaths: string[] | undefined,
  candidateFingerprint: string,
): SystemConfigSyncResult {
  recordSyncError(context.openclawDir, errorCode, context.now, { rejected: true });
  context.log(`[system_config] ${context.slug}: rejected durable files changed before restore; scheduling another pass`);
  return {
    committed: false,
    pushed: false,
    pending: true,
    rejected: true,
    errorCode,
    ...(policyPaths ? { policyPaths } : {}),
    processedFingerprint: candidateFingerprint,
  };
}

function rejectedCandidateResult(input: RejectedCandidateContext): SystemConfigSyncResult {
  const {
    context,
    candidateContents,
    candidateFingerprint,
    candidateDurableFingerprint,
    dirtyPaths,
    error,
  } = input;
  const stamp = context.now().toISOString().replace(/[:.]/g, "-");
  const rejectedDir = path.join(context.openclawDir, "rejected_config");
  fs.mkdirSync(rejectedDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(rejectedDir, `openclaw.${stamp}.json`), candidateContents, {
    mode: 0o600,
  });
  const errorCode = error instanceof PlatformInvariantPolicyError
    ? error.code
    : "validation-failed";
  const policyPaths = error instanceof PlatformInvariantPolicyError ? error.paths : undefined;
  if (durableFilesFingerprint(context.repoDir) !== candidateDurableFingerprint) {
    return changedRejectedCandidateResult(
      context,
      errorCode,
      policyPaths,
      candidateFingerprint,
    );
  }
  const accepted = loadAcceptedDurableSet(context);
  if (durableFilesFingerprint(context.repoDir) !== candidateDurableFingerprint) {
    return changedRejectedCandidateResult(
      context,
      errorCode,
      policyPaths,
      candidateFingerprint,
    );
  }
  if (accepted === null || !writeAcceptedDirtyFiles(context, dirtyPaths, accepted)) {
    if (context.opts.durablePolicy) {
      recordSyncError(context.openclawDir, VALIDATION_RESTORE_FAILED, context.now, {
        rejected: true,
      });
    }
    context.log(`[system_config] ${context.slug}: validation failed and accepted config restore failed`);
    return {
      skipped: VALIDATION_RESTORE_FAILED,
      committed: false,
      pushed: false,
      rejected: true,
      errorCode: VALIDATION_RESTORE_FAILED,
    };
  }
  recordSyncError(context.openclawDir, errorCode, context.now, { rejected: true });
  const policySuffix = policyPaths ? `: ${policyPaths.join(", ")}` : "";
  context.log(`[system_config] ${context.slug}: rejected config restored (${errorCode}${policySuffix})`);
  return {
    committed: false,
    pushed: false,
    rejected: true,
    errorCode,
    ...(policyPaths ? { policyPaths } : {}),
    processedFingerprint: systemConfigFingerprint(context.repoConfigPath),
  };
}

function validateCandidate(
  context: SystemConfigSyncContext,
  dirtyPaths: ReadonlySet<string>,
): CandidateValidationResult {
  const candidateContents = fs.readFileSync(context.repoConfigPath);
  const candidateFingerprint = fingerprintContents(candidateContents);
  const candidateDurableFingerprint = durableFilesFingerprint(context.repoDir);
  try {
    const parsed = JSON.parse(candidateContents.toString("utf-8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("openclaw.json must contain an object");
    }
    if (context.opts.durablePolicy) assertPlatformInvariants(parsed as UnknownRecord, context.env);
    if (dirtyPaths.has(SYSTEM_CONFIG_METADATA_FILENAME)) {
      assertSystemConfigMetadata(
        fs.readFileSync(path.join(context.repoDir, SYSTEM_CONFIG_METADATA_FILENAME), "utf8"),
      );
    }
    if (dirtyPaths.has(SYSTEM_CONFIG_GITIGNORE_FILENAME)) {
      assertSystemConfigGitignore(
        fs.readFileSync(path.join(context.repoDir, SYSTEM_CONFIG_GITIGNORE_FILENAME), "utf8"),
      );
    }
    (context.opts.validateConfig ?? acceptRuntimeManagedConfig)(context.repoConfigPath);
    return {
      validatedFingerprint: systemConfigFingerprint(context.repoConfigPath),
      validatedDurableFingerprint: durableFilesFingerprint(context.repoDir),
    };
  } catch (error) {
    return {
      result: rejectedCandidateResult({
        context,
        candidateContents,
        candidateFingerprint,
        candidateDurableFingerprint,
        dirtyPaths,
        error,
      }),
    };
  }
}

function committedPushFailure(
  context: SystemConfigSyncContext,
  source: SystemConfigCommitSource,
  stagedFingerprint: string,
): SystemConfigSyncResult {
  if (context.opts.durablePolicy) {
    const afterFailure = inspectRemoteRelation(context.repoDir, context.keyPath, context.execGit);
    const errorCode = afterFailure.relation === "conflict"
      ? "non-fast-forward-conflict"
      : "push-failed";
    recordSyncError(context.openclawDir, errorCode, context.now);
    context.log(`[system_config] ${context.slug}: ${source} push failed (${errorCode})`);
    return {
      committed: true,
      pushed: false,
      pending: true,
      errorCode,
      ...(afterFailure.head ? { acceptedCommit: afterFailure.head } : {}),
      ...(context.pushWhenClean ? { processedFingerprint: stagedFingerprint } : {}),
    };
  }
  context.log(`[system_config] ${context.slug}: ${source} push failed`);
  return {
    committed: true,
    pushed: false,
    pending: true,
    ...(context.pushWhenClean ? { processedFingerprint: stagedFingerprint } : {}),
  };
}

// processedFingerprint stays the STAGED fingerprint deliberately: an edit that
// raced the commit leaves the live file differing from it, so the watcher's
// post-sync check schedules another pass instead of silently absorbing the
// edit. A heal-pull rebase that merged remote content converges the same way —
// the next pass finds a clean tree and records the post-pull content.
function committedPushSuccess(
  context: SystemConfigSyncContext,
  source: SystemConfigCommitSource,
  stagedFingerprint: string,
): SystemConfigSyncResult {
  const acceptedCommit = context.execGit(context.repoDir, GIT_REV_PARSE_HEAD, context.keyPath);
  if (context.opts.durablePolicy && (!acceptedCommit || !GIT_SHA_RE.test(acceptedCommit))) {
    recordSyncError(context.openclawDir, ACCEPTED_HEAD_UNAVAILABLE, context.now);
    return {
      committed: true,
      pushed: true,
      pending: true,
      errorCode: ACCEPTED_HEAD_UNAVAILABLE,
      ...(context.pushWhenClean ? { processedFingerprint: stagedFingerprint } : {}),
    };
  }
  if (context.opts.durablePolicy && acceptedCommit && GIT_SHA_RE.test(acceptedCommit)) {
    recordSyncSuccess(
      context.openclawDir,
      acceptedCommit,
      stagedFingerprint,
      context.env,
      context.now,
    );
  }
  context.log(`[system_config] ${context.slug}: ${source} pushed openclaw.json changes`);
  return {
    committed: true,
    pushed: true,
    ...(context.pushWhenClean ? { pending: false, processedFingerprint: stagedFingerprint } : {}),
    ...(acceptedCommit && GIT_SHA_RE.test(acceptedCommit) ? {
      acceptedCommit,
      configHash: stagedFingerprint,
    } : {}),
  };
}

function commitValidatedCandidate(
  context: SystemConfigSyncContext,
  validatedFingerprint: string,
  validatedDurableFingerprint: string,
): SystemConfigSyncResult {
  const staged = context.execGit(
    context.repoDir,
    ["add", ...SYSTEM_CONFIG_PATHSPEC_ARGS],
    context.keyPath,
  );
  if (staged === null) {
    if (context.opts.durablePolicy) {
      recordSyncError(context.openclawDir, "stage-failed", context.now);
    }
    context.log(`[system_config] ${context.slug}: staging openclaw.json failed`);
    return {
      skipped: "stage-failed",
      committed: false,
      pushed: false,
      ...(context.opts.durablePolicy ? { errorCode: "stage-failed" } : {}),
      ...(context.pushWhenClean ? {
        pending: true,
        processedFingerprint: validatedFingerprint,
      } : {}),
    };
  }
  const stagedFingerprint = systemConfigFingerprint(context.repoConfigPath);
  if (
    stagedFingerprint !== validatedFingerprint ||
    durableFilesFingerprint(context.repoDir) !== validatedDurableFingerprint
  ) {
    context.log(`[system_config] ${context.slug}: openclaw.json changed while staging; scheduling another pass`);
    return {
      committed: false,
      pushed: false,
      pending: true,
      processedFingerprint: validatedFingerprint,
    };
  }
  const source = context.opts.source ?? "auto-watch";
  const committed = context.execGit(
    context.repoDir,
    attributedCommitArgs(
      `${source}: sync openclaw config ${context.now().toISOString()}`,
      source,
      context.env,
      context.opts.expectedRemoteCommit,
    ),
    context.keyPath,
  );
  if (committed === null) {
    if (context.opts.durablePolicy) {
      recordSyncError(context.openclawDir, "commit-failed", context.now);
    }
    context.log(`[system_config] ${context.slug}: ${source} commit failed`);
    return {
      committed: false,
      pushed: false,
      ...(context.opts.durablePolicy ? { errorCode: "commit-failed" } : {}),
      ...(context.pushWhenClean ? { pending: true, processedFingerprint: stagedFingerprint } : {}),
    };
  }
  let pushed = context.execGit(context.repoDir, ["push", "origin", "main"], context.keyPath);
  if (pushed === null && pullRebaseRemote(context)) {
    pushed = context.execGit(context.repoDir, ["push", "origin", "main"], context.keyPath);
  }
  return pushed === null
    ? committedPushFailure(context, source, stagedFingerprint)
    : committedPushSuccess(context, source, stagedFingerprint);
}

function syncPreparedSystemConfig(context: SystemConfigSyncContext): SystemConfigSyncResult {
  const { repoConfigPath, repoDir, execGit, keyPath } = context;
  if (!fs.existsSync(repoConfigPath)) {
    return rejectedDeletionResult(context);
  }
  const dirty = execGit(repoDir, ["status", "--porcelain", "--", ...SYSTEM_CONFIG_PATHSPEC_ARGS], keyPath);
  if (dirty === null) return syncStatusFailure(context);
  if (dirty.length === 0) return syncCleanSystemConfig(context);
  const dirtyPaths = durableDirtyPaths(dirty);
  const validation = validateCandidate(context, dirtyPaths);
  if ("result" in validation) return validation.result;
  return commitValidatedCandidate(
    context,
    validation.validatedFingerprint,
    validation.validatedDurableFingerprint,
  );
}

function convergeExpectedRemoteSystemConfig(
  slug: string,
  opts: SystemConfigSyncOptions,
  context: Pick<SystemConfigSyncContext, "openclawDir" | "repoDir" | "repoConfigPath" | "env" | "execGit" | "keyPath" | "now">,
): SystemConfigSyncResult | null {
  if (!opts.expectedRemoteCommit) return null;
  const convergence = (opts.convergeRemoteCommit ?? convergeSystemConfigToRemoteCommit)({
    slug,
    openclawDir: context.openclawDir,
    repoDir: context.repoDir,
    configPath: context.repoConfigPath,
    expectedCommit: opts.expectedRemoteCommit,
    env: context.env,
    gitExec: opts.gitExec,
    validateConfig: opts.validateConfig ?? acceptRuntimeManagedConfig,
    keyPath: context.keyPath,
    readCommitBlob: opts.readCommitBlob,
  });
  if (convergence.outcome !== "unavailable") return null;
  if (opts.durablePolicy) {
    recordSyncError(context.openclawDir, convergence.errorCode, context.now);
  }
  (opts.log ?? defaultLog)(
    `[system_config] ${slug}: migration convergence failed (${convergence.errorCode})`,
  );
  return {
    committed: false,
    pushed: false,
    pending: true,
    errorCode: convergence.errorCode,
  };
}

function syncSystemConfigUnlocked(
  slug: string,
  opts: SystemConfigSyncOptions,
  pushWhenClean: boolean,
): SystemConfigSyncResult {
  if (!isValidUsername(slug)) {
    return { skipped: "invalid-builder-slug", committed: false, pushed: false };
  }
  const openclawDir = opts.openclawDir ?? OPENCLAW_DIR;
  const repoDir = systemConfigDir(openclawDir);
  if (!fs.existsSync(path.join(repoDir, ".git"))) {
    return { skipped: "checkout-unavailable", committed: false, pushed: false };
  }
  const repoConfigPath = systemConfigPath(openclawDir);
  const configureSsh = opts.setRepoSshCommand ?? setRepoSshCommand;
  configureSsh(repoDir, slug);
  const execGit = opts.gitExec ?? gitExec;
  const keyPath = (opts.customerSshKeyPath ?? customerSshKeyPath)(slug);
  const now = opts.now ?? (() => new Date());
  const env = opts.env ?? process.env;
  const convergenceFailure = convergeExpectedRemoteSystemConfig(slug, opts, {
    openclawDir,
    repoDir,
    repoConfigPath,
    env,
    execGit,
    keyPath,
    now,
  });
  if (convergenceFailure) return convergenceFailure;
  return syncPreparedSystemConfig({
    slug,
    opts,
    pushWhenClean,
    log: opts.log ?? defaultLog,
    now,
    env,
    openclawDir,
    repoDir,
    repoConfigPath,
    initialFingerprint: systemConfigFingerprint(repoConfigPath),
    execGit,
    keyPath,
  });
}

function syncSystemConfig(
  slug: string,
  opts: SystemConfigSyncOptions,
  pushWhenClean: boolean,
): SystemConfigSyncResult {
  const openclawDir = opts.openclawDir ?? OPENCLAW_DIR;
  if (!isValidUsername(slug) || !fs.existsSync(openclawDir)) {
    return syncSystemConfigUnlocked(slug, opts, pushWhenClean);
  }
  if (opts.lockHeld === true) {
    return syncSystemConfigUnlocked(slug, opts, pushWhenClean);
  }
  const releaseLock = acquireSystemConfigSyncLock(openclawDir);
  if (!releaseLock) {
    const configPath = systemConfigPath(openclawDir);
    return {
      skipped: "sync-locked",
      committed: false,
      pushed: false,
      pending: true,
      processedFingerprint: systemConfigFingerprint(configPath),
    };
  }
  try {
    return syncSystemConfigUnlocked(slug, opts, pushWhenClean);
  } finally {
    releaseLock();
  }
}

interface SystemConfigAuditGitState {
  head: string | null;
  remoteHead: string | null;
  headTree: string | null;
  indexTree: string | null;
  worktree: string | null;
  configHash: string;
}

interface CompleteSystemConfigAuditGitState extends SystemConfigAuditGitState {
  head: string;
  remoteHead: string;
  headTree: string;
  indexTree: string;
  worktree: string;
}

function readSystemConfigAuditGitState(
  repoDir: string,
  configPath: string,
  keyPath: string,
  execGit: typeof gitExec,
): SystemConfigAuditGitState {
  return {
    head: execGit(repoDir, GIT_REV_PARSE_HEAD, keyPath),
    headTree: execGit(repoDir, ["rev-parse", "HEAD^{tree}"], keyPath),
    indexTree: execGit(repoDir, ["write-tree"], keyPath),
    worktree: execGit(repoDir, ["status", "--porcelain", "--", ...SYSTEM_CONFIG_PATHSPEC_ARGS], keyPath),
    remoteHead: remoteHeadFromLsRemote(
      execGit(repoDir, ["ls-remote", "origin", MAIN_REF], keyPath),
    ),
    configHash: systemConfigFingerprint(configPath),
  };
}

function unavailableAuditResult(state: SystemConfigAuditGitState): SystemConfigAuditResult {
  return {
    state: "error",
    needsSync: true,
    ...(state.head ? { head: state.head } : {}),
    ...(state.remoteHead ? { remoteHead: state.remoteHead } : {}),
    ...(state.headTree ? { headTree: state.headTree } : {}),
    ...(state.indexTree ? { indexTree: state.indexTree } : {}),
    configHash: state.configHash,
    errorCode: "git-audit-unavailable",
  };
}

function completeAuditGitState(
  state: SystemConfigAuditGitState,
): state is CompleteSystemConfigAuditGitState {
  return Boolean(
    state.head &&
    state.remoteHead &&
    state.headTree &&
    state.indexTree &&
    state.worktree !== null,
  );
}

function auditNeedsSync(
  state: CompleteSystemConfigAuditGitState,
  statusHash: string | undefined,
): boolean {
  return state.worktree.length > 0 ||
    state.indexTree !== state.headTree ||
    state.head !== state.remoteHead ||
    (statusHash !== undefined && statusHash !== `sha256:${state.configHash}`);
}

function auditHasRemoteConflict(
  repoDir: string,
  keyPath: string,
  execGit: typeof gitExec,
  head: string,
  remoteHead: string,
): boolean {
  if (head === remoteHead) return false;
  return execGit(repoDir, ["merge-base", head, remoteHead], keyPath) !== remoteHead;
}

export function auditSystemConfigForSlug(
  slug: string,
  opts: SystemConfigAuditOptions = {},
): SystemConfigAuditResult {
  if (!isValidUsername(slug)) return { state: "unavailable", needsSync: false, errorCode: "invalid-builder-slug" };
  const openclawDir = opts.openclawDir ?? OPENCLAW_DIR;
  const repoDir = systemConfigDir(openclawDir);
  const configPath = systemConfigPath(openclawDir);
  if (!fs.existsSync(path.join(repoDir, ".git"))) {
    return { state: "unavailable", needsSync: false, errorCode: "checkout-unavailable" };
  }
  if (!fs.existsSync(configPath)) {
    return { state: "error", needsSync: true, errorCode: "openclaw-json-missing" };
  }
  const execGit = opts.gitExec ?? gitExec;
  const keyPath = (opts.customerSshKeyPath ?? customerSshKeyPath)(slug);
  const gitState = readSystemConfigAuditGitState(repoDir, configPath, keyPath, execGit);
  if (!completeAuditGitState(gitState)) return unavailableAuditResult(gitState);
  const { head, remoteHead, headTree, indexTree, worktree, configHash } = gitState;
  if (auditHasRemoteConflict(repoDir, keyPath, execGit, head, remoteHead)) {
    return {
      state: "error",
      needsSync: true,
      head,
      remoteHead,
      headTree,
      indexTree,
      worktreeDirty: worktree.length > 0,
      configHash,
      errorCode: "non-fast-forward-conflict",
    };
  }
  const status = readSystemConfigStatus(openclawDir);
  const worktreeDirty = worktree.length > 0;
  const needsSync = auditNeedsSync(gitState, status.configHash);
  return {
    state: needsSync ? "dirty" : "clean",
    needsSync,
    head,
    remoteHead,
    headTree,
    indexTree,
    worktreeDirty,
    configHash,
  };
}

interface BootCheckpointContext {
  slug: string;
  openclawDir: string;
  configPath: string;
  env: NodeJS.ProcessEnv;
  now: () => Date;
  opts: SystemConfigBootCheckpointOptions;
}

function recordBootDoctorResult(context: BootCheckpointContext): void {
  if (!context.opts.doctorResult) return;
  const current = readSystemConfigStatus(context.openclawDir);
  updateSystemConfigStatus(context.openclawDir, {
    state: context.opts.doctorResult === "ok" ? current.state : "error",
    doctorResult: context.opts.doctorResult,
    ...(context.opts.doctorResult === "error" ? {
      lastErrorCode: "openclaw-doctor-failed",
      lastErrorAt: context.now().toISOString(),
      dirtySince: current.dirtySince ?? context.now().toISOString(),
      runtimeReady: false,
    } : {}),
  }, context.now);
}

function doctorRetryResult(context: BootCheckpointContext): SystemConfigBootCheckpointResult {
  const current = readSystemConfigStatus(context.openclawDir);
  const at = context.now().toISOString();
  updateSystemConfigStatus(context.openclawDir, {
    state: "error",
    doctorResult: "error",
    runtimeReady: false,
    dirtySince: current.dirtySince ?? at,
    lastErrorCode: "openclaw-doctor-failed",
    lastErrorAt: at,
  }, context.now);
  return { ready: false, errorCode: "openclaw-doctor-retry-required" };
}

function reconcileBootConfig(context: BootCheckpointContext): void {
  try {
    const value = JSON.parse(fs.readFileSync(context.configPath, "utf8")) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) return;
    const before = fs.readFileSync(context.configPath, "utf8");
    reconcilePlatformInvariants(value as UnknownRecord, context.env);
    const after = `${JSON.stringify(value, null, 2)}\n`;
    if (after !== before) atomicWrite(context.configPath, after);
  } catch (error) {
    (context.opts.log ?? defaultLog)(
      `[system_config] boot reconciliation deferred to accepted-head recovery: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function bootRecoveryResult(
  context: BootCheckpointContext,
  recovery: Exclude<SystemConfigRecoveryResult, { outcome: "accepted" }>,
): SystemConfigBootCheckpointResult {
  if (recovery.outcome === "unavailable") {
    const errorCode = recovery.errorCode ?? "no-valid-ancestor";
    updateSystemConfigStatus(context.openclawDir, {
      state: "unavailable",
      bootRecovery: "unavailable",
      lastErrorCode: errorCode,
      lastErrorAt: context.now().toISOString(),
      dirtySince: context.now().toISOString(),
      openclawVersion: context.env.OPENCLAW_VERSION?.trim() || "unknown",
    }, context.now);
    return { ready: false, errorCode, rejectedCommit: recovery.rejectedCommit };
  }
  const current = readSystemConfigStatus(context.openclawDir);
  const at = context.now().toISOString();
  updateSystemConfigStatus(context.openclawDir, {
    state: "error",
    acceptedCommit: recovery.acceptedCommit,
    restoredCommit: recovery.recoveredFromCommit,
    configHash: `sha256:${systemConfigFingerprint(context.configPath)}`,
    bootRecovery: "recovered",
    recoveryCount: (current.recoveryCount ?? 0) + 1,
    dirtySince: current.dirtySince ?? at,
    lastSyncedAt: context.now().toISOString(),
    lastErrorCode: "accepted-ancestor-retry-required",
    lastErrorAt: at,
    openclawVersion: context.env.OPENCLAW_VERSION?.trim() || "unknown",
  }, context.now);
  return {
    ready: false,
    errorCode: "accepted-ancestor-retry-required",
    rejectedCommit: recovery.rejectedCommit,
  };
}

function activeDurableSetMatchesAcceptedHead(repoDir: string, acceptedCommit: string): boolean {
  for (const filename of SYSTEM_CONFIG_DURABLE_FILENAMES) {
    const accepted = readSystemConfigCommitBlob(repoDir, acceptedCommit, filename);
    if (accepted === null) return false;
    try {
      if (!fs.readFileSync(path.join(repoDir, filename)).equals(Buffer.from(accepted))) return false;
    } catch {
      return false;
    }
  }
  return true;
}

function postPushDurableMismatchResult(
  context: BootCheckpointContext,
  acceptedCommit: string,
): SystemConfigBootCheckpointResult {
  const current = readSystemConfigStatus(context.openclawDir);
  const at = context.now().toISOString();
  updateSystemConfigStatus(context.openclawDir, {
    state: "error",
    acceptedCommit,
    runtimeReady: false,
    dirtySince: current.dirtySince ?? at,
    lastErrorCode: "post-push-durable-mismatch",
    lastErrorAt: at,
  }, context.now);
  return { ready: false, errorCode: "post-push-durable-mismatch" };
}

function bootCheckpointFailed(result: SystemConfigSyncResult): boolean {
  return !result.pushed || Boolean(result.pending || result.rejected || result.skipped);
}

function transientBootDurabilityFailure(
  result: SystemConfigSyncResult,
  errorCode: string,
): boolean {
  return !result.rejected && !result.skipped &&
    (errorCode === "push-failed" || errorCode === "remote-head-unavailable");
}

function failedBootCheckpointResult(
  context: BootCheckpointContext,
  recovery: Extract<SystemConfigRecoveryResult, { outcome: "accepted" }>,
  syncResult: SystemConfigSyncResult,
): SystemConfigBootCheckpointResult {
  const errorCode = syncResult.errorCode ?? syncResult.skipped ?? "boot-checkpoint-pending";
  if (!transientBootDurabilityFailure(syncResult, errorCode)) {
    return { ready: false, errorCode };
  }
  const current = readSystemConfigStatus(context.openclawDir);
  const at = context.now().toISOString();
  const acceptedCommit = syncResult.acceptedCommit ?? recovery.acceptedCommit;
  updateSystemConfigStatus(context.openclawDir, {
    state: "error",
    acceptedCommit,
    bootRecovery: "none",
    schemaVersion: CURRENT_SYSTEM_CONFIG_SCHEMA_VERSION,
    openclawVersion: context.env.OPENCLAW_VERSION?.trim() || "unknown",
    dirtySince: current.dirtySince ?? at,
    lastErrorCode: errorCode,
    lastErrorAt: current.lastErrorAt ?? at,
  }, context.now);
  return { ready: false, errorCode };
}

function finishBootCheckpoint(
  context: BootCheckpointContext,
  recovery: Extract<SystemConfigRecoveryResult, { outcome: "accepted" }>,
  syncResult: SystemConfigSyncResult,
): SystemConfigBootCheckpointResult {
  if (bootCheckpointFailed(syncResult)) {
    return failedBootCheckpointResult(context, recovery, syncResult);
  }
  let acceptedCommit = syncResult.acceptedCommit ?? recovery.acceptedCommit;
  const verifyAcceptedDurableSet = context.opts.verifyAcceptedDurableSet ??
    activeDurableSetMatchesAcceptedHead;
  if (!verifyAcceptedDurableSet(systemConfigDir(context.openclawDir), acceptedCommit)) {
    return postPushDurableMismatchResult(context, acceptedCommit);
  }
  if (legacyMacStateCleanupPending(context.openclawDir)) {
    removeLegacyMacState(context.openclawDir, context.env);
    clearLegacyMacStateCleanup(context.openclawDir);
    const cleanupSyncResult = (context.opts.sync ?? syncSystemConfigForSlug)(context.slug, {
      openclawDir: context.openclawDir,
      env: context.env,
      now: context.now,
      validateConfig: context.opts.validateConfig,
      durablePolicy: true,
      source: "boot-migration",
    });
    if (bootCheckpointFailed(cleanupSyncResult)) {
      return failedBootCheckpointResult(
        context,
        { outcome: "accepted", acceptedCommit },
        cleanupSyncResult,
      );
    }
    acceptedCommit = cleanupSyncResult.acceptedCommit ?? acceptedCommit;
    if (!verifyAcceptedDurableSet(systemConfigDir(context.openclawDir), acceptedCommit)) {
      return postPushDurableMismatchResult(context, acceptedCommit);
    }
  }
  updateSystemConfigStatus(context.openclawDir, {
    state: "clean",
    acceptedCommit,
    bootRecovery: "none",
    schemaVersion: CURRENT_SYSTEM_CONFIG_SCHEMA_VERSION,
    openclawVersion: context.env.OPENCLAW_VERSION?.trim() || "unknown",
    lastErrorCode: null,
    lastErrorAt: null,
  }, context.now);
  return { ready: true, acceptedCommit };
}

export function checkpointBootSystemConfigForSlug(
  slug: string,
  opts: SystemConfigBootCheckpointOptions,
): SystemConfigBootCheckpointResult {
  const openclawDir = opts.openclawDir ?? OPENCLAW_DIR;
  const repoDir = systemConfigDir(openclawDir);
  const configPath = systemConfigPath(openclawDir);
  const env = opts.env ?? process.env;
  const now = opts.now ?? (() => new Date());
  const context = { slug, openclawDir, configPath, env, now, opts };
  recordBootDoctorResult(context);
  reconcileBootConfig(context);

  const recovery: SystemConfigRecoveryResult = (opts.recover ?? recoverSystemConfigHead)({
    slug,
    openclawDir,
    repoDir,
    configPath,
    env,
    validateConfig: opts.validateConfig,
    now,
    acceptCurrent: opts.doctorResult !== "error",
  });
  if (recovery.outcome !== "accepted") {
    const result = bootRecoveryResult(context, recovery);
    return opts.doctorResult === "error" && result.ready
      ? doctorRetryResult(context)
      : result;
  }
  if (opts.doctorResult === "error") return doctorRetryResult(context);

  const syncResult = (opts.sync ?? syncSystemConfigForSlug)(slug, {
    openclawDir,
    env,
    now,
    validateConfig: opts.validateConfig,
    durablePolicy: true,
    source: "boot-migration",
  });
  return finishBootCheckpoint(context, recovery, syncResult);
}

export function pushDirtySystemConfigForSlug(
  slug: string,
  opts: SystemConfigSyncOptions = {},
): SystemConfigSyncResult {
  return syncSystemConfig(slug, opts, false);
}

export function syncSystemConfigForSlug(
  slug: string,
  opts: SystemConfigSyncOptions = {},
): SystemConfigSyncResult {
  return syncSystemConfig(slug, opts, true);
}

export class SystemConfigCheckpointError extends Error {
  readonly code = "durable-system-config-checkpoint-failed";

  constructor(readonly result: SystemConfigSyncResult) {
    super(`durable system config checkpoint failed: ${result.errorCode ?? result.skipped ?? ACCEPTED_HEAD_UNAVAILABLE}`);
    this.name = "SystemConfigCheckpointError";
  }
}

export function checkpointDurableSystemConfigForSlug(
  slug: string,
  opts: SystemConfigSyncOptions = {},
  sync: typeof syncSystemConfigForSlug = syncSystemConfigForSlug,
): SystemConfigSyncResult {
  const result = sync(slug, {
    ...opts,
    durablePolicy: true,
    source: opts.source ?? (opts.expectedRemoteCommit ? "migration-checkpoint" : "auto-watch"),
  });
  if (!result.pushed || result.pending || result.rejected || result.skipped ||
      result.errorCode || !result.acceptedCommit) {
    throw new SystemConfigCheckpointError(result);
  }
  return result;
}
