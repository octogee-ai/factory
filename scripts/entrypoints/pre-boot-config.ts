import * as fs from "fs";
import * as path from "path";
import { randomUUID } from "node:crypto";
import { agentIdsFromConfig } from "../lib/byosub-restore.js";
import {
  materializeBrokerProfilesForAgents,
  openAiCatalogInputForBaseUrl,
  openRouterCatalogInputForBaseUrl,
} from "../lib/agent-model-token-materializer.js";
import {
  gatewayAgentRoster,
  platformOpenAiEmbeddingMemorySearch,
  platformOpenAiEmbeddingsEnabled,
} from "../lib/openclaw-config-builders.js";
import { applyOpenClawConversationExperiment } from "../lib/openclaw-conversation-experiment.js";
import { openClawConfigPath, openClawDir } from "../lib/openclaw-config-path.js";
import {
  isBareGatewayId,
  readGatewayAuthorization,
  type GatewayAuthorization,
} from "@octogee/core/gateway-live-release";
import {
  OPENAI_PLATFORM_PROVIDER_ID,
  OPENROUTER_PLATFORM_PROVIDER_ID,
  platformModelRefs,
} from "@octogee/shared/types/agent-models";
import { parseAgentId } from "@octogee/shared/types/identity";

const OPENCLAW_DIR = openClawDir();
const CONFIG_PATH = openClawConfigPath();

function log(msg: string): void {
  const ts = new Date().toISOString().replace("Z", "+00:00");
  console.log(`${ts} [pre-boot] ${msg}`);
}

export function shouldMaterializeAnthropicBrokerProfiles(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const gatewayClass = env.GATEWAY_CLASS ?? "";
  const profile = env.GATEWAY_PROFILE ?? "";
  return (
    gatewayClass === "shared" ||
    gatewayClass === "builder" ||
    gatewayClass === "operator" ||
    (!gatewayClass && profile === "operator")
  );
}

export function platformBrokerCatalogOpts(env: NodeJS.ProcessEnv): {
  openRouter?: ReturnType<typeof openRouterCatalogInputForBaseUrl>;
  openAi?: ReturnType<typeof openAiCatalogInputForBaseUrl>;
} {
  const openRouterBaseUrl = env.OPENROUTER_BASE_URL?.trim();
  const platformOpenAiBaseUrl = env.PLATFORM_OPENAI_BASE_URL?.trim();
  return {
    ...(openRouterBaseUrl
      ? { openRouter: openRouterCatalogInputForBaseUrl(openRouterBaseUrl) }
      : {}),
    ...(platformOpenAiBaseUrl
      ? { openAi: openAiCatalogInputForBaseUrl(platformOpenAiBaseUrl) }
      : {}),
  };
}

type OpenClawConfig = Record<string, unknown>;

const COACH_AGENT_ID_RE = /^octogee-[a-z0-9][a-z0-9-]{0,62}-coach$/;
const MM_URL_PLACEHOLDER = "${MM_URL}";

function objectProperty(
  parent: Record<string, unknown> | null,
  key: string,
): Record<string, unknown> | null {
  if (!parent) return null;
  const value = parent[key];
  return isPlainObject(value) ? value : null;
}

function ensureNullishObjectProperty(
  parent: Record<string, unknown>,
  key: string,
): Record<string, unknown> | null {
  const value = parent[key];
  if (isPlainObject(value)) return value;
  if (value !== null && value !== undefined) return null;
  const created: Record<string, unknown> = {};
  parent[key] = created;
  return created;
}

function applyToolsProfilePatch(
  config: OpenClawConfig,
  logFn: (msg: string) => void,
): boolean {
  const tools = ensureNullishObjectProperty(config, "tools");
  if (!tools) return false;
  if (tools.profile === "coding") return false;
  tools.profile = "coding";
  logFn(`set tools.profile=coding (gateway policy: openclaw "coding" defaults)`);
  return true;
}

function isCoachAgentEntry(value: unknown): value is Record<string, unknown> & { id: string } {
  return isPlainObject(value) && typeof value.id === "string" && COACH_AGENT_ID_RE.test(value.id);
}

