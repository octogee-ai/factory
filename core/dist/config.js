import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { fileURLToPath } from "url";
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
export const OPENCLAW_DIR = process.env.OPENCLAW_DIR?.trim()
    || path.join(os.homedir(), ".openclaw");
export const OPENCLAW_CONFIG = process.env.OPENCLAW_CONFIG_PATH?.trim()
    || path.join(OPENCLAW_DIR, "openclaw.json");
export const AGENTS_DIR = process.env.OPENCLAW_AGENTS_DIR
    ?? path.join(OPENCLAW_DIR, "agents");
export const AGENT_PREFIX = process.env.AGENT_PREFIX ?? "octogee-";
export const GATEWAY_ID = process.env.GATEWAY_ID ?? "local";
// The revision this pod realizes ({gatewayId}-r{n}, PR3 env). Bare GATEWAY_ID
// stays the tenant identity; the revision id keys the runtime heartbeat Cowboy's
// converge-empty readiness matches (glmGateways/{revisionId}.heartbeat). Empty on
// legacy pods that predate the revision dimension.
export const GATEWAY_REVISION_ID = process.env.GATEWAY_REVISION_ID ?? "";
export const GATEWAY_PROFILE = process.env.GATEWAY_PROFILE ?? "default";
export const GATEWAY_CLASS = process.env.GATEWAY_CLASS ?? "";
export function isOperatorGateway() {
    return GATEWAY_PROFILE === "operator";
}
// A shared (multi-tenant) pod routes EACH customer-agent's anthropic through the
// broker with its OWN per-customer token (agent-model-token-<agentId>), unlike
// builder/operator which carry one per-gateway env broker token.
export function isSharedGateway() {
    return GATEWAY_CLASS === "shared";
}
export function usesLlmBrokerToken() {
    return GATEWAY_CLASS === "builder" || GATEWAY_CLASS === "operator";
}
export const CUSTOMERS_DIR = path.join(OPENCLAW_DIR, "customers");
export const CUSTOMER_KEYS_DIR = path.join(OPENCLAW_DIR, "customer-keys");
export const TEMPLATES_DIR = process.env.OCTOGEE_TEMPLATES_DIR || path.resolve(__dirname, "..", "..", "templates");
export const GIT_API_URL = process.env.GIT_API_URL || "http://gitea-http.octogee.svc.cluster.local:3000/api/v1";
export const GIT_ORG = process.env.GIT_ORG || "octogee";
export const GIT_SSH_HOST = "gitea";
export const GIT_SYNC_INTERVAL_MS = 5 * 60 * 1000;
export const GITHUB_TOKEN = process.env.GITHUB_TOKEN || "";
export const GITHUB_ORG = process.env.GIT_ORG || process.env.GITHUB_ORG || "octogee";
export const BLOB_SYNC_MAX_CONCURRENT = 10;
export const BLOB_SYNC_MAX_SIZE = 100 * 1024 * 1024;
export function log(msg) {
    const ts = new Date().toISOString().replace("Z", "+00:00");
    console.log(`${ts} [provisioner] ${msg}`);
}
export function logLevel() {
    return (process.env.LOG_LEVEL ?? "info").toLowerCase();
}
export function dlog(msg) {
    if (logLevel() === "debug")
        log(msg);
}
export function bootBanner(component) {
    return (`boot ${component} sha=${process.env.BUILD_SHA ?? "unknown"}` +
        ` oc=${process.env.OPENCLAW_VERSION ?? "n/a"}` +
        ` fork=${process.env.OPENCLAW_FORK_SHA ?? "n/a"}` +
        ` node=${process.version} logLevel=${logLevel()}` +
        ` ts=${new Date().toISOString()}`);
}
export function readOpenClawConfig() {
    const config = JSON.parse(fs.readFileSync(OPENCLAW_CONFIG, "utf-8"));
    if (!isRecord(config))
        throw new Error("openclaw.json must contain a JSON object");
    return config;
}
export function writeOpenClawConfig(config, configPath = OPENCLAW_CONFIG) {
    const tmp = configPath + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(config, null, 2), "utf-8");
    fs.renameSync(tmp, configPath);
    log("openclaw.json updated — gateway will hot-reload");
}
export function agentExists(config, agentId) {
    const agents = isRecord(config) && isRecord(config.agents) ? config.agents.list : undefined;
    return Array.isArray(agents) && agents.some((agent) => isAgentWithId(agent, agentId));
}
function isAgentWithId(agent, agentId) {
    return isRecord(agent) && agent.id === agentId;
}
function isRecord(value) {
    return typeof value === "object" && value !== null;
}
