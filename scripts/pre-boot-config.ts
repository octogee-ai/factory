import * as fs from "fs";
import * as path from "path";
import {
  restoreByosubForAgents,
  agentIdsFromConfig,
} from "./lib/byosub-restore.js";

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

/**
 * Mutate `config` in place to bring it in line with gateway policy. Pure:
 * no I/O, no `process.env` reads — env is a parameter so tests can pass
 * synthetic envs without touching the real one. Returns whether anything
 * was changed; the caller decides whether to write back to disk.
 *
 * The order of patches mirrors the original inline implementation so the
 * log lines remain in the historical order operators are used to.
 */
export function applyPreBootPatches(
  config: any,
  env: NodeJS.ProcessEnv,
  logFn: (msg: string) => void = () => {},
): boolean {
  let changed = false;

  // Matches the default of a fresh `openclaw` install. Gateway policy
  // wins — a drifted value is reset to "coding" on next boot, same shape
  // as commands.native below.
  config.tools ??= {};
  if (config.tools.profile !== "coding") {
    config.tools.profile = "coding";
    changed = true;
    logFn(`set tools.profile=coding (gateway policy: openclaw "coding" defaults)`);
  }

  // REMOVED 2026-05-01: gateway.controlPlane.writeRateLimit
  // Was bumping the upstream control-plane write rate-limit (3-per-60s) to
  // 60-per-60s. The bump only worked when paired with our fork patch that
  // exposed the field as a config knob; that fork patch was dropped at the
  // v2026.4.29 roll-forward (never deployed in production, surgical reload
  // kept actual config.patch traffic well below the 3-per-60s cap on TEST).
  // Upstream still hard-codes the limit, so writing the field here is dead
  // drift — openclaw.json carried an unknown key on every boot. Bring this
  // back when (a) the upstream rate limit becomes a real bottleneck again
  // and (b) the field becomes configurable upstream or back on our fork.

  // F&F: the router has no runtime-tweakable config. All per-customer knobs
  // (enforcementOverrides, faceModelOverrides, brainModelOverrides,
  // brainGatedSlugs) were removed because every Firestore-driven write hit
  // `plugins.entries.octogee-router.config.*` → the default `plugins.*`
  // restart rule → fleet-wide MM WS bounce on every signup. Router runs on
  // built-in defaults (observe mode, no gating). Bring the knobs back via
  // applyConfigPatch + a plugin-scoped hotPrefixes declaration post-F&F.
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
    // Clean up any stale plugin config keys. These entries are harmless at
    // runtime (the router reads them with `?? {}` defaults) but leaving
    // them in the file means future `config.patch` diffs flag noise — and
    // when the knob returns, a stale shape could shadow fresh values.
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

  // Secret-rotation reconciliation: if MM_BOT_TOKEN in env differs from
  // what's on disk (k8s secret rotated since last boot), update in place.
  // Canonical location is `channels.mattermost.accounts.default.botToken`
  // (matches the template; no longer writes top-level `botToken` / `token`
  // legacy fields — OpenClaw reads from the accounts map).
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

    // Force native slash commands OFF.
    // Octogee users talk to Octo in natural language — we don't use native
    // MM slash commands (/help, /info, etc.). Leaving `commands.native` at
    // its OpenClaw default ("auto", which historically resolves false but
    // can be flipped to true by plugin capabilities) means the MM monitor
    // registers 5+ slash commands across every team on every account mount.
    // On reconnect (which happens every ~2-4 min due to upstream ping
    // dynamics) that's 50-100+ serial HTTP calls to MM per cycle — enough
    // event-loop load to miss the next WS ping window and cascade. Set both
    // channel-level and per-account `commands.native: false` so the early-
    // return in monitor-slash.ts:150-151 fires and skips the whole dance.
    mm.commands ??= {};
    if (mm.commands.native !== false) {
      mm.commands.native = false;
      changed = true;
      logFn(`forced channels.mattermost.commands.native=false (slash commands disabled)`);
    }
    // Per-account override too — monitor-slash.ts reads
    // `params.account.config.commands` which may or may not inherit from
    // the channel level depending on the plugin's resolution strategy.
    // Belt-and-suspenders: pin it on every existing account.
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

// keyRef/tokenRef are SecretRef *objects*; a string value is an inline secret.
const SECRETREF_OBJECT_KEYS = new Set(["keyRef", "tokenRef"]);

// Computed assignment of these keys can poison Object.prototype.
const PROTO_POLLUTION_KEYS = new Set(["__proto__", "constructor", "prototype"]);

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

/**
 * Reject a slow/unreachable promise so a degraded dependency cannot stall
 * the boot path. Caller treats rejection as "proceed without it".
 */
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

/**
 * Deep-merge a per-gateway `openclawOverrides` blob into the rendered
 * config. Pure: no I/O, no env. Arrays replace (not concat). Inline
 * plaintext secrets are stripped + logged. Caller runs this before
 * applyPreBootPatches so gateway policy wins. Design:
 * docs/specs/PER-GATEWAY-CONFIG-SPEC.md.
 */
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

async function applyGlmDesiredState(
  config: Record<string, unknown>,
  logFn: (msg: string) => void,
): Promise<boolean> {
  const gatewayId = process.env.GATEWAY_ID;
  if (!gatewayId) return false;
  let overridesChanged = false;
  try {
    const { db } = await import("./lib/firebase.js");
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
    const { readSecret } = await import("./lib/secret-manager.js");
    // Per-fetch 4s bound caps boot latency under tenancy; a timeout falls
    // to the catch → WARN, boot continues.
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
  // Read config in try/catch rather than existsSync-then-read — avoids
  // TOCTOU (CodeQL js/file-system-race). The writeFileSync later in this
  // function also needs this file to exist, and reading it up front means
  // we short-circuit on ENOENT before opening a Firestore connection.
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
}

// Only run main() when this file is the entrypoint, not when imported by
// tests. ESM doesn't have `require.main === module`; we check process.argv.
const isEntrypoint = process.argv[1] && process.argv[1].endsWith("pre-boot-config.ts") || process.argv[1]?.endsWith("pre-boot-config.js");
if (isEntrypoint) {
  main().catch((err) => {
    // Non-fatal — provisioner will handle it on boot
    console.error(`[pre-boot] Warning: ${err.message}`);
    process.exit(0); // Don't block gateway startup
  });
}