export function applyMattermostPreBootPatches(
  config: OpenClawConfig,
  env: NodeJS.ProcessEnv,
  logFn: (msg: string) => void,
): boolean {
  const mattermost = objectProperty(objectProperty(config, "channels"), "mattermost");
  if (!mattermost) return false;
  let changed = false;

  if (env.MM_URL && mattermost.baseUrl !== MM_URL_PLACEHOLDER) {
    mattermost.baseUrl = MM_URL_PLACEHOLDER;
    changed = true;
    logFn(`restored channels.mattermost.baseUrl to the MM_URL placeholder`);
  }

  const commands = ensureNullishObjectProperty(mattermost, "commands");
  if (commands && commands.native !== false) {
    commands.native = false;
    changed = true;
    logFn(`forced channels.mattermost.commands.native=false (slash commands disabled)`);
  }

  const configuredAccounts = objectProperty(mattermost, "accounts");
  if (!configuredAccounts) return changed;
  for (const [accountId, account] of Object.entries(configuredAccounts)) {
    if (!isPlainObject(account)) continue;
    const accountCommands = ensureNullishObjectProperty(account, "commands");
    if (accountCommands && accountCommands.native !== false) {
      accountCommands.native = false;
      changed = true;
      logFn(`forced commands.native=false on accounts.${accountId}`);
    }
  }
  return changed;
}

function accountRouteKey(accountId: string, agentId: string): string {
  return `${accountId}\u0000${agentId}`;
}

function mattermostBindingFacts(value: unknown): {
  agentId: string;
  accountId: string;
  hasPeer: boolean;
} | null {
  if (!isPlainObject(value) || typeof value.agentId !== "string") return null;
  const match = value.match;
  if (
    !isPlainObject(match) ||
    match.channel !== "mattermost" ||
    typeof match.accountId !== "string"
  ) {
    return null;
  }
  return {
    agentId: value.agentId,
    accountId: match.accountId,
    hasPeer: match.peer !== undefined,
  };
}

function managedAgentIdForMattermostAccount(accountId: string): string | null {
  if (accountId.includes("-proj-")) {
    const agentId = `octogee-${accountId}-coach`;
    const parsed = parseAgentId(agentId);
    return parsed.kind === "project" &&
        `${parsed.username}-proj-${parsed.project}` === accountId
      ? agentId
      : null;
  }
  if (accountId.endsWith("-coach")) {
    const agentId = `octogee-${accountId}`;
    const parsed = parseAgentId(agentId);
    return parsed.kind === "coach" && `${parsed.username}-coach` === accountId
      ? agentId
      : null;
  }
  return null;
}

function applySharedDefaultAgent(config: OpenClawConfig): boolean {
  const agents = ensureNullishObjectProperty(config, "agents");
  if (!agents) throw new Error("shared routing safety requires an agents object");
  if (Array.isArray(agents.list)) {
    const next = gatewayAgentRoster(agents.list, "");
    if (valueEqual(agents.list, next)) return false;
    agents.list = next;
    return true;
  }
  if (agents.list !== undefined) {
    throw new Error("shared routing safety requires agents.list to be an array");
  }
  const entries = objectProperty(agents, "entries");
  if (!entries) {
    if (agents.entries !== undefined) {
      throw new Error("shared routing safety requires agents.entries to be an object");
    }
    agents.list = gatewayAgentRoster([], "");
    return true;
  }
  if (Object.values(entries).some((entry) => !isPlainObject(entry))) {
    throw new Error("shared routing safety requires every agent entry to be an object");
  }
  const list = Object.entries(entries)
    .map(([id, entry]) => ({ ...(entry as Record<string, unknown>), id }));
  const nextEntries = Object.fromEntries(
    gatewayAgentRoster(list, "").map((entry) => {
      const { id, ...rest } = entry as Record<string, unknown> & { id: string };
      return [id, rest];
    }),
  );
  if (valueEqual(entries, nextEntries)) return false;
  agents.entries = nextEntries;
  return true;
}

