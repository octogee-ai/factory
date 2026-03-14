/**
 * pre-boot-config.ts — Pre-seed restart-triggering config before OpenClaw starts.
 *
 * Queries Firestore for advisory slugs and enforcement overrides, then patches
 * openclaw.json BEFORE the gateway boots. This eliminates post-boot config writes
 * that would trigger SIGUSR1 restarts.
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
const SA_KEY_PATH = process.env.SA_KEY_PATH || path.join(OPENCLAW_DIR, "secrets", "octogee-test-sa-key.json");
const PROJECT = process.env.GOOGLE_CLOUD_PROJECT || process.env.GCLOUD_PROJECT || "octogee";

function log(msg: string): void {
  const ts = new Date().toISOString().replace("Z", "+00:00");
  console.log(`${ts} [pre-boot] ${msg}`);
}

async function main(): Promise<void> {
  if (!fs.existsSync(CONFIG_PATH)) {
    log("No openclaw.json found — skipping pre-boot config");
    return;
  }
  if (!fs.existsSync(SA_KEY_PATH)) {
    log("No SA key found — skipping pre-boot config");
    return;
  }

  // Init Firebase
  admin.initializeApp({
    credential: admin.credential.cert(SA_KEY_PATH),
    projectId: PROJECT,
  });
  const db = admin.firestore();

  // Read current config
  const config = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));

  let changed = false;

  // ── Advisory slugs ─────────────────────────────────────────────────────
  const snap = await db
    .collection("users")
    .where("provisioning.openclaw.status", "==", "complete")
    .get();

  const advisorySlugs: string[] = [];
  const enforcementOverrides: Record<string, string> = {};

  for (const doc of snap.docs) {
    const data = doc.data();
    const slug = data.provisioning?.openclaw?.slug;
    if (!slug) continue;

    // Advisory mode
    if (data.faceBrainMode === "advisory") {
      advisorySlugs.push(slug);
    }

    // Enforcement overrides
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

  const currentSlugs: string[] = config.plugins.entries["octogee-router"].config.advisorySlugs ?? [];
  if (JSON.stringify(advisorySlugs.sort()) !== JSON.stringify([...currentSlugs].sort())) {
    config.plugins.entries["octogee-router"].config.advisorySlugs = advisorySlugs;
    changed = true;
    log(`advisory slugs: [${advisorySlugs.join(", ") || "none"}]`);
  }

  const currentOverrides = config.plugins.entries["octogee-router"].config.enforcementOverrides ?? {};
  if (JSON.stringify(enforcementOverrides) !== JSON.stringify(currentOverrides)) {
    config.plugins.entries["octogee-router"].config.enforcementOverrides = enforcementOverrides;
    changed = true;
    const entries = Object.entries(enforcementOverrides);
    log(`enforcement overrides: ${entries.length ? entries.map(([s, e]) => `${s}=${e}`).join(", ") : "(all observe)"}`);
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
