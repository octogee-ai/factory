import {
  log,
  readOpenClawConfig,
  writeOpenClawConfig,
  type OpenClawAgentConfig,
  type OpenClawConfig,
} from "./config.js";
import { db } from "./firebase.js";

export const agentToUid = new Map<string, string>();

export async function loadAgentToUidMapping(): Promise<void> {
  const snap = await db
    .collection("users")
    .where("provisioning.openclaw.status", "==", "complete")
    .get();

  for (const doc of snap.docs) {
    const oc = doc.data().provisioning?.openclaw;
    if (oc?.agentId)                    agentToUid.set(oc.agentId, doc.id);
    if (Array.isArray(oc?.agentIds))    oc.agentIds.forEach((id: string) => agentToUid.set(id, doc.id));
  }
  log(`agent-map: loaded ${agentToUid.size} entries`);
}

export function registerAgentIds(uid: string, agentIds: string[]): void {
  agentIds.forEach(id => agentToUid.set(id, uid));
}

type AgentConfig = NonNullable<OpenClawConfig["agents"]>;
type AgentDefaults = NonNullable<AgentConfig["defaults"]>;
type SubagentDefaults = NonNullable<AgentDefaults["subagents"]>;
type ToolsConfig = NonNullable<OpenClawConfig["tools"]>;
type GatewayConfig = NonNullable<OpenClawConfig["gateway"]>;
type GatewayAuthConfig = NonNullable<GatewayConfig["auth"]>;

const MIN_AGENT_CONCURRENCY = 8;
const MIN_SUBAGENT_RUN_TIMEOUT_SECONDS = 900;
const DEFAULT_HEARTBEAT = { every: "60m", target: "last", lightContext: true };

function ensureAgents(config: OpenClawConfig): AgentConfig {
  config.agents ??= {};
  return config.agents;
}

function ensureAgentDefaults(agents: AgentConfig): AgentDefaults {
  agents.defaults ??= {};
  return agents.defaults;
}

function ensureSubagentDefaults(defaults: AgentDefaults): SubagentDefaults {
  defaults.subagents ??= {};
  return defaults.subagents;
}

function ensureTools(config: OpenClawConfig): ToolsConfig {
  config.tools ??= {};
  return config.tools;
}

function ensureGatewayAuth(config: OpenClawConfig): GatewayAuthConfig {
  config.gateway ??= {};
  config.gateway.auth ??= {};
  return config.gateway.auth;
}

function raiseNumber(
  target: object,
  key: string,
  minimum: number,
  message: string,
): boolean {
  const record = target as Record<string, unknown>;
  const value = record[key];
  if (typeof value === "number" && value >= minimum) return false;

  record[key] = minimum;
  log(message);
  return true;
}

function setStringDefault(target: object, key: string, value: string, message: string): boolean {
  const record = target as Record<string, unknown>;
  if (record[key] === value) return false;

  record[key] = value;
  log(message);
  return true;
}

function isCoachAgent(agent: OpenClawAgentConfig): boolean {
  return /^octogee-.+-coach$/.test(agent.id);
}

function ensureCoachWorkspaceFs(agent: OpenClawAgentConfig): boolean {
  agent.tools ??= {};
  if (agent.tools.fs?.workspaceOnly) return false;

  agent.tools.fs = { workspaceOnly: true };
  return true;
}

function ensureCoachHeartbeat(agent: OpenClawAgentConfig): boolean {
  if (agent.heartbeat != null) return false;

  agent.heartbeat = { ...DEFAULT_HEARTBEAT };
  log(`${agent.id} → heartbeat default (every=60m, target=last, lightContext=true)`);
  return true;
}

function applyCoachAgentDefaults(agent: OpenClawAgentConfig): boolean {
  if (!isCoachAgent(agent)) return false;

  const changed = [
    ensureCoachWorkspaceFs(agent),
    ensureCoachHeartbeat(agent),
  ].some(Boolean);

  if (changed) {
    log(`Gateway defaults: ${agent.id} → fs.workspaceOnly=true, heartbeat defaulted`);
  }
  return changed;
}

function applyAgentDefaults(defaults: AgentDefaults): boolean {
  const subagents = ensureSubagentDefaults(defaults);
  return [
    raiseNumber(
      defaults,
      "maxConcurrent",
      MIN_AGENT_CONCURRENCY,
      "Set agents.defaults.maxConcurrent = 8",
    ),
    raiseNumber(
      subagents,
      "maxConcurrent",
      MIN_AGENT_CONCURRENCY,
      "Set agents.defaults.subagents.maxConcurrent = 8",
    ),
    setStringDefault(
      defaults,
      "verboseDefault",
      "on",
      'Set agents.defaults.verboseDefault = "on" (Activity Stream Phase 1)',
    ),
    raiseNumber(
      subagents,
      "runTimeoutSeconds",
      MIN_SUBAGENT_RUN_TIMEOUT_SECONDS,
      "Set agents.defaults.subagents.runTimeoutSeconds = 900",
    ),
  ].some(Boolean);
}

function applyAgentListDefaults(agents: OpenClawAgentConfig[] | undefined): boolean {
  return (agents ?? []).map((agent) => applyCoachAgentDefaults(agent)).some(Boolean);
}

function applyElevatedToolDefaults(tools: ToolsConfig): boolean {
  if (tools.elevated?.enabled === false) return false;

  tools.elevated = { enabled: false };
  log("Set tools.elevated.enabled = false");
  return true;
}

function applyGatewayAuthDefaults(auth: GatewayAuthConfig): boolean {
  if (auth.rateLimit) return false;

  auth.rateLimit = { maxAttempts: 10, windowMs: 60000, lockoutMs: 300000 };
  log("Set gateway.auth.rateLimit (10 attempts/60s, 5min lockout)");
  return true;
}

export function applyGatewayDefaults(config: OpenClawConfig): boolean {
  config.channels ??= {};
  const agents = ensureAgents(config);
  const defaults = ensureAgentDefaults(agents);
  const tools = ensureTools(config);
  const auth = ensureGatewayAuth(config);

  return [
    applyAgentDefaults(defaults),
    applyAgentListDefaults(agents.list),
    applyElevatedToolDefaults(tools),
    applyGatewayAuthDefaults(auth),
  ].some(Boolean);
}

export function ensureGatewayDefaults(): void {
  const config = readOpenClawConfig();
  if (applyGatewayDefaults(config)) writeOpenClawConfig(config);
}