export function applySharedMattermostRoutingSafetyPatch(
  config: OpenClawConfig,
  env: NodeJS.ProcessEnv,
  logFn: (msg: string) => void,
): boolean {
  if (env.GATEWAY_CLASS !== "shared") return false;
  let changed = applySharedDefaultAgent(config);
  if (changed) {
    logFn("installed the non-tenant default agent for unmatched routes");
  }

  const mattermost = objectProperty(objectProperty(config, "channels"), "mattermost");
  const accounts = objectProperty(mattermost, "accounts");
  if (!accounts) return changed;
  if (config.bindings !== undefined && !Array.isArray(config.bindings)) {
    throw new Error("shared routing safety requires bindings to be an array");
  }
  const bindings = Array.isArray(config.bindings) ? config.bindings : [];

  const routes = new Map<string, string>();
  const quarantinedAccounts = new Set<string>();
  const configuredAgentIds = new Set(agentIdsFromConfig(config));
  for (const accountId of Object.keys(accounts)) {
    const agentId = managedAgentIdForMattermostAccount(accountId);
    if (!agentId || !configuredAgentIds.has(agentId)) {
      quarantinedAccounts.add(accountId);
      logFn(
        agentId
          ? `refused account route without managed agent for ${accountId}`
          : `refused unmanaged account route for ${accountId}`,
      );
      continue;
    }
    routes.set(accountId, agentId);
  }
  if (routes.size === 0 && quarantinedAccounts.size === 0) return changed;

  const retained = bindings.filter((binding) => {
    const facts = mattermostBindingFacts(binding);
    if (!facts) return true;
    if (quarantinedAccounts.has(facts.accountId)) return false;
    const inferredAgentId = routes.get(facts.accountId);
    return inferredAgentId === undefined || inferredAgentId === facts.agentId;
  });
  const present = new Set(
    retained.flatMap((binding) => {
      const facts = mattermostBindingFacts(binding);
      return facts && !facts.hasPeer ? [accountRouteKey(facts.accountId, facts.agentId)] : [];
    }),
  );
  for (const [accountId, agentId] of routes) {
    if (present.has(accountRouteKey(accountId, agentId))) continue;
    retained.push({
      agentId,
      match: { channel: "mattermost", accountId },
    });
  }
  if (!valueEqual(bindings, retained)) {
    config.bindings = retained;
    changed = true;
    logFn(
      `converged Mattermost account routes (stable=${routes.size}, quarantined=${quarantinedAccounts.size})`,
    );
  }
  return changed;
}

export function applyAnthropicBaseUrlPatch(
  config: OpenClawConfig,
  env: NodeJS.ProcessEnv,
  logFn: (msg: string) => void,
): boolean {
  if (!env.ANTHROPIC_BASE_URL) return false;
  let changed = false;

  const auth = ensureNullishObjectProperty(config, "auth");
  const profiles = auth ? ensureNullishObjectProperty(auth, "profiles") : null;
  if (profiles) {
    profiles["anthropic:default"] ??= {
      provider: "anthropic",
      mode: "api_key",
    };
    const anthropicProfile = objectProperty(profiles, "anthropic:default");
    if (anthropicProfile?.baseUrl !== undefined) {
      delete anthropicProfile.baseUrl;
      changed = true;
      logFn(`removed stale auth.profiles.anthropic:default.baseUrl (OpenClaw expects provider baseUrl)`);
    }
  }

  const models = ensureNullishObjectProperty(config, "models");
  const providers = models ? ensureNullishObjectProperty(models, "providers") : null;
  if (!providers) return changed;
  providers.anthropic ??= {};
  const anthropicProvider = objectProperty(providers, "anthropic");
  if (!anthropicProvider) return changed;
  if (anthropicProvider.baseUrl !== env.ANTHROPIC_BASE_URL) {
    anthropicProvider.baseUrl = env.ANTHROPIC_BASE_URL;
    changed = true;
    logFn(`Anthropic provider baseUrl synced from ANTHROPIC_BASE_URL env var`);
  }
  return changed;
}

export function applyMemorySearchPlatformEmbeddingsPatch(
  config: OpenClawConfig,
  env: NodeJS.ProcessEnv,
  logFn: (msg: string) => void,
): boolean {
  if (!platformOpenAiEmbeddingsEnabled(env)) {
    return false;
  }
  const agents = objectProperty(config, "agents");
  const list = Array.isArray(agents?.list) ? agents.list : [];
  const patched = list
    .filter(isCoachAgentEntry)
    .filter((agent) => agent.memorySearch === undefined)
    .map((agent) => {
      agent.memorySearch = platformOpenAiEmbeddingMemorySearch(agent.id, env);
      return agent.id;
    });
  if (patched.length === 0) return false;
  logFn(`memory search embeddings configured for ${patched.length} coach agent(s)`);
  return true;
}

