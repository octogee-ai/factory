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
export const GATEWAY_PROFILE = process.env.GATEWAY_PROFILE ?? "default";
export const GATEWAY_CLASS = process.env.GATEWAY_CLASS ?? "";

export function isOperatorGateway(): boolean {
  return GATEWAY_PROFILE === "operator";
}

export function usesLlmBrokerToken(): boolean {
  return GATEWAY_CLASS === "builder" || GATEWAY_CLASS === "operator";
}
export const CUSTOMERS_DIR = path.join(OPENCLAW_DIR, "customers");
export const CUSTOMER_KEYS_DIR = path.join(OPENCLAW_DIR, "customer-keys");

export const TEMPLATES_DIR = process.env.OCTOGEE_TEMPLATES_DIR || path.resolve(__dirname, "..", "..", "templates");

// eslint-disable-next-line sonarjs/no-clear-text-protocols -- in-cluster ClusterIP, not internet-exposed
export const GIT_API_URL = process.env.GIT_API_URL || "http://gitea-http.octogee.svc.cluster.local:3000/api/v1";
export const GIT_ORG = process.env.GIT_ORG || "octogee";
export const GIT_SSH_HOST = "gitea";
export const GIT_SYNC_INTERVAL_MS = 5 * 60 * 1000;

export const GITHUB_TOKEN = process.env.GITHUB_TOKEN || "";

export const GITHUB_ORG = process.env.GIT_ORG || process.env.GITHUB_ORG || "octogee";

export const BLOB_SYNC_MAX_CONCURRENT = 10;
export const BLOB_SYNC_MAX_SIZE = 100 * 1024 * 1024;

export function log(msg: string): void {
  const ts = new Date().toISOString().replace("Z", "+00:00");
  console.log(`${ts} [provisioner] ${msg}`);
}

export function logLevel(): string {
  return (process.env.LOG_LEVEL ?? "info").toLowerCase();
}

export function dlog(msg: string): void {
  if (logLevel() === "debug") log(msg);
}

export function bootBanner(component: string): string {
  return (
    `boot ${component} sha=${process.env.BUILD_SHA ?? "unknown"}` +
    ` oc=${process.env.OPENCLAW_VERSION ?? "n/a"}` +
    ` fork=${process.env.OPENCLAW_FORK_SHA ?? "n/a"}` +
    ` node=${process.version} logLevel=${logLevel()}` +
    ` ts=${new Date().toISOString()}`
  );
}

export interface OpenClawAgentConfig {
  id: string;
  model?: string;
  heartbeat?: unknown;
  tools?: {
    fs?: { workspaceOnly?: boolean };
    deny?: string[];
  };
}

export interface OpenClawConfig {
  channels?: Record<string, unknown>;
  agents?: {
    defaults?: {
      maxConcurrent?: number;
      verboseDefault?: string;
      subagents?: {
        maxConcurrent?: number;
        model?: string;
        runTimeoutSeconds?: number;
      };
    };
    list?: OpenClawAgentConfig[];
  };
  tools?: {
    subagents?: {
      tools?: {
        deny?: string[];
      };
    };
    elevated?: { enabled?: boolean };
  };
  gateway?: {
    auth?: {
      rateLimit?: {
        maxAttempts: number;
        windowMs: number;
        lockoutMs: number;
      };
    };
  };
}

export function readOpenClawConfig(): OpenClawConfig {
  const config = JSON.parse(fs.readFileSync(OPENCLAW_CONFIG, "utf-8")) as unknown;
  if (!isRecord(config)) throw new Error("openclaw.json must contain a JSON object");
  return config as OpenClawConfig;
}

export function writeOpenClawConfig(
  config: unknown,
  configPath: string = OPENCLAW_CONFIG,
): void {
  const tmp = configPath + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(config, null, 2), "utf-8");
  fs.renameSync(tmp, configPath);
  log("openclaw.json updated — gateway will hot-reload");
}

export function agentExists(config: unknown, agentId: string): boolean {
  const agents = isRecord(config) && isRecord(config.agents) ? config.agents.list : undefined;
  return Array.isArray(agents) && agents.some((agent) => isAgentWithId(agent, agentId));
}

function isAgentWithId(agent: unknown, agentId: string): boolean {
  return isRecord(agent) && agent.id === agentId;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
