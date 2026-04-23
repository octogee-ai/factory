/**
 * pre-boot-config.ts — patch openclaw.json before OpenClaw starts.
 *
 * Runs once at container startup from entrypoint.sh. Responsibilities:
 *   - Strip stale octogee-router plugin config keys (F&F: no runtime syncs).
 *   - Reconcile MM bot token + baseUrl + native-commands from env into
 *     `channels.mattermost.accounts.*` — the secret-rotation path that
 *     previously required a post-boot restart.
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

function log(msg: string): void {
  const ts = new Date().toISOString().replace("Z", "+00:00");
  console.log(`${ts} [pre-boot] ${msg}`);
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
  // Parse config (already read up top to short-circuit on ENOENT). Firestore
  // is no longer queried here — the enforcement-override sync that required
  // it was removed for F&F (see banner below).
  const config = JSON.parse(configRaw);

  let changed = false;

  // ── Octogee Router plugin config ────────────────────────────────────────
  // F&F: the router has no runtime-tweakable config. All per-customer knobs
  // (enforcementOverrides, faceModelOverrides, brainModelOverrides,
  // brainGatedSlugs) were removed because every Firestore-driven write hit
  // `plugins.entries.octogee-router.config.*` → the default `plugins.*`
  // restart rule → fleet-wide MM WS bounce on every signup. Router runs on
  // built-in defaults (observe mode, no gating). Bring the knobs back via
  // applyConfigPatch + a plugin-scoped hotPrefixes declaration post-F&F.
  if (process.env.OCTOGEE_ROUTER_ENABLED === "false") {
    if (config.plugins?.allow && Array.isArray(config.plugins.allow)) {
      config.plugins.allow = config.plugins.allow.filter((id: string) => id !== "octogee-router");
      changed = true;
    }
    if (config.plugins?.entries?.["octogee-router"]) {
      delete config.plugins.entries["octogee-router"];
      changed = true;
      log("removed octogee-router from config because OCTOGEE_ROUTER_ENABLED=false");
    }
  } else {
    // Clean up any stale plugin config keys. These entries are harmless at
    // runtime (the router reads them with `?? {}` defaults) but leaving
    // them in the file means future `config.patch` diffs flag noise — and
    // when the knob returns, a stale shape could shadow fresh values.
    const staleKeys = [
      "advisorySlugs",
      "enforcementOverrides",
      "brainGatedSlugs",
      "faceModelOverrides",
      "brainModelOverrides",
    ];
    const pluginCfg = config.plugins?.entries?.["octogee-router"]?.config;
    if (pluginCfg && typeof pluginCfg === "object") {
      for (const key of staleKeys) {
        if (pluginCfg[key] !== undefined) {
          delete pluginCfg[key];
          changed = true;
          log(`removed stale ${key} from octogee-router config (F&F: runtime syncs disabled)`);
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
  const envBotToken = process.env.MM_BOT_TOKEN;
  const envMmUrl = process.env.MM_URL;
  if (config.channels?.mattermost) {
    const mm = config.channels.mattermost;
    if (envBotToken) {
      mm.accounts ??= {};
      mm.accounts.default ??= {};
      if (mm.accounts.default.botToken !== envBotToken) {
        mm.accounts.default.botToken = envBotToken;
        changed = true;
        log(`MM bot token synced into accounts.default from MM_BOT_TOKEN env var`);
      }
    }
    if (envMmUrl && mm.baseUrl !== envMmUrl) {
      mm.baseUrl = envMmUrl;
      changed = true;
      log(`MM baseUrl synced from MM_URL env var: ${envMmUrl}`);
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
      log(`forced channels.mattermost.commands.native=false (slash commands disabled)`);
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
          log(`forced commands.native=false on accounts.${accountId}`);
        }
      }
    }
  }

  if (changed) {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), "utf-8");
    log("openclaw.json patched with env / stale-key cleanup");
  } else {
    log("no changes needed");
  }
}

main().catch((err) => {
  // Non-fatal — provisioner will handle it on boot
  console.error(`[pre-boot] Warning: ${err.message}`);
  process.exit(0); // Don't block gateway startup
});