function applyPlatformModelAllowlist(config: OpenClawConfig, env: NodeJS.ProcessEnv): boolean {
  if (!shouldMaterializeAnthropicBrokerProfiles(env)) return false;
  const agents = objectProperty(config, "agents");
  const defaults = agents ? ensureNullishObjectProperty(agents, "defaults") : null;
  const models = defaults ? ensureNullishObjectProperty(defaults, "models") : null;
  if (!models) return false;
  const refs = platformModelRefs().filter((ref) =>
    (!ref.startsWith(`${OPENROUTER_PLATFORM_PROVIDER_ID}/`) || Boolean(env.OPENROUTER_BASE_URL?.trim())) &&
    (!ref.startsWith(`${OPENAI_PLATFORM_PROVIDER_ID}/`) || Boolean(env.PLATFORM_OPENAI_BASE_URL?.trim())),
  );
  let changed = false;
  for (const ref of refs) {
    if (models[ref] !== undefined) continue;
    models[ref] = {};
    changed = true;
  }
  return changed;
}

function isLegacyGcpSecretResolverProvider(
  providerName: string,
  provider: Record<string, unknown>,
): boolean {
  return (
    providerName === "gcp-secret-manager" &&
    provider.source === "exec" &&
    provider.command === "/usr/local/bin/node" &&
    Array.isArray(provider.args) &&
    provider.args.length === 1 &&
    provider.args[0] === "/octogee/scripts/secret-resolver.mjs"
  );
}

export function applyOpenClawBeta5CompatibilityPatch(
  config: OpenClawConfig,
  logFn: (msg: string) => void = () => {},
): boolean {
  let changed = false;
  const meta = objectProperty(config, "meta");
  if (meta && Reflect.has(meta, "lastTouchedAt")) {
    Reflect.deleteProperty(meta, "lastTouchedAt");
    changed = true;
    logFn("removed meta.lastTouchedAt (unsupported by OpenClaw 2026.7.2-beta.5)");
  }

  const commands = objectProperty(config, "commands");
  if (commands && Reflect.has(commands, "ownerDisplay")) {
    Reflect.deleteProperty(commands, "ownerDisplay");
    changed = true;
    logFn("removed commands.ownerDisplay (unsupported by OpenClaw 2026.7.2-beta.5)");
  }

  const providers = objectProperty(objectProperty(config, "secrets"), "providers");
  if (!providers) return changed;
  for (const [providerName, provider] of Object.entries(providers)) {
    if (!isPlainObject(provider)) continue;
    if (isLegacyGcpSecretResolverProvider(providerName, provider)) {
      provider.command = "/octogee/scripts/secret-resolver.mjs";
      Reflect.deleteProperty(provider, "args");
      changed = true;
      logFn(
        "migrated secrets.providers.gcp-secret-manager to the node-owned resolver executable",
      );
    }
    if (Reflect.has(provider, "allowInsecurePath")) {
      Reflect.deleteProperty(provider, "allowInsecurePath");
      changed = true;
      logFn(
        `removed secrets.providers.${providerName}.allowInsecurePath (unsupported by OpenClaw 2026.7.2-beta.5)`,
      );
    }
  }
  return changed;
}

export function applyPreBootPatches(
  config: OpenClawConfig,
  env: NodeJS.ProcessEnv,
  logFn: (msg: string) => void = () => {},
): boolean {
  return [
    applyOpenClawBeta5CompatibilityPatch(config, logFn),
    applyToolsProfilePatch(config, logFn),
    applyMattermostPreBootPatches(config, env, logFn),
    applySharedMattermostRoutingSafetyPatch(config, env, logFn),
    applyOpenClawConversationExperiment(config, env.OCTOGEE_ACTIVITY_BRIDGE_MODE),
    applyAnthropicBaseUrlPatch(config, env, logFn),
    applyPlatformModelAllowlist(config, env),
    applyMemorySearchPlatformEmbeddingsPatch(config, env, logFn),
  ].some(Boolean);
}

const SECRET_BEARING_KEYS = new Set([
  "apiKey",
  "key",
  "token",
  "secret",
  "password",
  "botToken",
]);

