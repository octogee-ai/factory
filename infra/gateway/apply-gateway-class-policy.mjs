#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const EXEC_TOOLS = new Set(["exec", "process"]);
const SHARED_DENIED_TOOLS = ["exec", "process", "subagents", "sessions_spawn"];
export const OCTOGEE_WORKFLOW_TOOLS = [
  "preview_start",
  "preview_stop",
  "preview_list",
  "octogee_publish",
  "octogee_project_create",
  "octogee_project_commit",
  "octogee_project_list",
  "workspace_commit",
  "brave_search",
  "tavily_search",
  "tavily_extract",
  "octogee_chat_search",
  "octogee_chat_history",
  "octogee_chat_set_identity",
];
const CONNECTOR_TOOLS_PLUGIN = "octogee-connector-tools";
const PROJECT_TOOLS_PLUGIN = "octogee-project-tools";
const CODEX_MODEL = "openai/gpt-5.5";
const CODEX_PROFILE = "openai-codex:default";
const RUNTIME_CODEX_SANDBOX = "danger-full-access";
const RUNTIME_CODEX_APPROVAL_POLICY = "never";

function removeDeniedTools(value, deniedTools) {
  if (!Array.isArray(value)) return value;
  return value.filter((tool) => !deniedTools.has(tool));
}

function addUnique(list, tool) {
  if (!Array.isArray(list)) return [tool];
  return list.includes(tool) ? list : [...list, tool];
}

function addTools(list, tools) {
  return tools.reduce((next, tool) => addUnique(next, tool), list);
}

function removeSharedSubagentDefaults(config) {
  if (
    config.agents?.defaults &&
    Object.prototype.hasOwnProperty.call(config.agents.defaults, "subagents")
  ) {
    delete config.agents.defaults.subagents;
  }
}

function allowOctogeeWorkflowTools(config) {
  config.tools ??= {};
  config.tools.alsoAllow = addTools(config.tools.alsoAllow, OCTOGEE_WORKFLOW_TOOLS);
}

function disableConnectorTools(config) {
  config.plugins ??= {};
  if (Array.isArray(config.plugins.allow)) {
    config.plugins.allow = config.plugins.allow.filter((id) => id !== CONNECTOR_TOOLS_PLUGIN);
  }
  config.plugins.entries ??= {};
  config.plugins.entries[CONNECTOR_TOOLS_PLUGIN] ??= {};
  config.plugins.entries[CONNECTOR_TOOLS_PLUGIN].enabled = false;
}

function ensureCodexAuthProfile(config) {
  config.auth ??= {};
  config.auth.profiles ??= {};
  config.auth.profiles[CODEX_PROFILE] = {
    provider: "openai-codex",
    mode: "oauth",
  };
}

function ensureCodexRuntimeModel(config) {
  config.agents ??= {};
  config.agents.defaults ??= {};
  config.agents.defaults.models ??= {};
  config.agents.defaults.models[CODEX_MODEL] = { agentRuntime: { id: "codex" } };
}

function allowPlugin(config, id) {
  config.plugins ??= {};
  if (Array.isArray(config.plugins.allow)) {
    if (!config.plugins.allow.includes(id)) config.plugins.allow.push(id);
  } else {
    config.plugins.allow = [id];
  }
  config.plugins.entries ??= {};
}

function enableCodexAppServer(config) {
  allowPlugin(config, "codex");
  config.plugins.entries.codex ??= {};
  config.plugins.entries.codex.enabled = true;
  config.plugins.entries.codex.config ??= {};
  config.plugins.entries.codex.config.appServer ??= {};
  config.plugins.entries.codex.config.appServer.sandbox = RUNTIME_CODEX_SANDBOX;
  config.plugins.entries.codex.config.appServer.approvalPolicy = RUNTIME_CODEX_APPROVAL_POLICY;
}

function enableConnectorTools(config) {
  allowPlugin(config, CONNECTOR_TOOLS_PLUGIN);
  config.plugins.entries[CONNECTOR_TOOLS_PLUGIN] ??= {};
  config.plugins.entries[CONNECTOR_TOOLS_PLUGIN].enabled = true;
  config.plugins.entries[CONNECTOR_TOOLS_PLUGIN].config ??= {};
}

// Preserved/restored configs predate the plugin; converge it at boot so both
// shared and builder classes gain project CRUD without waiting for a fresh
// template render. The client resolves brokerUrl/tokenPath from env when the
// entry config is empty.
function enableProjectTools(config) {
  allowPlugin(config, PROJECT_TOOLS_PLUGIN);
  config.plugins.entries[PROJECT_TOOLS_PLUGIN] ??= {};
  config.plugins.entries[PROJECT_TOOLS_PLUGIN].enabled = true;
  config.plugins.entries[PROJECT_TOOLS_PLUGIN].config ??= {};
}

function enableRuntimePlugins(config) {
  ensureCodexAuthProfile(config);
  ensureCodexRuntimeModel(config);
  enableCodexAppServer(config);
  enableConnectorTools(config);
}

