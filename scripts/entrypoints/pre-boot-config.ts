import * as fs from "fs";
import * as path from "path";
import { agentIdsFromConfig } from "../lib/byosub-restore.js";
import {
  materializeBrokerProfilesForAgents,
  openAiCatalogInputForBaseUrl,
  openRouterCatalogInputForBaseUrl,
} from "../lib/agent-model-token-materializer.js";
import {
  platformOpenAiEmbeddingMemorySearch,
  platformOpenAiEmbeddingsEnabled,
} from "../lib/openclaw-config-builders.js";
import { applyOpenClawConversationExperiment } from "../lib/openclaw-conversation-experiment.js";
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

const OPENCLAW_DIR = process.env.HOME
  ? path.join(process.env.HOME, ".openclaw")
  : "/home/node/.openclaw";
const CONFIG_PATH = path.join(OPENCLAW_DIR, "openclaw.json");

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

const MAC_PLATFORM_ANTHROPIC_MODEL_REF = "anthropic/claude-sonnet-4-6";
const MAC_PLATFORM_ANTHROPIC_MODEL_CONFIG = {
  alias: "sonnet",
  params: { cacheRetention: "short" },
};
const MAC_AGENT_ID_TEMPLATE = "${OPERATOR_AGENT_ID}";
const MAC_AGENT_ID_RE = /^octogee-ops-[a-z0-9][a-z0-9-]{0,62}$/;
const COACH_AGENT_ID_RE = /^octogee-[a-z0-9][a-z0-9-]{0,62}-coach$/;

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

function isMacAgentEntry(value: unknown): value is Record<string, unknown> {
  if (!isPlainObject(value)) return false;
  return (
    value.id === MAC_AGENT_ID_TEMPLATE ||
    (typeof value.id === "string" && MAC_AGENT_ID_RE.test(value.id))
  );
}

function isCoachAgentEntry(value: unknown): value is Record<string, unknown> & { id: string } {
  return isPlainObject(value) && typeof value.id === "string" && COACH_AGENT_ID_RE.test(value.id);
}

function isOperatorRuntime(env: NodeJS.ProcessEnv): boolean {
  return env.GATEWAY_CLASS === "operator" || env.GATEWAY_PROFILE === "operator";
}

function setRecordProperty(
  record: Record<string, unknown>,
  key: string,
  value: unknown,
): boolean {
  if (record[key] === value) return false;
  record[key] = value;
  return true;
}

function ensureMacAnthropicProfile(config: OpenClawConfig): {
  changed: boolean;
  available: boolean;
} {
  const auth = ensureNullishObjectProperty(config, "auth");
  const profiles = auth ? ensureNullishObjectProperty(auth, "profiles") : null;
  if (!profiles) return { changed: false, available: false };

  const currentProfile = objectProperty(profiles, "anthropic:default");
  if (!currentProfile) {
    profiles["anthropic:default"] = { provider: "anthropic", mode: "api_key" };
    return { changed: true, available: true };
  }

  const changed = [
    setRecordProperty(currentProfile, "provider", "anthropic"),
    setRecordProperty(currentProfile, "mode", "api_key"),
  ].some(Boolean);
  return { changed, available: true };
}

function macPinLogMessage(profileAvailable: boolean): string {
  const base = `Mac pinned to ${MAC_PLATFORM_ANTHROPIC_MODEL_REF}`;
  return profileAvailable
    ? `${base} on anthropic:default`
    : `${base} (auth profile not repaired: invalid auth/profiles shape)`;
}

function ensureMacModelAllowlist(agents: Record<string, unknown>): boolean {
  const defaults = ensureNullishObjectProperty(agents, "defaults");
  const models = defaults ? ensureNullishObjectProperty(defaults, "models") : null;
  if (!models) return false;
  if (
    JSON.stringify(models[MAC_PLATFORM_ANTHROPIC_MODEL_REF]) ===
    JSON.stringify(MAC_PLATFORM_ANTHROPIC_MODEL_CONFIG)
  ) {
    return false;
  }

  models[MAC_PLATFORM_ANTHROPIC_MODEL_REF] = MAC_PLATFORM_ANTHROPIC_MODEL_CONFIG;
  return true;
}