const SECRETREF_OBJECT_KEYS = new Set(["keyRef", "tokenRef"]);

const PROTO_POLLUTION_KEYS = new Set(["__proto__", "constructor", "prototype"]);

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

export function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`timeout after ${ms}ms`)), ms);
  });
  return Promise.race([p.finally(() => clearTimeout(timer)), timeout]);
}

function stripInlineSecrets(
  node: unknown,
  pathLabel: string,
  logFn: (msg: string) => void,
): void {
  if (!isPlainObject(node)) return;
  for (const key of Object.keys(node)) {
    if (PROTO_POLLUTION_KEYS.has(key)) {
      Reflect.deleteProperty(node, key);
      logFn(`dropped unsafe key ${pathLabel}.${key} (prototype pollution)`);
      continue;
    }
    const val = Reflect.get(node, key);
    const secretBearing =
      SECRET_BEARING_KEYS.has(key) || SECRETREF_OBJECT_KEYS.has(key);
    if (secretBearing && typeof val === "string") {
      Reflect.deleteProperty(node, key);
      logFn(
        `dropped inline plaintext secret at ${pathLabel}.${key} — per-gateway overrides must reference Secret Manager via keyRef/tokenRef/SecretRef`,
      );
      continue;
    }
    if (val && typeof val === "object") {
      stripInlineSecrets(val, `${pathLabel}.${key}`, logFn);
    }
  }
}

function valueEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function deepMergeInto(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
): boolean {
  let changed = false;
  for (const [key, sv] of Object.entries(source)) {
    if (PROTO_POLLUTION_KEYS.has(key)) continue;
    const tv = Reflect.get(target, key);
    if (isPlainObject(sv) && isPlainObject(tv)) {
      if (deepMergeInto(tv, sv)) changed = true;
    } else if (!Reflect.has(target, key) || !valueEqual(tv, sv)) {
      Reflect.set(target, key, sv);
      changed = true;
    }
  }
  return changed;
}

export function applyGatewayOverrides(
  config: Record<string, unknown>,
  overrides: unknown,
  logFn: (msg: string) => void = () => {},
): boolean {
  if (!overrides || typeof overrides !== "object" || Array.isArray(overrides)) {
    return false;
  }
  const sanitized = structuredClone(overrides) as Record<string, unknown>;
  stripInlineSecrets(sanitized, "openclawOverrides", logFn);
  if (Object.keys(sanitized).length === 0) return false;
  return deepMergeInto(config, sanitized);
}

const FALLBACK_NAME = "Octogee Builder";
const FALLBACK_EMAIL_DOMAIN = "users.noreply.octogee.com";
const FALLBACK_GENERIC_LOCAL = "builder";

export function slugFromCoachAgentId(agentId: string): string | null {
  const m = /^octogee-(.+)-coach$/.exec(agentId);
  return m ? m[1] : null;
}

export function pickSoleTenantSlug(agentIds: readonly string[]): string | null {
  const slugs = new Set<string>();
  for (const id of agentIds) {
    const slug = slugFromCoachAgentId(id);
    if (slug) slugs.add(slug);
  }
  return slugs.size === 1 ? [...slugs][0] : null;
}

// eslint-disable-next-line no-control-regex -- matching control chars is the entire point: strip them to prevent gitconfig section injection via \n in displayName.
const SAFE_GITCONFIG_VALUE_RE = /[\x00-\x1F\x7F]/g;

function safeOrNull(v: string | undefined | null): string | null {
  if (typeof v !== "string") return null;
  const cleaned = v.replace(SAFE_GITCONFIG_VALUE_RE, "").trim();
  return cleaned.length > 0 ? cleaned : null;
}

function resolveGitIdentity(input: {
  user: { displayName?: string; email?: string } | null;
  slug: string | null;
}): { name: string; email: string } {
  const cleanName = safeOrNull(input.user?.displayName);
  const cleanEmail = safeOrNull(input.user?.email);
  const cleanSlug = safeOrNull(input.slug);
  const name = cleanName ?? cleanSlug ?? FALLBACK_NAME;
  const email =
    cleanEmail ??
    (cleanSlug
      ? `${cleanSlug}@${FALLBACK_EMAIL_DOMAIN}`
      : `${FALLBACK_GENERIC_LOCAL}@${FALLBACK_EMAIL_DOMAIN}`);
  return { name, email };
}

