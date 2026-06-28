import * as fs from "fs";
import * as path from "path";
import {
  restoreByosubForAgents,
  agentIdsFromConfig,
} from "../lib/byosub-restore.js";
import { materializeAnthropicBrokerForAgents } from "../lib/agent-model-token-materializer.js";
import {
  claudeCliRuntimeConfig,
  codexRuntimeConfig,
} from "../lib/model-credential-materializer.js";

const OPENCLAW_DIR = process.env.HOME
  ? path.join(process.env.HOME, ".openclaw")
  : "/home/node/.openclaw";
const CONFIG_PATH = path.join(OPENCLAW_DIR, "openclaw.json");

function log(msg: string): void {
  const ts = new Date().toISOString().replace("Z", "+00:00");
  console.log(`${ts} [pre-boot] ${msg}`);
}

function claudeCliNativeHomeDirForGateway(): string | undefined {
  const gatewayClass = process.env.GATEWAY_CLASS ?? "";
  const profile = process.env.GATEWAY_PROFILE ?? "";
  if (gatewayClass === "builder" || gatewayClass === "operator" || profile === "operator") {
    return process.env.HOME ?? "/home/node";
  }
  return undefined;
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

type OpenClawConfig = Record<string, unknown>;
type ByosubProvider = "openai" | "anthropic";

interface ByosubProviderRef {
  provider?: unknown;
  secretName?: unknown;
}

interface ByosubAgentRef {
  providers?: Partial<Record<ByosubProvider, ByosubProviderRef>>;
}

type GatewayByosubRefs = Record<string, ByosubAgentRef>;

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

export function applyPreBootPatches(
  config: OpenClawConfig,
  env: NodeJS.ProcessEnv,
  logFn: (msg: string) => void = () => {},
): boolean {
  return [
    applyToolsProfilePatch(config, logFn),
    applyMattermostPreBootPatches(config, env, logFn),
    applyAnthropicBaseUrlPatch(config, env, logFn),
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

const STANDARD_CODEX_APP_SERVER = {
  sandbox: "workspace-write",
  approvalPolicy: "never",
};

function configuredByosubProviders(
  byosub: GatewayByosubRefs | undefined,
  agentIds: readonly string[],
): Set<ByosubProvider> {
  const out = new Set<ByosubProvider>();
  for (const agentId of agentIds) {
    const providers = byosub?.[agentId]?.providers;
    if (!providers) continue;
    for (const provider of ["openai", "anthropic"] as const) {
      const ref = providers[provider];
      if (ref?.provider === provider && typeof ref.secretName === "string" && ref.secretName) {
        out.add(provider);
      }
    }
  }
  return out;
}

function applyRuntimeModelDef(
  config: Record<string, unknown>,
  modelDef: Record<string, unknown>,
): boolean {
  const agents = ensureNullishObjectProperty(config, "agents");
  const defaults = agents ? ensureNullishObjectProperty(agents, "defaults") : null;
  const models = defaults ? ensureNullishObjectProperty(defaults, "models") : null;
  if (!models) return false;
  return deepMergeInto(models, modelDef);
}

function applyCodexRuntimePlugin(config: Record<string, unknown>): boolean {
  const plugins = ensureNullishObjectProperty(config, "plugins");
  const entries = plugins ? ensureNullishObjectProperty(plugins, "entries") : null;
  const codex = entries ? ensureNullishObjectProperty(entries, "codex") : null;
  const codexConfig = codex ? ensureNullishObjectProperty(codex, "config") : null;
  const appServer = codexConfig ? ensureNullishObjectProperty(codexConfig, "appServer") : null;
  if (!codex || !appServer) return false;
  let changed = false;
  if (codex.enabled !== true) {
    codex.enabled = true;
    changed = true;
  }
  if (
    appServer.sandbox === undefined &&
    !valueEqual(appServer.sandbox, STANDARD_CODEX_APP_SERVER.sandbox)
  ) {
    appServer.sandbox = STANDARD_CODEX_APP_SERVER.sandbox;
    changed = true;
  }
  if (
    appServer.approvalPolicy === undefined &&
    !valueEqual(appServer.approvalPolicy, STANDARD_CODEX_APP_SERVER.approvalPolicy)
  ) {
    appServer.approvalPolicy = STANDARD_CODEX_APP_SERVER.approvalPolicy;
    changed = true;
  }
  return changed;
}

export function applyByosubRuntimeAllowlist(
  config: Record<string, unknown>,
  byosub: GatewayByosubRefs | undefined,
  agentIds: readonly string[],
  logFn: (msg: string) => void = () => {},
): boolean {
  const providers = configuredByosubProviders(byosub, agentIds);
  let changed = false;

  if (providers.has("openai")) {
    if (applyRuntimeModelDef(config, codexRuntimeConfig().modelsDef)) changed = true;
    if (applyCodexRuntimePlugin(config)) changed = true;
  }
  if (providers.has("anthropic")) {
    if (applyRuntimeModelDef(config, claudeCliRuntimeConfig().modelsDef)) changed = true;
  }
  if (changed) {
    logFn(
      `BYOSUB runtime models allowlisted for ${[...providers].sort().join(", ")}`,
    );
  }
  return changed;
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

async function applyGlmDesiredState(
  config: Record<string, unknown>,
  logFn: (msg: string) => void,
): Promise<boolean> {
  const gatewayId = process.env.GATEWAY_ID;
  if (!gatewayId) return false;
  let overridesChanged = false;
  try {
    const { db } = await import("../lib/firebase.js");
    const snap = await withTimeout(
      db.collection("glmGateways").doc(gatewayId).get(),
      4000,
    );
    const data = snap.exists
      ? (snap.data() as { openclawOverrides?: unknown; byosub?: GatewayByosubRefs } | undefined)
      : undefined;
    if (data?.openclawOverrides) {
      overridesChanged = applyGatewayOverrides(
        config,
        data.openclawOverrides,
        logFn,
      );
      if (overridesChanged) {
        logFn(`applied openclawOverrides from glmGateways/${gatewayId}`);
      }
    }
    const { readSecret } = await import("../lib/secret-manager.js");

    const agentIds = agentIdsFromConfig(config);
    const allowlistChanged = applyByosubRuntimeAllowlist(
      config,
      data?.byosub,
      agentIds,
      logFn,
    );
    const claudeCliNativeHomeDir = claudeCliNativeHomeDirForGateway();
    const r = await restoreByosubForAgents({
      agentIds,
      byosub: data?.byosub,
      openclawDir: OPENCLAW_DIR,
      fetchSecret: (name) => withTimeout(readSecret(name), 4000),
      logFn,
      ...(claudeCliNativeHomeDir ? { claudeCliNativeHomeDir } : {}),
    });
    if (r.planned > 0) {
      logFn(
        `byosub: restore complete for glmGateways/${gatewayId} — ${r.restored} restored, ${r.failed} failed`,
      );
    }
    if (allowlistChanged) overridesChanged = true;
  } catch (e) {
    logFn(
      `WARN: could not fetch/apply glmGateways/${gatewayId} openclawOverrides/byosub — booting on template + policy only: ${(e as Error).message}`,
    );
  }
  return overridesChanged;
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
    ? await applyGlmDesiredState(config, log)
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

  // Shared (multi-tenant) pods serve every customer-agent's anthropic through the
  // broker with its OWN per-customer token — materialize each agent's
  // anthropic:default broker-token profile before openclaw boots. Local write
  // (db-less-safe); the secret-resolver fetches the token at runtime.
  if (shouldMaterializeAnthropicBrokerProfiles(process.env)) {
    const materialized = materializeAnthropicBrokerForAgents(agentIdsFromConfig(config), {
      logFn: log,
    });
    if (materialized > 0) {
      log(`anthropic broker-token profiles materialized for ${materialized} agent(s)`);
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
