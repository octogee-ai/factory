/**
 * Octogee Provisioner — Configuration & Shared Utilities
 */

import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { fileURLToPath } from "url";

// ES module compatibility
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ── Paths ───────────────────────────────────────────────────────────────────────

export const OPENCLAW_DIR    = path.join(os.homedir(), ".openclaw");
export const OPENCLAW_CONFIG = path.join(OPENCLAW_DIR, "openclaw.json");
export const AGENTS_DIR = process.env.OPENCLAW_AGENTS_DIR
  ?? path.join(OPENCLAW_DIR, "agents");

export const AGENT_PREFIX = process.env.AGENT_PREFIX ?? "octogee-";
export const GATEWAY_ID = process.env.GATEWAY_ID ?? "local";
export const CUSTOMERS_DIR = path.join(OPENCLAW_DIR, "customers");

// Templates: container default is /nucrew/templates; local dev falls back to ../templates
export const TEMPLATES_DIR = process.env.OCTOGEE_TEMPLATES_DIR || path.resolve(__dirname, "..", "..", "templates");

// Firebase credentials: explicit env var → default key file location → ADC
export const SA_KEY_PATH = process.env.GOOGLE_APPLICATION_CREDENTIALS
  ?? path.join(OPENCLAW_DIR, "secrets", "octogee-test-sa-key.json");

// ── Git-Backed Workspaces ───────────────────────────────────────────────────────

export const GITHUB_TOKEN  = process.env.GITHUB_TOKEN || "";
export const GITHUB_ORG    = process.env.GITHUB_ORG || "octogee";
export const GIT_SYNC_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

// ── Blob Sync ───────────────────────────────────────────────────────────────────

export const BLOB_SYNC_MAX_CONCURRENT = 10;
export const BLOB_SYNC_MAX_SIZE = 100 * 1024 * 1024; // 100MB

// ── Data API ────────────────────────────────────────────────────────────────────

export const DATA_API_URL = "https://dataapi-p57h3jzwfq-uc.a.run.app/data";

// ── Logging ─────────────────────────────────────────────────────────────────────

export function log(msg: string): void {
  const ts = new Date().toISOString().replace("Z", "+00:00");
  console.log(`${ts} [provisioner] ${msg}`);
}

// ── OpenClaw Config ─────────────────────────────────────────────────────────────

export function readOpenClawConfig(): any {
  return JSON.parse(fs.readFileSync(OPENCLAW_CONFIG, "utf-8"));
}

export function writeOpenClawConfig(config: any): void {
  const tmp = OPENCLAW_CONFIG + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(config, null, 2), "utf-8");
  fs.renameSync(tmp, OPENCLAW_CONFIG);
  log("openclaw.json updated — gateway will hot-reload");
}

export function agentExists(config: any, agentId: string): boolean {
  return config.agents?.list?.some((a: any) => a.id === agentId) ?? false;
}
