import {
  log,
  readOpenClawConfig,
  writeOpenClawConfig,
  type OpenClawAgentConfig,
  type OpenClawConfig,
} from "./config.js";

type AgentConfig = NonNullable<OpenClawConfig["agents"]>;
type AgentDefaults = NonNullable<AgentConfig["defaults"]>;
type SubagentDefaults = NonNullable<AgentDefaults["subagents"]>;
type ToolsConfig = NonNullable<OpenClawConfig["tools"]>;
type GatewayConfig = NonNullable<OpenClawConfig["gateway"]>;
type GatewayAuthConfig = NonNullable<GatewayConfig["auth"]>;

const MIN_AGENT_CONCURRENCY = 8;
const MIN_SUBAGENT_RUN_TIMEOUT_SECONDS = 900;

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

function isManagedAgent(agent: OpenClawAgentConfig): boolean {
  return /^octogee-.+-coach$/.test(agent.id);
}

function ensureDefaultAgentWorkspaceFs(agent: OpenClawAgentConfig): boolean {
  agent.tools ??= {};
  if (agent.tools.fs?.workspaceOnly) return false;

  agent.tools.fs = { workspaceOnly: true };
  return true;
}

function applyDefaultAgentDefaults(agent: OpenClawAgentConfig): boolean {
  if (!isManagedAgent(agent)) return false;

  const changed = ensureDefaultAgentWorkspaceFs(agent);

  if (changed) {
    log(`Gateway defaults: ${agent.id} → fs.workspaceOnly=true`);
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
      "off",
      'Set agents.defaults.verboseDefault = "off"',
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
  return (agents ?? []).map((agent) => applyDefaultAgentDefaults(agent)).some(Boolean);
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