// A shared pod may run a BYOS subscription's codex harness, but it MUST stay
// sandboxed: workspace-write + approvalPolicy:never, never the operator
// danger-full-access YOLO. Codex stays allowlisted so the per-customer
// byot-sync patch can enable it; this CLAMPS the app-server sandbox at boot so
// a shared-pod codex can never escalate to full host access. Enablement is left
// to the template default / byot-sync — this only fixes the trust boundary.
const SHARED_CODEX_SANDBOX = "workspace-write";
const SHARED_CODEX_APPROVAL_POLICY = "never";

function sandboxCodex(config) {
  config.plugins ??= {};
  config.plugins.allow ??= [];
  if (Array.isArray(config.plugins.allow) && !config.plugins.allow.includes("codex")) {
    config.plugins.allow.push("codex");
  }
  config.plugins.entries ??= {};
  config.plugins.entries.codex ??= { enabled: false };
  if (config.plugins.entries.codex.enabled === false) {
    delete config.plugins.entries.codex.config;
    return;
  }
  config.plugins.entries.codex.config ??= {};
  config.plugins.entries.codex.config.appServer ??= {};
  config.plugins.entries.codex.config.appServer.sandbox = SHARED_CODEX_SANDBOX;
  config.plugins.entries.codex.config.appServer.approvalPolicy = SHARED_CODEX_APPROVAL_POLICY;
}

function applySharedPolicy(config) {
  config.tools ??= {};
  config.tools.deny = addTools(config.tools.deny, SHARED_DENIED_TOOLS);
  config.tools.exec = { mode: "deny" };
  config.tools.subagents ??= {};
  config.tools.subagents.tools ??= {};
  config.tools.subagents.tools.deny = addTools(config.tools.subagents.tools.deny, [
    "exec",
    "process",
  ]);
  removeSharedSubagentDefaults(config);
  allowOctogeeWorkflowTools(config);
  enableProjectTools(config);
  sandboxCodex(config);
  disableConnectorTools(config);
}

function applyBuilderPolicy(config) {
  config.tools ??= {};
  config.tools.deny = removeDeniedTools(config.tools.deny, new Set(SHARED_DENIED_TOOLS));
  delete config.tools.exec;
  config.tools.subagents ??= {};
  config.tools.subagents.tools ??= {};
  config.tools.subagents.tools.deny = removeDeniedTools(config.tools.subagents.tools.deny, EXEC_TOOLS);
  allowOctogeeWorkflowTools(config);
  enableProjectTools(config);
  enableRuntimePlugins(config);
}

function resolveGatewayClass(env) {
  if (env.GATEWAY_CLASS === "builder" || env.GATEWAY_CLASS === "operator") {
    return env.GATEWAY_CLASS;
  }
  if (env.GATEWAY_PROFILE === "operator") return "operator";
  return "shared";
}

function resolveOpenclawJsonPath() {
  if (process.env.OPENCLAW_CONFIG_PATH?.trim()) return process.env.OPENCLAW_CONFIG_PATH.trim();
  const dir =
    process.env.OPENCLAW_DIR ?? path.join(process.env.HOME ?? "/home/node", ".openclaw");
  return path.join(dir, "openclaw.json");
}

function atomicWriteJson(configPath, config) {
  const tmpPath = `${configPath}.tmp`;
  const fd = fs.openSync(
    tmpPath,
    fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC,
    0o600,
  );
  try {
    fs.writeFileSync(fd, JSON.stringify(config, null, 2));
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmpPath, configPath);
}

export function applyGatewayClassPolicy({ openclawJsonPath, env = process.env } = {}) {
  const configPath = openclawJsonPath ?? resolveOpenclawJsonPath();
  if (!fs.existsSync(configPath)) return { applied: false, reason: "no-openclaw-json" };
  const raw = fs.readFileSync(configPath, "utf8");
  let config;
  try {
    config = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `apply-gateway-class-policy: ${configPath} is not valid JSON — refusing to overwrite (${err.message})`,
    );
  }
  const gatewayClass = resolveGatewayClass(env);
  const before = JSON.stringify(config);
  if (gatewayClass === "builder") {
    applyBuilderPolicy(config);
  } else if (gatewayClass === "shared") {
    applySharedPolicy(config);
  } else {
    return { applied: false, reason: "operator-handled-separately", gatewayClass };
  }
  if (JSON.stringify(config) === before) {
    return { applied: false, reason: "already-set", gatewayClass };
  }
  atomicWriteJson(configPath, config);
  return { applied: true, path: configPath, gatewayClass };
}

const invokedDirectly =
  Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  const result = applyGatewayClassPolicy();
  if (result.applied) {
    console.log(`[apply-gateway-class-policy] applied class=${result.gatewayClass} in ${result.path}`);
  } else {
    console.log(`[apply-gateway-class-policy] skipped: ${result.reason}`);
  }
}
