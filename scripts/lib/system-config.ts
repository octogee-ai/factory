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

const ENV_PLACEHOLDER_RE = /\$\{([A-Za-z_]\w*)\}/g;
type UnknownRecord = Record<string, unknown>;

export interface SystemConfigRestoreResult {
  skipped?: string;
  seeded: boolean;
  restored: boolean;
}

export interface SystemConfigSyncResult {
  skipped?: string;
  committed: boolean;
  pushed: boolean;
}

interface SystemConfigRestoreOptions {
  openclawDir?: string;
  runtimeConfigPath?: string;
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
}

export function systemConfigDir(openclawDir = OPENCLAW_DIR): string {
  return path.join(openclawDir, "system_config");
}

export function expandEnvPlaceholders(
  input: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return input.replace(ENV_PLACEHOLDER_RE, (_match, name: string) => env[name] ?? "");
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

function readJsonFile(filePath: string): UnknownRecord | null {
  try {
    const value = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    return asRecord(value);
  } catch {
    return null;
  }
}

function preserveDefaultMattermostBotToken(
  restored: UnknownRecord,
  currentRuntime: UnknownRecord | null,
): void {
  const currentChannels = asRecord(currentRuntime?.channels);
  const currentMattermost = asRecord(currentChannels?.mattermost);
  const currentAccounts = asRecord(currentMattermost?.accounts);
  const currentDefault = asRecord(currentAccounts?.default);
  const currentToken = currentDefault?.botToken;
  if (typeof currentToken !== "string" || currentToken.length === 0) return;

  const restoredChannels = asRecord(restored.channels);
  const restoredMattermost = asRecord(restoredChannels?.mattermost);
  if (!restoredMattermost) return;

  const accounts = asRecord(restoredMattermost.accounts) ?? {};
  const defaultAccount = asRecord(accounts.default) ?? {};
  defaultAccount.botToken = currentToken;
  accounts.default = defaultAccount;
  restoredMattermost.accounts = accounts;
}

function operatorAgentSlug(env: NodeJS.ProcessEnv): string {
  return env.OPERATOR_AGENT_SLUG ?? env.GATEWAY_BUILDER_SLUG ?? env.GATEWAY_ID ?? "";
}

function operatorAgentId(env: NodeJS.ProcessEnv): string {
  const explicit = env.OPERATOR_AGENT_ID;
  if (explicit && explicit.length > 0) return explicit;
  const slug = operatorAgentSlug(env);
  return slug.length > 0 ? `octogee-ops-${slug}` : "";
}

function restoreEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const slug = operatorAgentSlug(env);
  const agentId = operatorAgentId(env);
  return {
    ...env,
    ...(slug ? { OPERATOR_AGENT_SLUG: slug } : {}),
    ...(agentId ? { OPERATOR_AGENT_ID: agentId } : {}),
  };
}

function recordString(record: UnknownRecord, key: string): string {
  const value = record[key];
  return typeof value === "string" ? value : "";
}

function isOperatorAgentIdentity(
  agent: UnknownRecord,
  params: { legacyId: string; expectedId: string },
): boolean {
  const id = recordString(agent, "id");
  const agentDir = recordString(agent, "agentDir");
  return (
    id === params.legacyId ||
    id === params.expectedId ||
    agentDir.includes(`/agents/${params.legacyId}/`)
  );
}

function rewriteOperatorAgentIdentity(
  agent: UnknownRecord,
  params: {
    expectedId: string;
    expectedSlug: string;
    legacyGatewayId: string;
    legacyId: string;
  },
): void {
  agent.id = params.expectedId;
  if (recordString(agent, "name") === `Mac (${params.legacyGatewayId})`) {
    agent.name = `Mac (${params.expectedSlug})`;
  }
  const agentDir = recordString(agent, "agentDir");
  if (agentDir.length > 0) {
    agent.agentDir = agentDir.replace(
      `/agents/${params.legacyId}/`,
      `/agents/${params.expectedId}/`,
    );
  }
}

