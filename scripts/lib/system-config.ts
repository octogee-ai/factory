import * as fs from "fs";
import * as path from "path";

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
import { validateOpenClawConfig } from "./openclaw-config-validation.js";

type UnknownRecord = Record<string, unknown>;
const CURRENT_SYSTEM_CONFIG_SCHEMA_VERSION = 1;
const SYSTEM_CONFIG_PATHSPEC = "openclaw.json .octogee.json .gitignore";
const SYSTEM_CONFIG_GITIGNORE = "*.bak\n*.tmp\n";

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
}

interface SystemConfigRestoreOptions {
  openclawDir?: string;
  templatePath?: string;
  env?: NodeJS.ProcessEnv;
  log?: (msg: string) => void;
}

interface SystemConfigSyncOptions {
  openclawDir?: string;
  now?: () => Date;
  log?: (msg: string) => void;
  gitExec?: typeof gitExec;
  setRepoSshCommand?: typeof setRepoSshCommand;
  customerSshKeyPath?: typeof customerSshKeyPath;
  validateConfig?: (configPath: string) => void;
}

export function systemConfigDir(openclawDir = OPENCLAW_DIR): string {
  return path.join(openclawDir, "system_config");
}

export function systemConfigPath(openclawDir = OPENCLAW_DIR): string {
  return path.join(systemConfigDir(openclawDir), "openclaw.json");
}

function remoteUrl(slug: string): string {
  return `git@${GIT_SSH_HOST}:${workspaceGiteaOrg(slug)}/${systemConfigRepoName()}.git`;
}

