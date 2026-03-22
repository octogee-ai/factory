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
  if (!fs.existsSync(CONFIG_PATH)) {
    log("No openclaw.json found — skipping pre-boot config");
    return;
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

  // Read current config
  const config = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));

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
    log(`enforcement overrides: ${entries.length ? entries.map(([s, e]) => `${s}=${e}`).join(", ") : "(all observe)"}`);
  }

  // ── MM bot token sync ───────────────────────────────────────────────────
  // OpenClaw uses BOTH `channels.mattermost.botToken` AND `channels.mattermost.token`.
  // If MM was re-bootstrapped (new token in K8s secret), both fields must be updated
  // or the gateway will send the stale token and get 401 on every WebSocket connect.
  const envBotToken = process.env.MM_BOT_TOKEN;
  const envMmUrl = process.env.MM_URL;
  if (config.channels?.mattermost) {
    const mm = config.channels.mattermost;
    if (envBotToken && (mm.botToken !== envBotToken || mm.token !== envBotToken)) {
      mm.botToken = envBotToken;
      mm.token = envBotToken;
      changed = true;
      log(`MM bot token synced from MM_BOT_TOKEN env var`);
    }
    if (envMmUrl && mm.baseUrl !== envMmUrl) {
      mm.baseUrl = envMmUrl;
      changed = true;
      log(`MM baseUrl synced from MM_URL env var: ${envMmUrl}`);
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
