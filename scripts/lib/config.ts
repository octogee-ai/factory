import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const OPENCLAW_DIR    = path.join(os.homedir(), ".openclaw");
export const OPENCLAW_CONFIG = path.join(OPENCLAW_DIR, "openclaw.json");
export const AGENTS_DIR = process.env.OPENCLAW_AGENTS_DIR
  ?? path.join(OPENCLAW_DIR, "agents");

export const AGENT_PREFIX = process.env.AGENT_PREFIX ?? "octogee-";
export const GATEWAY_ID = process.env.GATEWAY_ID ?? "local";
export const CUSTOMERS_DIR = path.join(OPENCLAW_DIR, "customers");
export const CUSTOMER_KEYS_DIR = path.join(OPENCLAW_DIR, "customer-keys");

export const TEMPLATES_DIR = process.env.OCTOGEE_TEMPLATES_DIR || path.resolve(__dirname, "..", "..", "templates");

export const SA_KEY_PATH = process.env.GOOGLE_APPLICATION_CREDENTIALS
  ?? path.join(OPENCLAW_DIR, "secrets", "octogee-test-sa-key.json");

// eslint-disable-next-line sonarjs/no-clear-text-protocols -- in-cluster ClusterIP, not internet-exposed
export const GIT_API_URL = process.env.GIT_API_URL || "http://gitea-http.octogee.svc.cluster.local:3000/api/v1";
export const GIT_API_TOKEN = process.env.GIT_API_TOKEN || "";
export const GIT_ORG = process.env.GIT_ORG || "octogee";
export const GIT_SSH_HOST = "gitea";
export const GIT_SYNC_INTERVAL_MS = 5 * 60 * 1000;

/** @deprecated Use GIT_API_TOKEN */
export const GITHUB_TOKEN = process.env.GIT_API_TOKEN || process.env.GITHUB_TOKEN || "";
/** @deprecated Use GIT_ORG */
export const GITHUB_ORG = process.env.GIT_ORG || process.env.GITHUB_ORG || "octogee";

export const BLOB_SYNC_MAX_CONCURRENT = 10;
export const BLOB_SYNC_MAX_SIZE = 100 * 1024 * 1024;

export const DATA_API_URL = "https://dataapi-p57h3jzwfq-uc.a.run.app/data";

export function log(msg: string): void {
  const ts = new Date().toISOString().replace("Z", "+00:00");
  console.log(`${ts} [provisioner] ${msg}`);
}

export function readOpenClawConfig(): any {
  return JSON.parse(fs.readFileSync(OPENCLAW_CONFIG, "utf-8"));
}

export function writeOpenClawConfig(
  config: any,
  configPath: string = OPENCLAW_CONFIG,
): void {
  const tmp = configPath + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(config, null, 2), "utf-8");
  fs.renameSync(tmp, configPath);
  log("openclaw.json updated — gateway will hot-reload");
}

export function agentExists(config: any, agentId: string): boolean {
  return config.agents?.list?.some((a: any) => a.id === agentId) ?? false;
}