function atomicWrite(filePath: string, contents: string, mode = 0o600): void {
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

export function removeLegacyMacConfig(
  config: UnknownRecord,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  let changed = false;
  const removedIds = new Set<string>();
  const agents = asRecord(config.agents);
  if (Array.isArray(agents?.list)) {
    const kept = agents.list.filter((entry) => {
      const agent = asRecord(entry);
      if (!agent || !isLegacyMacAgent(agent, legacyMacAgentIds(env))) return true;
      const id = recordString(agent, "id");
      if (id) removedIds.add(id);
      changed = true;
      return false;
    });
    if (kept.length !== agents.list.length) agents.list = kept;
  }

  if (Array.isArray(config.bindings)) {
    const kept = config.bindings.filter((entry) => {
      const binding = asRecord(entry);
      const remove = binding !== null && removedIds.has(recordString(binding, "agentId"));
      if (remove) changed = true;
      return !remove;
    });
    if (kept.length !== config.bindings.length) config.bindings = kept;
  }

  const mattermost = asRecord(asRecord(config.channels)?.mattermost);
  const accounts = asRecord(mattermost?.accounts);
  if (accounts && Object.prototype.hasOwnProperty.call(accounts, "default")) {
    delete accounts.default;
    changed = true;
  }
  if (mattermost?.defaultAccount === "default") {
    delete mattermost.defaultAccount;
    changed = true;
  }
  for (const key of ["botToken", "token"]) {
    if (mattermost && Object.prototype.hasOwnProperty.call(mattermost, key)) {
      delete mattermost[key];
      changed = true;
    }
  }
  const builderSlug = env.GATEWAY_BUILDER_SLUG?.trim();
  const builderCoachId = builderSlug ? `octogee-${builderSlug}-coach` : "";
  const builderCoach = Array.isArray(agents?.list)
    ? agents.list.find((entry) => asRecord(entry)?.id === builderCoachId)
    : undefined;
  if (builderCoach && asRecord(builderCoach)?.default !== true) {
    asRecord(builderCoach)!.default = true;
    changed = true;
  }
  return changed;
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

async function ensureIdentityAndRepo(slug: string, log: (msg: string) => void): Promise<void> {
  const pubKey = generateCustomerSshKey(slug);
  await createGiteaUser(slug, pubKey);
  await ensureGiteaOrgForWorkspace(slug);
  await ensureSystemConfigRepo(slug);
  log(`[system_config] broker ensured Gitea user/org/${systemConfigRepoName()} for ${slug}`);
}

function cloneOrReuseSystemConfigRepo(slug: string, dir: string, log: (msg: string) => void): boolean {
  if (fs.existsSync(path.join(dir, ".git"))) {
    setRepoSshCommand(dir, slug);
    return true;
  }
  if (fs.existsSync(dir)) {
    log(`[system_config] ${dir} exists but is not a git repo; leaving it untouched`);
    return false;
  }
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  const sshKey = customerSshKeyPath(slug);
  const result = gitExec(path.dirname(dir), `clone ${remoteUrl(slug)} ${path.basename(dir)}`, sshKey);
  if (result === null) {
    log(`[system_config] clone failed for ${slug}/${systemConfigRepoName()}`);
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
    return false;
  }
  gitExec(dir, `config user.email "${slug}@octogee.com"`);
  gitExec(dir, `config user.name "Octo (${slug})"`);
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
  const configPath = path.join(repoDir, "openclaw.json");
  if (fs.existsSync(configPath)) return false;
  const template = fs.readFileSync(templatePath, "utf-8");
  JSON.parse(template);
  fs.writeFileSync(configPath, template.endsWith("\n") ? template : `${template}\n`, "utf-8");
  atomicWrite(path.join(repoDir, ".octogee.json"), `${JSON.stringify({
    schemaVersion: CURRENT_SYSTEM_CONFIG_SCHEMA_VERSION,
    lastMigration: "initial",
  }, null, 2)}\n`);
  fs.writeFileSync(path.join(repoDir, ".gitignore"), SYSTEM_CONFIG_GITIGNORE, "utf-8");
  const staged = gitExec(repoDir, `add ${SYSTEM_CONFIG_PATHSPEC}`);
  if (staged === null) {
    throw new Error(`[system_config] initial stage failed for ${slug}`);
  }
  const committed = gitExec(repoDir, `commit -m "initial system_config openclaw template"`);
  if (committed === null) {
    throw new Error(`[system_config] initial commit failed for ${slug}`);
  }
  const pushed = gitExec(repoDir, "push -u origin main", customerSshKeyPath(slug));
  if (pushed === null) {
    throw new Error(`[system_config] initial push failed for ${slug}`);
  }
  log(`[system_config] seeded ${slug}/${systemConfigRepoName()} with openclaw.json template`);
  return true;
}

function extractLegacyMattermostAccountSecrets(config: UnknownRecord): Record<string, string> {
  const accounts = asRecord(asRecord(asRecord(config.channels)?.mattermost)?.accounts);
  if (!accounts) return {};
  const secrets: Record<string, string> = {};
  for (const [accountId, value] of Object.entries(accounts)) {
    const account = asRecord(value);
    if (!account || typeof account.botToken !== "string" || account.botToken.length === 0) continue;
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
  const metadataPath = path.join(repoDir, ".octogee.json");
  const metadata = readSystemConfigMetadata(metadataPath);
  const schemaVersion = metadata?.schemaVersion;
  if (schemaVersion !== undefined &&
      (!Number.isInteger(schemaVersion) || (schemaVersion as number) < 0 || (schemaVersion as number) > CURRENT_SYSTEM_CONFIG_SCHEMA_VERSION)) {
    throw new Error(`[system_config] unsupported schemaVersion ${String(schemaVersion)}`);
  }
  const before = fs.readFileSync(repoConfigPath, "utf-8");
  const tracked = JSON.parse(before) as Record<string, unknown>;
  if (schemaVersion === CURRENT_SYSTEM_CONFIG_SCHEMA_VERSION) {
    if (!fs.existsSync(path.join(repoDir, ".gitignore"))) {
      fs.writeFileSync(path.join(repoDir, ".gitignore"), SYSTEM_CONFIG_GITIGNORE, "utf-8");
    }
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
  }, null, 2)}\n`);
  if (!fs.existsSync(path.join(repoDir, ".gitignore"))) {
    fs.writeFileSync(path.join(repoDir, ".gitignore"), SYSTEM_CONFIG_GITIGNORE, "utf-8");
  }
  return true;
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
  if (!cloneOrReuseSystemConfigRepo(slug, repoDir, log)) {
    return { skipped: "checkout-unavailable", seeded: false, restored: false };
  }

  const seeded = seedSystemConfigIfMissing(slug, repoDir, templatePath, log);
  const configPath = systemConfigPath(openclawDir);
  const env = opts.env ?? process.env;
  const migrated = await reconcileTrackedOpenClawConfig(configPath, openclawDir, env);
  if (migrated) removeLegacyMacState(openclawDir, env);
  log(`[system_config] active openclaw.json is ${slug}/${systemConfigRepoName()}/openclaw.json`);
  return { seeded, restored: true, configPath };
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function acquireSystemConfigSyncLock(openclawDir: string): (() => void) | null {
  const lockPath = path.join(openclawDir, "system_config.sync.lock");
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = fs.openSync(lockPath, "wx", 0o600);
      fs.writeFileSync(fd, `${process.pid}\n`);
      return () => {
        fs.closeSync(fd);
        fs.rmSync(lockPath, { force: true });
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const owner = Number.parseInt(fs.readFileSync(lockPath, "utf-8").trim(), 10);
      const ageMs = Date.now() - fs.statSync(lockPath).mtimeMs;
      const validOwner = Number.isInteger(owner) && owner > 0;
      if ((!validOwner && ageMs < 30_000) || (validOwner && processIsAlive(owner) && ageMs < 600_000)) {
        return null;
      }
      fs.rmSync(lockPath, { force: true });
    }
  }
  return null;
}

function syncSystemConfigUnlocked(
  slug: string,
  opts: SystemConfigSyncOptions,
  pushWhenClean: boolean,
): SystemConfigSyncResult {
  const log = opts.log ?? defaultLog;
  if (!isValidUsername(slug)) {
    return { skipped: "invalid-builder-slug", committed: false, pushed: false };
  }

  const openclawDir = opts.openclawDir ?? OPENCLAW_DIR;
  const repoDir = systemConfigDir(openclawDir);
  const repoConfigPath = systemConfigPath(openclawDir);
  if (!fs.existsSync(path.join(repoDir, ".git"))) {
    return { skipped: "checkout-unavailable", committed: false, pushed: false };
  }
  if (!fs.existsSync(repoConfigPath)) {
    return { skipped: "openclaw-json-missing", committed: false, pushed: false };
  }
  const initialFingerprint = systemConfigFingerprint(repoConfigPath);

  const execGit = opts.gitExec ?? gitExec;
  const configureSsh = opts.setRepoSshCommand ?? setRepoSshCommand;
  const keyPath = (opts.customerSshKeyPath ?? customerSshKeyPath)(slug);
  configureSsh(repoDir, slug);

  const dirty = execGit(repoDir, `status --porcelain -- ${SYSTEM_CONFIG_PATHSPEC}`, keyPath);
  if (dirty === null) {
    log(`[system_config] ${slug}: prestop status check failed`);
    return {
      skipped: "status-failed",
      committed: false,
      pushed: false,
      ...(pushWhenClean ? { pending: true, processedFingerprint: initialFingerprint } : {}),
    };
  }
  if (dirty.length === 0) {
    if (!pushWhenClean) {
      log(`[system_config] ${slug}: no openclaw.json changes to flush`);
      return {
        committed: false,
        pushed: false,
      };
    }
    const pushed = execGit(repoDir, "push origin main", keyPath);
    if (pushed === null) {
      log(`[system_config] ${slug}: pending push retry failed`);
      return {
        committed: false,
        pushed: false,
        pending: true,
        processedFingerprint: initialFingerprint,
      };
    }
    return {
      committed: false,
      pushed: true,
      pending: false,
      processedFingerprint: initialFingerprint,
    };
  }

  let validatedFingerprint: string;
  try {
    JSON.parse(fs.readFileSync(repoConfigPath, "utf-8"));
    (opts.validateConfig ?? validateOpenClawConfig)(repoConfigPath);
    validatedFingerprint = systemConfigFingerprint(repoConfigPath);
  } catch (error) {
    const stamp = (opts.now ?? (() => new Date()))().toISOString().replace(/[:.]/g, "-");
    const rejectedDir = path.join(openclawDir, "rejected_config");
    fs.mkdirSync(rejectedDir, { recursive: true, mode: 0o700 });
    const rejectedPath = path.join(rejectedDir, `openclaw.${stamp}.json`);
    fs.writeFileSync(rejectedPath, fs.readFileSync(repoConfigPath), { mode: 0o600 });
    const accepted = execGit(repoDir, "show HEAD:openclaw.json", keyPath);
    if (accepted === null) {
      log(`[system_config] ${slug}: validation failed and accepted config restore failed`);
      return {
        skipped: "validation-restore-failed",
        committed: false,
        pushed: false,
        rejected: true,
        errorCode: "validation-restore-failed",
      };
    }
    atomicWrite(repoConfigPath, accepted);
    log(
      `[system_config] ${slug}: rejected config restored (${error instanceof Error ? error.message : String(error)})`,
    );
    return {
      committed: false,
      pushed: false,
      rejected: true,
      errorCode: "validation-failed",
      processedFingerprint: systemConfigFingerprint(repoConfigPath),
    };
  }

  const staged = execGit(repoDir, `add ${SYSTEM_CONFIG_PATHSPEC}`, keyPath);
  if (staged === null) {
    log(`[system_config] ${slug}: staging openclaw.json failed`);
    return {
      skipped: "stage-failed",
      committed: false,
      pushed: false,
      ...(pushWhenClean ? { pending: true, processedFingerprint: validatedFingerprint } : {}),
    };
  }
  const stagedFingerprint = systemConfigFingerprint(repoConfigPath);
  if (stagedFingerprint !== validatedFingerprint) {
    log(`[system_config] ${slug}: openclaw.json changed while staging; scheduling another pass`);
    return {
      committed: false,
      pushed: false,
      pending: true,
      processedFingerprint: validatedFingerprint,
    };
  }
  const stamp = (opts.now ?? (() => new Date()))().toISOString();
  const source = pushWhenClean ? "auto" : "prestop";
  const committed = execGit(repoDir, `commit -m "${source}: sync openclaw config ${stamp}"`, keyPath);
  if (committed === null) {
    log(`[system_config] ${slug}: ${source} commit failed`);
    return {
      committed: false,
      pushed: false,
      ...(pushWhenClean ? { pending: true, processedFingerprint: stagedFingerprint } : {}),
    };
  }

  const pushed = execGit(repoDir, "push origin main", keyPath);
  if (pushed === null) {
    log(`[system_config] ${slug}: ${source} push failed`);
    return {
      committed: true,
      pushed: false,
      pending: true,
      ...(pushWhenClean ? { processedFingerprint: stagedFingerprint } : {}),
    };
  }

  log(`[system_config] ${slug}: ${source} pushed openclaw.json changes`);
  return {
    committed: true,
    pushed: true,
    ...(pushWhenClean
      ? { pending: false, processedFingerprint: stagedFingerprint }
      : {}),
  };
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