function pinMacAgentModels(macAgents: Record<string, unknown>[]): boolean {
  return macAgents
    .map((agent) => setRecordProperty(agent, "model", MAC_PLATFORM_ANTHROPIC_MODEL_REF))
    .some(Boolean);
}

function pinOperatorMacSubagentModel(
  agents: Record<string, unknown>,
  env: NodeJS.ProcessEnv,
): boolean {
  if (!isOperatorRuntime(env)) return false;
  const defaults = objectProperty(agents, "defaults");
  const subagents = defaults ? objectProperty(defaults, "subagents") : null;
  return subagents
    ? setRecordProperty(subagents, "model", MAC_PLATFORM_ANTHROPIC_MODEL_REF)
    : false;
}

export function applyMacPlatformAnthropicPin(
  config: OpenClawConfig,
  env: NodeJS.ProcessEnv,
  logFn: (msg: string) => void,
): boolean {
  const agents = objectProperty(config, "agents");
  if (!agents) return false;

  const list = Array.isArray(agents.list) ? agents.list : [];
  const macAgents = list.filter(isMacAgentEntry);
  if (macAgents.length === 0) return false;

  const profile = ensureMacAnthropicProfile(config);
  const changed = [
    profile.changed,
    ensureMacModelAllowlist(agents),
    pinMacAgentModels(macAgents),
    pinOperatorMacSubagentModel(agents, env),
  ].some(Boolean);

  if (changed) {
    logFn(macPinLogMessage(profile.available));
  }
  return changed;
}

export function applyMattermostPreBootPatches(
  config: OpenClawConfig,
  env: NodeJS.ProcessEnv,
  logFn: (msg: string) => void,
): boolean {
  const mattermost = objectProperty(objectProperty(config, "channels"), "mattermost");
  if (!mattermost) return false;
  let changed = false;

  if (env.MM_BOT_TOKEN) {
    const accounts = ensureNullishObjectProperty(mattermost, "accounts");
    const defaultAccount = accounts
      ? ensureNullishObjectProperty(accounts, "default")
      : null;
    if (defaultAccount && defaultAccount.botToken !== env.MM_BOT_TOKEN) {
      defaultAccount.botToken = env.MM_BOT_TOKEN;
      changed = true;
      logFn(`MM bot token synced into accounts.default from MM_BOT_TOKEN env var`);
    }
  }

  if (env.MM_URL && mattermost.baseUrl !== env.MM_URL) {
    mattermost.baseUrl = env.MM_URL;
    changed = true;
    logFn(`MM baseUrl synced from MM_URL env var: ${env.MM_URL}`);
  }

  const commands = ensureNullishObjectProperty(mattermost, "commands");
  if (commands && commands.native !== false) {
    commands.native = false;
    changed = true;
    logFn(`forced channels.mattermost.commands.native=false (slash commands disabled)`);
  }

  const accounts = objectProperty(mattermost, "accounts");
  if (!accounts) return changed;
  for (const [accountId, account] of Object.entries(accounts)) {
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

export function applyPreBootPatches(
  config: OpenClawConfig,
  env: NodeJS.ProcessEnv,
  logFn: (msg: string) => void = () => {},
): boolean {
  return [
    applyToolsProfilePatch(config, logFn),
    applyMattermostPreBootPatches(config, env, logFn),
    applyOpenClawConversationExperiment(config, env.OCTOGEE_ACTIVITY_BRIDGE_MODE),
    applyMacPlatformAnthropicPin(config, env, logFn),
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
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), "utf-8");
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
if (isEntrypoint) {
  main().catch((err) => {
    
    console.error(`[pre-boot] Warning: ${err.message}`);
    process.exit(0); 
  });
}