export function buildGitconfigContent(identity: {
  name: string;
  email: string;
}): string {
  return [
    "# Octogee-managed first-boot gitconfig seed.",
    "# Subsequent boots leave this file alone — edit freely.",
    "[user]",
    `\tname = ${identity.name}`,
    `\temail = ${identity.email}`,
    "[push]",
    "\tautoSetupRemote = true",
    "[init]",
    "\tdefaultBranch = main",
    "",
  ].join("\n");
}

export async function hydrateGitIdentity(deps: {
  gitconfigPath: string;
  agentIds: readonly string[];
  fetchUserBySlug: (
    slug: string,
  ) => Promise<{ displayName?: string; email?: string } | null>;
  fileExists: (p: string) => boolean;
  writeFile: (p: string, content: string) => void;
  logFn?: (msg: string) => void;
}): Promise<boolean> {
  const log = deps.logFn ?? (() => {});

let alreadyPresent = false;
  try {
    alreadyPresent = deps.fileExists(deps.gitconfigPath);
  } catch (e) {
    log(
      `gitconfig: fileExists check threw — treating as absent and proceeding: ${(e as Error).message}`,
    );
  }
  if (alreadyPresent) {
    return false;
  }

  const slug = pickSoleTenantSlug(deps.agentIds);
  let user: { displayName?: string; email?: string } | null = null;
  if (slug) {
    try {
      user = await deps.fetchUserBySlug(slug);
    } catch (e) {
      log(
        `gitconfig: firestore lookup for slug=${slug} failed, using fallback identity — ${(e as Error).message}`,
      );
    }
  }

  const identity = resolveGitIdentity({ user, slug });
  const content = buildGitconfigContent(identity);

  try {
    deps.writeFile(deps.gitconfigPath, content);
    log(
      `gitconfig: seeded ${deps.gitconfigPath} for ${identity.name} <${identity.email}>${
        slug ? ` (slug=${slug})` : " (no single tenant — generic identity)"
      }`,
    );
    return true;
  } catch (e) {
    log(
      `WARN: failed to write ${deps.gitconfigPath} — ${(e as Error).message} (boot continues)`,
    );
    return false;
  }
}

export function preBootFirestoreEnabled(
  env: NodeJS.ProcessEnv,
  fileExists: (p: string) => boolean = fs.existsSync,
): boolean {
  if (env.OCTOGEE_PREBOOT_FIRESTORE === "true") return true;
  if (env.OCTOGEE_PREBOOT_FIRESTORE === "false") return false;

  const candidates = [
    env.GOOGLE_APPLICATION_CREDENTIALS,
    env.SA_KEY_PATH,
    path.join(OPENCLAW_DIR, "secrets/octogee-test-sa-key.json"),
  ].filter((p): p is string => typeof p === "string" && p.trim().length > 0);

  return candidates.some((p) => {
    try {
      return fileExists(p);
    } catch {
      return false;
    }
  });
}

export async function applyGatewayRootConfig(
  config: Record<string, unknown>,
  deps: {
    gatewayId: string | undefined;
    readAuthorization: (gatewayId: string) => Promise<GatewayAuthorization | null>;
    logFn?: (msg: string) => void;
  },
): Promise<boolean> {
  const logFn = deps.logFn ?? (() => undefined);
  const gatewayId = deps.gatewayId;
  if (!isBareGatewayId(gatewayId)) {
    logFn(`WARN: refusing non-bare gateway config selector ${String(gatewayId)}`);
    return false;
  }
  const authorization = await deps.readAuthorization(gatewayId);
  if (!authorization) {
    logFn(`WARN: durable root config unavailable for gateways/${gatewayId}`);
    return false;
  }
  if (!authorization.config.openclawOverrides) return false;
  const overridesChanged = applyGatewayOverrides(
    config,
    authorization.config.openclawOverrides,
    logFn,
  );
  if (overridesChanged) {
    logFn(`applied openclawOverrides from gateways/${gatewayId}`);
  }
  return overridesChanged;
}

