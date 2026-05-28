import * as fs from "fs";
import * as path from "path";
import {
  restoreByosubForAgents,
  agentIdsFromConfig,
} from "../lib/byosub-restore.js";

const OPENCLAW_DIR = process.env.HOME
  ? path.join(process.env.HOME, ".openclaw")
  : "/home/node/.openclaw";
const CONFIG_PATH = path.join(OPENCLAW_DIR, "openclaw.json");

const STALE_ROUTER_CONFIG_KEYS = [
  "advisorySlugs",
  "enforcementOverrides",
  "brainGatedSlugs",
  "faceModelOverrides",
  "brainModelOverrides",
];

function log(msg: string): void {
  const ts = new Date().toISOString().replace("Z", "+00:00");
  console.log(`${ts} [pre-boot] ${msg}`);
}

export function applyPreBootPatches(
  config: any,
  env: NodeJS.ProcessEnv,
  logFn: (msg: string) => void = () => {},
): boolean {
  let changed = false;

config.tools ??= {};
  if (config.tools.profile !== "coding") {
    config.tools.profile = "coding";
    changed = true;
    logFn(`set tools.profile=coding (gateway policy: openclaw "coding" defaults)`);
  }

if (env.OCTOGEE_ROUTER_ENABLED === "false") {
    if (config.plugins?.allow && Array.isArray(config.plugins.allow)) {
      const before = config.plugins.allow.length;
      config.plugins.allow = config.plugins.allow.filter(
        (id: string) => id !== "octogee-router",
      );
      if (config.plugins.allow.length !== before) changed = true;
    }
    if (config.plugins?.entries?.["octogee-router"]) {
      delete config.plugins.entries["octogee-router"];
      changed = true;
      logFn("removed octogee-router from config because OCTOGEE_ROUTER_ENABLED=false");
    }
  } else {

const pluginCfg = config.plugins?.entries?.["octogee-router"]?.config;
    if (pluginCfg && typeof pluginCfg === "object") {
      for (const key of STALE_ROUTER_CONFIG_KEYS) {
        if (pluginCfg[key] !== undefined) {
          delete pluginCfg[key];
          changed = true;
          logFn(`removed stale ${key} from octogee-router config (F&F: runtime syncs disabled)`);
        }
      }
    }
  }

const envBotToken = env.MM_BOT_TOKEN;
  const envMmUrl = env.MM_URL;
  if (config.channels?.mattermost) {
    const mm = config.channels.mattermost;
    if (envBotToken) {
      mm.accounts ??= {};
      mm.accounts.default ??= {};
      if (mm.accounts.default.botToken !== envBotToken) {
        mm.accounts.default.botToken = envBotToken;
        changed = true;
        logFn(`MM bot token synced into accounts.default from MM_BOT_TOKEN env var`);
      }
    }
    if (envMmUrl && mm.baseUrl !== envMmUrl) {
      mm.baseUrl = envMmUrl;
      changed = true;
      logFn(`MM baseUrl synced from MM_URL env var: ${envMmUrl}`);
    }

mm.commands ??= {};
    if (mm.commands.native !== false) {
      mm.commands.native = false;
      changed = true;
      logFn(`forced channels.mattermost.commands.native=false (slash commands disabled)`);
    }

if (mm.accounts && typeof mm.accounts === "object") {
      for (const [accountId, account] of Object.entries(mm.accounts as Record<string, any>)) {
        if (!account || typeof account !== "object") continue;
        account.commands ??= {};
        if (account.commands.native !== false) {
          account.commands.native = false;
          changed = true;
          logFn(`forced commands.native=false on accounts.${accountId}`);
        }
      }
    }
  }

  return changed;
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
      ? (snap.data() as
          | {
              openclawOverrides?: unknown;
              byosub?: Record<
                string,
                { provider: "openai" | "anthropic"; secretName: string }
              >;
            }
          | undefined)
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

const r = await restoreByosubForAgents({
      agentIds: agentIdsFromConfig(config),
      byosub: data?.byosub,
      openclawDir: OPENCLAW_DIR,
      fetchSecret: (name) => withTimeout(readSecret(name), 4000),
      logFn,
    });
    if (r.planned > 0) {
      logFn(
        `byosub: restore complete for glmGateways/${gatewayId} — ${r.restored} restored, ${r.failed} failed`,
      );
    }
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

  const overridesChanged = await applyGlmDesiredState(config, log);

  const policyChanged = applyPreBootPatches(config, process.env, log);

  if (overridesChanged || policyChanged) {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), "utf-8");
    log("openclaw.json patched (per-gateway overrides / env / stale-key cleanup)");
  } else {
    log("no changes needed");
  }

try {
    const homeDir = process.env.HOME ?? "/home/node";
    const gitconfigPath = path.join(homeDir, ".gitconfig");
    const { db } = await import("../lib/firebase.js");
    await hydrateGitIdentity({
      gitconfigPath,
      agentIds: agentIdsFromConfig(config),
      fetchUserBySlug: async (slug) => {

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
          // eslint-disable-next-line security/detect-non-literal-fs-filename -- p is path.join(HOME, ".gitconfig"), trusted-internal
          fs.statSync(p);
          return true;
        } catch {
          return false;
        }
      },
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- p is path.join(HOME, ".gitconfig"), trusted-internal
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
