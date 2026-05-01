/**
 * pre-boot-config.ts — patch openclaw.json before OpenClaw starts.
 *
 * Runs once at container startup from entrypoint.sh. Responsibilities:
 *   - Reconcile gateway-wide `tools.profile = "coding"` so every agent
 *     starts with the same tool defaults as a fresh `openclaw` install.
 *   - Strip stale octogee-router plugin config keys (F&F: no runtime syncs).
 *   - Reconcile MM bot token + baseUrl + native-commands from env into
 *     `channels.mattermost.accounts.*` — the secret-rotation path that
 *     previously required a post-boot restart.
 *
 * The patching logic is exported as a pure function so it can be unit-
 * tested without touching the filesystem. `main()` is the I/O wrapper.
 *
 * No Firestore queries live here anymore — the enforcement-override sync
 * that required them was removed (see banner in the router-config section
 * below).
 */

import * as fs from "fs";
import * as path from "path";

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

  // ── tools.profile = "coding" ────────────────────────────────────────────
  // Matches the default of a fresh `openclaw` install. Gateway policy
  // wins — a drifted value is reset to "coding" on next boot, same shape
  // as commands.native below.
  config.tools ??= {};
  if (config.tools.profile !== "coding") {
    config.tools.profile = "coding";
    changed = true;
    logFn(`set tools.profile=coding (gateway policy: openclaw "coding" defaults)`);
  }

  // ── REMOVED 2026-05-01: gateway.controlPlane.writeRateLimit ──────────────
  // Was bumping the upstream control-plane write rate-limit (3-per-60s) to
  // 60-per-60s. The bump only worked when paired with our fork patch that
  // exposed the field as a config knob; that fork patch was dropped at the
  // v2026.4.29 roll-forward (never deployed in production, surgical reload
  // kept actual config.patch traffic well below the 3-per-60s cap on TEST).
  // Upstream still hard-codes the limit, so writing the field here is dead
  // drift — openclaw.json carried an unknown key on every boot. Bring this
  // back when (a) the upstream rate limit becomes a real bottleneck again
  // and (b) the field becomes configurable upstream or back on our fork.

  // ── Octogee Router plugin config ────────────────────────────────────────
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

  // ── MM bot token + baseUrl sync ─────────────────────────────────────────
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

    // ── Force native slash commands OFF ────────────────────────────────────
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

  const changed = applyPreBootPatches(config, process.env, log);

  if (changed) {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), "utf-8");
    log("openclaw.json patched with env / stale-key cleanup");
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