async function applyGatewayRootConfigFromFirestore(
  config: Record<string, unknown>,
  logFn: (msg: string) => void,
): Promise<boolean> {
  const gatewayId = process.env.GATEWAY_ID;
  try {
    const { db } = await import("../lib/firebase.js");
    return await applyGatewayRootConfig(config, {
      gatewayId,
      readAuthorization: (id) => withTimeout(readGatewayAuthorization(db, id), 4000),
      logFn,
    });
  } catch (e) {
    logFn(
      `WARN: could not fetch/apply gateways/${String(gatewayId)} root config — booting on template + policy only: ${(e as Error).message}`,
    );
    return false;
  }
}

export function writeConfigAtomically(configPath: string, config: unknown): void {
  const temporary = `${configPath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, JSON.stringify(config, null, 2), {
      encoding: "utf-8",
      mode: 0o600,
    });
    fs.renameSync(temporary, configPath);
  } catch (error) {
    fs.rmSync(temporary, { force: true });
    throw error;
  }
}

async function main(): Promise<void> {

let configRaw: string;
  try {
    configRaw = fs.readFileSync(CONFIG_PATH, "utf-8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") {
      log("No openclaw.json found — skipping pre-boot config");
      return;
    }
    throw e;
  }
  const config = JSON.parse(configRaw);

  const firestoreEnabled = preBootFirestoreEnabled(process.env);
  const overridesChanged = firestoreEnabled
    ? await applyGatewayRootConfigFromFirestore(config, log)
    : false;
  if (!firestoreEnabled) {
    log("Firestore-backed pre-boot state skipped (db-less gateway); applying env/runtime patches only");
  }

  const policyChanged = applyPreBootPatches(config, process.env, log);

  if (overridesChanged || policyChanged) {
    writeConfigAtomically(CONFIG_PATH, config);
    log("openclaw.json patched (per-gateway overrides / env / stale-key cleanup)");
  } else {
    log("no changes needed");
  }

  // Model-ready boot: every customer-agent gets EVERY broker provider surface
  // (anthropic:default profile + the OpenRouter and OpenAI catalogs) before
  // openclaw boots, so any catalog model is dynamically selectable. Local
  // writes (db-less-safe); the secret-resolver fetches tokens at runtime.
  if (shouldMaterializeAnthropicBrokerProfiles(process.env)) {
    const materialized = materializeBrokerProfilesForAgents(agentIdsFromConfig(config), {
      logFn: log,
      ...platformBrokerCatalogOpts(process.env),
    });
    if (materialized > 0) {
      log(`model-ready broker profiles materialized for ${materialized} agent(s)`);
    }
  }

try {
    const homeDir = process.env.HOME ?? "/home/node";
    const gitconfigPath = path.join(homeDir, ".gitconfig");
    const db = firestoreEnabled ? (await import("../lib/firebase.js")).db : null;
    await hydrateGitIdentity({
      gitconfigPath,
      agentIds: agentIdsFromConfig(config),
      fetchUserBySlug: async (slug) => {
        if (!db) return null;

const tryByField = async (
          field: string,
        ): Promise<{ displayName?: string; email?: string } | null> => {
          const snap = await withTimeout(
            db.collection("users").where(field, "==", slug).limit(1).get(),
            4000,
          );
          if (snap.empty) return null;
          const d = snap.docs[0].data() as Record<string, unknown>;
          return {
            displayName:
              typeof d.displayName === "string" ? d.displayName : undefined,
            email: typeof d.email === "string" ? d.email : undefined,
          };
        };
        return (
          (await tryByField("provisioning.openclaw.slug")) ??
          (await tryByField("username"))
        );
      },
      fileExists: (p) => {
        try {
          fs.statSync(p);
          return true;
        } catch {
          return false;
        }
      },
      writeFile: (p, c) => fs.writeFileSync(p, c, { mode: 0o644 }),
      logFn: log,
    });
  } catch (e) {
    log(
      `WARN: gitconfig hydration step failed — ${(e as Error).message} (boot continues)`,
    );
  }
}

const isEntrypoint = process.argv[1] && process.argv[1].endsWith("pre-boot-config.ts") || process.argv[1]?.endsWith("pre-boot-config.js");
function exitPreBootWithError(error: unknown): never {
  console.error(`[pre-boot] Fatal: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}

if (isEntrypoint) {
  main().catch(exitPreBootWithError);
}
