/**
 * pre-boot-config.ts — Pre-seed restart-triggering config before OpenClaw starts.
 *
 * Queries Firestore for enforcement overrides, then patches openclaw.json
 * BEFORE the gateway boots. This eliminates post-boot config writes that
 * would trigger SIGUSR1 restarts.
 *
 * Runs once at container startup (called from entrypoint.sh).
 * The provisioner's Firestore watchers still handle runtime changes.
 */

import * as admin from "firebase-admin";
import * as fs from "fs";
import * as path from "path";

const OPENCLAW_DIR = process.env.HOME
  ? path.join(process.env.HOME, ".openclaw")
  : "/home/node/.openclaw";
const CONFIG_PATH = path.join(OPENCLAW_DIR, "openclaw.json");
const SA_KEY_PATH = process.env.SA_KEY_PATH || process.env.GOOGLE_APPLICATION_CREDENTIALS || path.join(OPENCLAW_DIR, "secrets", "octogee-test-sa-key.json");
const PROJECT = process.env.FIREBASE_PROJECT_ID || process.env.GOOGLE_CLOUD_PROJECT || process.env.GCLOUD_PROJECT || "octogee";

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
  // Init Firebase — use SA key if available, otherwise ADC (Workload Identity)
  if (fs.existsSync(SA_KEY_PATH)) {
    admin.initializeApp({
      credential: admin.credential.cert(SA_KEY_PATH),
      projectId: PROJECT,
    });
  } else {
    log("No SA key file — using Application Default Credentials (Workload Identity)");
    admin.initializeApp({ projectId: PROJECT });
  }
  const db = admin.firestore();

  // Parse config (already read up top to short-circuit on ENOENT)
  const config = JSON.parse(configRaw);

  let changed = false;

  // ── Enforcement overrides ───────────────────────────────────────────────
  const snap = await db
    .collection("users")
    .where("provisioning.openclaw.status", "==", "complete")
    .get();

  const enforcementOverrides: Record<string, string> = {};

  for (const doc of snap.docs) {
    const data = doc.data();
    const slug = data.provisioning?.openclaw?.slug;
    if (!slug) continue;

    const enforcement = data.faceBrainEnforcement;
    if (enforcement && ["off", "soft", "hard"].includes(enforcement)) {
      enforcementOverrides[slug] = enforcement;
    }
  }

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
    // Patch plugin config
    config.plugins ??= {};
    config.plugins.entries ??= {};
    config.plugins.entries["octogee-router"] ??= {};
    config.plugins.entries["octogee-router"].config ??= {};

    // Clean up stale advisorySlugs key if present (advisory mode removed)
    if (config.plugins.entries["octogee-router"].config.advisorySlugs !== undefined) {
      delete config.plugins.entries["octogee-router"].config.advisorySlugs;
      changed = true;
      log("removed stale advisorySlugs from config");
    }

    const currentOverrides = config.plugins.entries["octogee-router"].config.enforcementOverrides ?? {};
    if (JSON.stringify(enforcementOverrides) !== JSON.stringify(currentOverrides)) {
      config.plugins.entries["octogee-router"].config.enforcementOverrides = enforcementOverrides;
      changed = true;
      const entries = Object.entries(enforcementOverrides);
      const overrideSummary = entries.length
        ? entries.map(([s, e]) => `${s}=${e}`).join(", ")
        : "(all observe)";
      log(`enforcement overrides: ${overrideSummary}`);
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
    log("openclaw.json patched with Firestore state");
  } else {
    log("no changes needed — config matches Firestore state");
  }

  // Clean shutdown
  await admin.app().delete();
}

main().catch((err) => {
  // Non-fatal — provisioner will handle it on boot
  console.error(`[pre-boot] Warning: ${err.message}`);
  process.exit(0); // Don't block gateway startup
});