function normalizeOperatorAgentIdentity(restored: UnknownRecord, env: NodeJS.ProcessEnv): void {
  const expectedSlug = operatorAgentSlug(env);
  const expectedId = operatorAgentId(env);
  const legacyGatewayId = env.GATEWAY_ID;
  if (!expectedSlug || !expectedId || !legacyGatewayId) return;

  const agents = asRecord(restored.agents);
  const list = agents?.list;
  if (!Array.isArray(list)) return;

  const legacyId = `octogee-ops-${legacyGatewayId}`;
  const params = { expectedId, expectedSlug, legacyGatewayId, legacyId };
  for (const entry of list) {
    const agent = asRecord(entry);
    if (!agent) continue;
    if (!isOperatorAgentIdentity(agent, params)) continue;
    rewriteOperatorAgentIdentity(agent, params);
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
  gitExec(repoDir, `add openclaw.json`);
  const committed = gitExec(repoDir, `commit -m "initial system_config openclaw template"`);
  if (committed === null) {
    log(`[system_config] initial commit failed for ${slug}; restore will continue from local template`);
    return true;
  }
  const pushed = gitExec(repoDir, "push -u origin main", customerSshKeyPath(slug));
  if (pushed === null) {
    log(`[system_config] initial push failed for ${slug}; boot continues and the next restore will retry`);
  } else {
    log(`[system_config] seeded ${slug}/${systemConfigRepoName()} with openclaw.json template`);
  }
  return true;
}

function restoreOpenClawConfig(
  repoConfigPath: string,
  runtimeConfigPath: string,
  env: NodeJS.ProcessEnv,
): void {
  const envForRestore = restoreEnv(env);
  const expanded = expandEnvPlaceholders(fs.readFileSync(repoConfigPath, "utf-8"), envForRestore);
  const restored = JSON.parse(expanded) as Record<string, unknown>;
  const currentRuntime = readJsonFile(runtimeConfigPath);
  preserveDefaultMattermostBotToken(restored, currentRuntime);
  normalizeOperatorAgentIdentity(restored, envForRestore);
  atomicWrite(runtimeConfigPath, `${JSON.stringify(restored, null, 2)}\n`);
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
  const runtimeConfigPath = opts.runtimeConfigPath ?? path.join(openclawDir, "openclaw.json");
  const templatePath = opts.templatePath ?? path.join(TEMPLATES_DIR, "..", "infra", "gateway", "openclaw.template.json");

  await ensureIdentityAndRepo(slug, log);
  if (!cloneOrReuseSystemConfigRepo(slug, repoDir, log)) {
    return { skipped: "checkout-unavailable", seeded: false, restored: false };
  }

  const seeded = seedSystemConfigIfMissing(slug, repoDir, templatePath, log);
  restoreOpenClawConfig(path.join(repoDir, "openclaw.json"), runtimeConfigPath, opts.env ?? process.env);
  log(`[system_config] restored openclaw.json from ${slug}/${systemConfigRepoName()}`);
  return { seeded, restored: true };
}

export function pushDirtySystemConfigForSlug(
  slug: string,
  opts: SystemConfigSyncOptions = {},
): SystemConfigSyncResult {
  const log = opts.log ?? defaultLog;
  if (!isValidUsername(slug)) {
    return { skipped: "invalid-builder-slug", committed: false, pushed: false };
  }

  const openclawDir = opts.openclawDir ?? OPENCLAW_DIR;
  const repoDir = systemConfigDir(openclawDir);
  const repoConfigPath = path.join(repoDir, "openclaw.json");
  if (!fs.existsSync(path.join(repoDir, ".git"))) {
    return { skipped: "checkout-unavailable", committed: false, pushed: false };
  }
  if (!fs.existsSync(repoConfigPath)) {
    return { skipped: "openclaw-json-missing", committed: false, pushed: false };
  }

  const execGit = opts.gitExec ?? gitExec;
  const configureSsh = opts.setRepoSshCommand ?? setRepoSshCommand;
  const keyPath = (opts.customerSshKeyPath ?? customerSshKeyPath)(slug);
  configureSsh(repoDir, slug);

  const dirty = execGit(repoDir, "status --porcelain -- openclaw.json", keyPath);
  if (dirty === null) {
    log(`[system_config] ${slug}: prestop status check failed`);
    return { skipped: "status-failed", committed: false, pushed: false };
  }
  if (dirty.length === 0) {
    log(`[system_config] ${slug}: no openclaw.json changes to flush`);
    return { committed: false, pushed: false };
  }

  execGit(repoDir, "add openclaw.json", keyPath);
  const stamp = (opts.now ?? (() => new Date()))().toISOString();
  const committed = execGit(repoDir, `commit -m "prestop: sync openclaw config ${stamp}"`, keyPath);
  if (committed === null) {
    log(`[system_config] ${slug}: prestop commit failed`);
    return { committed: false, pushed: false };
  }

  const pushed = execGit(repoDir, "push origin main", keyPath);
  if (pushed === null) {
    log(`[system_config] ${slug}: prestop push failed`);
    return { committed: true, pushed: false };
  }

  log(`[system_config] ${slug}: prestop pushed openclaw.json changes`);
  return { committed: true, pushed: true };
}
