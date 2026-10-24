#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import {
  canonicalCustomerModelDefinition,
  platformModelRefs,
} from "../../shared/dist/types/agent-models.js";
import { modelCatalogForProvider } from "../../shared/dist/types/model-catalog.js";
import { parseAgentId } from "../../shared/dist/types/identity.js";
import { projectPlatformAgentMattermostAccounts } from "../../shared/dist/types/openclaw-mattermost-accounts.js";
import {
  withOpenClawOperatorRoles,
  OPENCLAW_TRUSTED_PROXIES,
  OPENCLAW_TRUSTED_PROXY_AUTH,
  isPerUserControlIdentity,
  openClawIdentityScopes,
} from "../../shared/dist/types/openclaw-proxy-identity.js";
import { readBuilderClaim } from "../../shared/dist/server/builder-claim.js";

export const CUSTOMER_CODE_DENIED_TOOLS = [
  "exec",
  "process",
  "subagents",
  "sessions_spawn",
  "terminal",
  "preview_start",
  "preview_stop",
  "preview_list",
  "octogee_publish",
  "bundle-mcp",
  "skill_workshop",
  "conversations_list",
  "conversations_send",
  "conversations_turn",
  "browser",
  "computer",
];
export const CUSTOMER_STRUCTURED_AVAILABLE_TOOLS = [
  "automations",
  "workspace_commit",
  "octogee_project_commit",
  "octogee_project_capability",
  "octogee_project_build",
  "octogee_project_test",
  "octogee_project_preview",
  "octogee_project_run_status",
  "octogee_project_publish",
  "octogee_project_set_recipe",
  "octogee_board_list",
  "octogee_board_card_read",
  "octogee_board_card_create",
  "octogee_board_card_update",
  "octogee_board_card_move",
  "octogee_board_card_comment",
];
export const OCTOGEE_WORKFLOW_TOOLS = [
  "automations",
  "message",
  "octogee_project_create",
  "octogee_project_delegate",
  "octogee_project_commit",
  "octogee_project_list",
  "octogee_project_set_recipe",
  "octogee_project_capability",
  "octogee_project_build",
  "octogee_project_test",
  "octogee_project_preview",
  "octogee_project_run_status",
  "octogee_project_publish",
  "octogee_board_list",
  "octogee_board_card_read",
  "octogee_board_card_create",
  "octogee_board_card_update",
  "octogee_board_card_move",
  "octogee_board_card_comment",
  "workspace_commit",
  "brave_search",
  "tavily_search",
  "tavily_extract",
  "octogee_chat_search",
  "octogee_chat_history",
  "octogee_chat_set_identity",
  "octogee_connection_request",
  "octogee_status",
  "octogee_ask_ops",
  "octogee_google_calendar_events",
  "octogee_google_calendar_create",
  "octogee_google_calendar_create_approved",
  "octogee_google_calendar_update",
  "octogee_google_calendar_update_approved",
  "octogee_google_calendar_delete",
  "octogee_google_calendar_delete_approved",
  "octogee_google_gmail_search",
  "octogee_google_gmail_get",
  "octogee_google_gmail_triage",
  "octogee_google_gmail_triage_approved",
  "octogee_google_gmail_draft_create",
  "octogee_google_gmail_draft_create_approved",
  "octogee_google_gmail_draft_send",
  "octogee_google_gmail_draft_send_approved",
  "octogee_google_drive_read",
  "octogee_google_docs_read",
  "octogee_google_docs_write",
  "octogee_google_contacts_read",
  "octogee_google_tasks_lists",
  "octogee_google_tasks_list",
  "octogee_google_tasks_add",
  "octogee_google_tasks_add_approved",
  "octogee_google_tasks_update",
  "octogee_google_tasks_update_approved",
  "octogee_google_sheets_read",
  "octogee_google_sheets_write",
  "octogee_obsidian_read",
  "octogee_obsidian_write",
];
const PRODUCTIVITY_TOOL_NAMES = OCTOGEE_WORKFLOW_TOOLS.filter((tool) =>
  tool.startsWith("octogee_google_") || tool.startsWith("octogee_obsidian_"));
const PROJECT_AGENT_ALLOWED_TOOLS = [
  "octogee_chat_set_identity",
  "octogee_connection_request",
  "octogee_ask_ops",
  "message",
  "read",
  "ls",
  "write",
  "edit",
  "apply_patch",
  "web_search",
  "web_fetch",
  "brave_search",
  "tavily_search",
  "tavily_extract",
  "octogee_project_build",
  "octogee_project_capability",
  "octogee_project_test",
  "octogee_project_preview",
  "octogee_project_run_status",
  "octogee_project_commit",
  "octogee_project_set_recipe",
  "octogee_board_list",
  "octogee_board_card_read",
  "octogee_board_card_create",
  "octogee_board_card_update",
  "octogee_board_card_move",
  "octogee_board_card_comment",
];
const PROJECT_AGENT_DENIED_TOOLS = [
  ...PRODUCTIVITY_TOOL_NAMES,
  "exec",
  "process",
  "subagents",
  "sessions_spawn",
  "terminal",
  "preview_start",
  "preview_stop",
  "preview_list",
  "octogee_publish",
  "workspace_commit",
  "octogee_project_create",
  "octogee_project_delegate",
  "octogee_project_publish",
  "octogee_status",
  "octogee_chat_search",
  "octogee_chat_history",
  "bundle-mcp",
  "automations",
  "skill_workshop",
  "conversations_list",
  "conversations_send",
  "conversations_turn",
  "browser",
  "computer",
];
export const CUSTOMER_APPROVED_PLUGINS = [
  "mattermost",
  "anthropic",
  "memory-core",
  "octogee-chat-tools",
  "octogee-connector-tools",
  "octogee-access-tools",
  "octogee-project-tools",
  "octogee-board-tools",
  "octogee-status-tools",
  "octogee-ops-tools",
  "octogee-web-tools",
  "octogee-workspace-tools",
  "octogee-activity-tools",
  "parallel",
  "openai",
];
const FLEET_BROKER_URL_TEMPLATE = "${FLEET_BROKER_URL}";
const API_SA_TOKEN_PATH_TEMPLATE = "${OCTOGEE_API_SA_TOKEN_PATH}";
const CUSTOMER_PLUGIN_ENTRIES = {
  mattermost: { enabled: true },
  anthropic: { enabled: true },
  "octogee-chat-tools": {
    enabled: true,
    hooks: {
      allowPromptInjection: true,
      allowConversationAccess: true,
      timeouts: { before_dispatch: 3000, before_prompt_build: 3000, before_agent_run: 3000 },
    },
    config: {
      siteUrl: "${MM_SITE_URL}",
      brokerUrl: FLEET_BROKER_URL_TEMPLATE,
      tokenPath: API_SA_TOKEN_PATH_TEMPLATE,
      customersRoot: "${CUSTOMERS_DIR}",
    },
  },
  "octogee-connector-tools": {
    enabled: true,
    config: {
      brokerUrl: FLEET_BROKER_URL_TEMPLATE,
      tokenPath: API_SA_TOKEN_PATH_TEMPLATE,
    },
  },
  "octogee-access-tools": {
    enabled: true,
    config: {
      brokerUrl: FLEET_BROKER_URL_TEMPLATE,
      tokenPath: API_SA_TOKEN_PATH_TEMPLATE,
    },
  },
  "octogee-project-tools": {
    enabled: true,
    config: {
      brokerUrl: FLEET_BROKER_URL_TEMPLATE,
      tokenPath: API_SA_TOKEN_PATH_TEMPLATE,
    },
  },
  "octogee-board-tools": {
    enabled: true,
    config: {
      brokerUrl: FLEET_BROKER_URL_TEMPLATE,
      tokenPath: API_SA_TOKEN_PATH_TEMPLATE,
    },
  },
  "octogee-status-tools": {
    enabled: true,
    config: {
      brokerUrl: FLEET_BROKER_URL_TEMPLATE,
      tokenPath: API_SA_TOKEN_PATH_TEMPLATE,
      gatewayClass: "${GATEWAY_CLASS}",
    },
  },
  "octogee-ops-tools": {
    enabled: true,
    config: {
      brokerUrl: FLEET_BROKER_URL_TEMPLATE,
      tokenPath: API_SA_TOKEN_PATH_TEMPLATE,
    },
  },
  "octogee-web-tools": {
    enabled: true,
    config: {
      brokerUrl: FLEET_BROKER_URL_TEMPLATE,
      gatewayId: "${GATEWAY_ID}",
      tokenPath: API_SA_TOKEN_PATH_TEMPLATE,
    },
  },
  "octogee-workspace-tools": { enabled: true, config: {} },
  "octogee-activity-tools": {
    enabled: true,
    config: { heartbeatMs: 5000 },
  },
  parallel: { enabled: true },
};
const CONNECTOR_TOOLS_PLUGIN = "octogee-connector-tools";
const PROJECT_TOOLS_PLUGIN = "octogee-project-tools";
const BOARD_TOOLS_PLUGIN = "octogee-board-tools";
const OPS_TOOLS_PLUGIN = "octogee-ops-tools";
const ACCESS_TOOLS_PLUGIN = "octogee-access-tools";
const CODEX_PROFILE = "openai-codex:default";
const CLAUDE_CLI_PROFILE = "anthropic:claude-cli";
const CANONICAL_AGENT_AUTH_PROFILE_IDS = new Set([
  "anthropic:default",
  "platform-openrouter:default",
  "platform-openai:default",
]);
const SESSION_RUNTIME_STATE_FIELDS = [
  "providerOverride",
  "modelOverride",
  "modelOverrideSource",
  "modelOverrideRouteResolution",
  "modelOverrideFallbackOriginProvider",
  "modelOverrideFallbackOriginModel",
  "modelFallback",
  "authProfileOverride",
  "authProfileOverrideSource",
  "authProfileOverrideCompactionCount",
  "liveModelSwitchPending",
  "modelProvider",
  "model",
  "modelSelectionLocked",
  "agentHarnessId",
  "agentRuntimeOverride",
  "fallbackNotice",
  "contextTokens",
  "systemPromptReport",
  "cliSessionIds",
  "cliSessionBindings",
  "acpSessionBinding",
  "acp",
  "claudeCliSessionId",
  "pluginOwnerId",
  "pluginExtensions",
  "initializationPending",
  "spawnedCwd",
  "execHost",
  "execSecurity",
  "execAsk",
  "execNode",
  "execCwd",
  "elevatedLevel",
  "toolOverrides",
];
const SAFE_CUSTOMER_MODEL = "platform-openrouter/deepseek/deepseek-v4-pro";
const SAFE_AGENT_ID = /^[a-z0-9-]{1,64}$/;
const CUSTOMER_MODEL_REFS = new Set(platformModelRefs());
const CUSTOMER_MODEL_PROVIDER_IDS = new Set([
  "anthropic",
  "platform-openrouter",
  "platform-openai",
]);

function customerDiskModelProviders(env) {
  const providers = {};
  for (const [providerId, baseUrlName] of [
    ["platform-openrouter", "OPENROUTER_BASE_URL"],
    ["platform-openai", "PLATFORM_OPENAI_BASE_URL"],
  ]) {
    const baseUrl = env[baseUrlName]?.trim();
    if (!baseUrl) continue;
    providers[providerId] = {
      api: "openai-completions",
      baseUrl,
      apiKey: `${providerId}:default`,
      models: modelCatalogForProvider(providerId === "platform-openrouter" ? "openrouter" : "openai").map((entry) => ({
        id: entry.id,
        name: entry.id,
        ...(entry.contextTokens !== undefined
          ? { contextTokens: entry.contextTokens, contextWindow: entry.contextTokens } : {}),
        ...(entry.input ? { input: [...entry.input] } : {}),
        ...(entry.maxOutputTokens !== undefined ? { maxTokens: entry.maxOutputTokens } : {}),
        ...(entry.reasoning !== undefined ? { reasoning: entry.reasoning } : {}),
      })),
    };
  }
  return providers;
}

const CUSTOMER_AGENT_ID = /^octogee-[a-z0-9]+(?:-[a-z0-9]+)*-coach$/;

function addUnique(list, tool) {
  if (!Array.isArray(list)) return [tool];
  return list.includes(tool) ? list : [...list, tool];
}

function addTools(list, tools) {
  return tools.reduce((next, tool) => addUnique(next, tool), list);
}

function removeTools(list, tools) {
  if (!Array.isArray(list)) return [];
  const removed = new Set(tools);
  return list.filter((tool) => !removed.has(tool));
}

function removeSharedSubagentDefaults(config) {
  if (
    config.agents?.defaults &&
    Object.prototype.hasOwnProperty.call(config.agents.defaults, "subagents")
  ) {
    delete config.agents.defaults.subagents;
  }
}

function isPolicyCodexAuthProfile(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  return (
    Object.keys(value).length === 2 &&
    value.provider === "openai-codex" &&
    value.mode === "oauth"
  );
}

export function removePolicyCodexAuthPlaceholder(config) {
  const profile = config.auth?.profiles?.[CODEX_PROFILE];
  if (isPolicyCodexAuthProfile(profile)) {
    delete config.auth.profiles[CODEX_PROFILE];
  }
}

// Customers never approve connector writes per-call; the capability convergence
// has already allowed and enabled the plugin by the time this runs.
function clearConnectorWriteApproval(config) {
  delete config.plugins.entries[CONNECTOR_TOOLS_PLUGIN].config.requireWriteApproval;
}

// Plugins the platform itself ships. A gateway that was materialized before one
// of these existed must gain it at boot, or its agents never see the tools the
// plugin registers even when the image carries them.
const PLATFORM_CAPABILITY_PLUGINS = [
  CONNECTOR_TOOLS_PLUGIN,
  PROJECT_TOOLS_PLUGIN,
  BOARD_TOOLS_PLUGIN,
  OPS_TOOLS_PLUGIN,
  ACCESS_TOOLS_PLUGIN,
];

// A builder gateway's config is persisted and restored across every VM
// replacement, so an absent `plugins.allow` means "no allowlist" and must stay
// absent — materializing one here would silently narrow the gateway to exactly
// the platform's own plugins. An explicitly disabled entry is a Builder
// decision and survives; only a missing entry is defaulted on.
function enablePlatformPlugin(config, id, builder) {
  config.plugins ??= {};
  config.plugins.entries ??= {};
  if (Array.isArray(config.plugins.allow)) {
    if (!config.plugins.allow.includes(id)) config.plugins.allow.push(id);
  } else if (!builder) {
    config.plugins.allow = [id];
  }
  config.plugins.entries[id] ??= {};
  config.plugins.entries[id].config ??= {};
  if (builder) config.plugins.entries[id].enabled ??= true;
  else config.plugins.entries[id].enabled = true;
}

// The platform's capability surface: the tools Octogee ships and the plugins
// that register them. Every gateway class converges onto it, because no gateway
// owner chose these and none can be expected to maintain them by hand. The
// restriction half of the class policy (deny lists, terminal, session
// visibility, config-mutation locks) stays customer-only, which is why a
// builder gateway converges additively: new platform capabilities arrive and
// the Builder's own profile, allow, deny and extra tools survive untouched.
function addBuilderToolCapabilities(config, capabilities) {
  config.tools ??= {};
  const alsoAllow = Array.isArray(config.tools.alsoAllow) ? config.tools.alsoAllow : [];
  if (Array.isArray(config.tools.allow) && config.tools.allow.length > 0) {
    config.tools.allow = [...new Set([...config.tools.allow, ...alsoAllow, ...capabilities])];
    delete config.tools.alsoAllow;
  } else {
    config.tools.alsoAllow = [...new Set([...alsoAllow, ...capabilities])];
  }
}

function convergePlatformCapabilities(config, builder) {
  config.tools ??= {};
  if (builder) {
    addBuilderToolCapabilities(config, OCTOGEE_WORKFLOW_TOOLS);
  } else {
    config.tools.profile = "coding";
    delete config.tools.allow;
    config.tools.alsoAllow = [...OCTOGEE_WORKFLOW_TOOLS];
  }
  for (const id of PLATFORM_CAPABILITY_PLUGINS) enablePlatformPlugin(config, id, builder);
}

function disableCodex(config) {
  config.plugins ??= {};
  config.plugins.allow = [...CUSTOMER_APPROVED_PLUGINS];
  config.plugins.entries ??= {};
  config.plugins.entries.codex = {
    enabled: false,
  };
}

function setTerminal(config, enabled) {
  config.gateway ??= {};
  config.gateway.terminal ??= {};
  config.gateway.terminal.enabled = enabled;
}

function restrictSessionVisibility(config) {
  config.tools ??= {};
  config.tools.sessions ??= {};
  config.tools.sessions.visibility = "self";
}

function disableCustomerConfigMutation(config) {
  config.commands ??= {};
  for (const command of ["bash", "config", "mcp", "plugins", "debug"]) {
    config.commands[command] = false;
  }
  delete config.commands.ownerAllowFrom;
  if (config.mcp && typeof config.mcp === "object" && !Array.isArray(config.mcp)) {
    delete config.mcp.servers;
  }
}

function customerAgentLane(agentId) {
  if (typeof agentId !== "string" || !CUSTOMER_AGENT_ID.test(agentId)) return "unknown";
  return agentId.includes("-proj-") ? "project" : "coach";
}

function customerAgentToolProjection(lane, currentDeny) {
  if (lane === "coach") {
    return {
      profile: "coding",
      alsoAllow: [...OCTOGEE_WORKFLOW_TOOLS],
      deny: addTools(
        removeTools(currentDeny, CUSTOMER_STRUCTURED_AVAILABLE_TOOLS),
        CUSTOMER_CODE_DENIED_TOOLS,
      ),
    };
  }
  if (lane === "project") {
    return {
      profile: "minimal",
      alsoAllow: [...PROJECT_AGENT_ALLOWED_TOOLS],
      deny: [...PROJECT_AGENT_DENIED_TOOLS],
    };
  }
  return {
    profile: "minimal",
    alsoAllow: [],
    deny: addTools(currentDeny, CUSTOMER_CODE_DENIED_TOOLS),
  };
}

function projectCustomerAgentTools(config, entry, agentId) {
  entry.tools ??= {};
  entry.tools.fs ??= {};
  entry.tools.fs.workspaceOnly = true;
  const projected = customerAgentToolProjection(customerAgentLane(agentId), entry.tools.deny);
  entry.tools.profile = projected.profile;
  entry.tools.alsoAllow = projected.alsoAllow;
  entry.tools.deny = projected.deny;
  entry.tools.toolsBySender = customerToolsBySender(config, agentId);
  delete entry.tools.allow;
}

function forceCustomerWorkspaceOnly(config) {
  config.tools ??= {};
  config.tools.fs ??= {};
  config.tools.fs.workspaceOnly = true;
  if (Array.isArray(config.agents?.list)) {
    for (const rawEntry of config.agents.list) {
      const entry = objectValue(rawEntry);
      if (entry) projectCustomerAgentTools(config, entry, entry.id);
    }
  }
  const entries = objectValue(config.agents?.entries);
  if (!entries) return;
  for (const [agentId, rawEntry] of Object.entries(entries)) {
    const entry = objectValue(rawEntry);
    if (entry) projectCustomerAgentTools(config, entry, agentId);
  }
}

function customerToolsBySender(_config, agentId) {
  return agentId.includes("-proj-")
    ? { "*": { deny: [...PRODUCTIVITY_TOOL_NAMES] } }
    : {};
}

function disableCustomerAutomationsAndSkillWrites(config) {
  config.cron ??= {};
  config.cron.triggers ??= {};
  config.cron.triggers.enabled = false;
  config.skills ??= {};
  config.skills.load ??= {};
  delete config.skills.load.allowSymlinkTargets;
  delete config.skills.load.extraDirs;
  config.skills.workshop ??= {};
  config.skills.workshop.autonomous = { mode: "off" };
  delete config.skills.workshop.approvalPolicy;
  delete config.skills.workshop.maxPending;
  delete config.skills.workshop.allowSymlinkTargetWrites;
}

function forceCustomerMattermostProjection(config) {
  config.channels ??= {};
  config.channels.mattermost ??= {};
  const mattermost = config.channels.mattermost;
  delete mattermost.baseUrl;
  mattermost.network = { dangerouslyAllowPrivateNetwork: true };
  mattermost.interactions = {
    callbackBaseUrl: "${MM_INTERACTIONS_CALLBACK_BASE_URL}",
    allowedSourceIps: ["${MM_INTERACTIONS_ALLOWED_SOURCE_IPS}"],
  };
  projectMattermostAccounts(config, true);
}

function projectMattermostAccounts(config, platformOwned) {
  config.channels ??= {};
  config.channels.mattermost ??= {};
  const mattermost = config.channels.mattermost;
  mattermost.accounts = objectValue(mattermost.accounts) ?? {};
  projectPlatformAgentMattermostAccounts(config, mattermost.accounts, platformOwned);
}

function objectValue(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : null;
}

const INSTALLED_PLUGIN_INDEX_STATE_KEY = "plugins.installedIndex";
const RETIRED_MATTERMOST_FILE_SPEC_PREFIX = "@openclaw/mattermost@file:";
const BUNDLED_CODEX_NPM_PACKAGE = "@openclaw/codex";

function removeRetiredMattermostInstallRecord(openclawDir) {
  return removeMatchingNpmInstallRecord(openclawDir, "mattermost", (spec) =>
    spec.startsWith(RETIRED_MATTERMOST_FILE_SPEC_PREFIX),
  );
}

function removeStaleCodexInstallRecord(openclawDir) {
  return removeMatchingNpmInstallRecord(openclawDir, "codex", (spec) =>
    spec === BUNDLED_CODEX_NPM_PACKAGE || spec.startsWith(`${BUNDLED_CODEX_NPM_PACKAGE}@`),
  );
}

function removeMatchingNpmInstallRecord(openclawDir, pluginId, matchesSpec) {
  const dbPath = path.join(openclawDir, "state", "openclaw.sqlite");
  if (!fs.existsSync(dbPath)) return false;
  const db = new DatabaseSync(dbPath);
  try {
    db.exec("PRAGMA busy_timeout = 30000;");
    const table = db.prepare(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'config_machine_state'",
    ).get();
    if (!table) return false;
    const row = db.prepare(
      "SELECT value_json FROM config_machine_state WHERE state_key = ?",
    ).get(INSTALLED_PLUGIN_INDEX_STATE_KEY);
    if (typeof row?.value_json !== "string") return false;
    const value = JSON.parse(row.value_json);
    const index = objectValue(value?.index);
    const installRecords = objectValue(index?.installRecords);
    const record = objectValue(installRecords?.[pluginId]);
    if (
      record?.source !== "npm" ||
      typeof record.spec !== "string" ||
      !matchesSpec(record.spec)
    ) {
      return false;
    }
    delete installRecords[pluginId];
    const revision = Math.max(
      Date.now(),
      Number.isSafeInteger(value.revision) ? value.revision + 1 : 1,
    );
    value.revision = revision;
    db.prepare(
      "UPDATE config_machine_state SET value_json = ?, updated_at_ms = ? WHERE state_key = ?",
    ).run(JSON.stringify(value), revision, INSTALLED_PLUGIN_INDEX_STATE_KEY);
    return true;
  } finally {
    db.close();
  }
}

function isDirectAgentRuntimeId(value) {
  return typeof value === "string" && value.trim().length > 0 && value !== "openclaw";
}

function projectCustomerPlugins(config) {
  config.plugins ??= {};
  config.plugins.enabled = true;
  config.plugins.allow = [...CUSTOMER_APPROVED_PLUGINS];
  config.plugins.entries = structuredClone(CUSTOMER_PLUGIN_ENTRIES);
  delete config.plugins.load;
  delete config.plugins.installs;
}

function isSecretRef(value) {
  const ref = objectValue(value);
  return ref && ["env", "file", "exec"].includes(ref.source);
}

function escapedJsonPointerSegment(value) {
  return value.replace(/~/gu, "~0").replace(/\//gu, "~1");
}

function agentIdAtSecretRefPath(config, segments) {
  if (segments[0] !== "agents") return null;
  if (segments[1] === "entries" && typeof segments[2] === "string") return segments[2];
  if (segments[1] !== "list" || !/^\d+$/u.test(segments[2] ?? "")) return null;
  const agent = Array.isArray(config.agents?.list)
    ? config.agents.list[Number(segments[2])]
    : null;
  return typeof agent?.id === "string" ? agent.id : null;
}

function projectAgentStoreSecretRef(config) {
  const postgres = objectValue(objectValue(config.database)?.postgres);
  if (postgres) {
    postgres.connection = { source: "env", provider: "default", id: "OPENCLAW_AGENT_STORE_DSN" };
  }
}

function expectedCustomerSecretRef(config, segments) {
  if (
    segments.length === 5 &&
    segments[0] === "channels" &&
    segments[1] === "mattermost" &&
    segments[2] === "accounts" &&
    segments[4] === "botToken"
  ) {
    return {
      source: "file",
      provider: "octogee-mattermost",
      id: `/${escapedJsonPointerSegment(segments[3])}`,
    };
  }
  const agentId = agentIdAtSecretRefPath(config, segments);
  const suffix = segments.slice(3).join(".");
  if (
    agentId &&
    (suffix === "memorySearch.remote.apiKey" || suffix === "memory.search.remote.apiKey")
  ) {
    return {
      source: "exec",
      provider: "gcp-secret-manager",
      id: `agent-embedding-token-openai-${agentId}`,
    };
  }
  return null;
}

function neutralizeSecretRefsInArray(value, config, segments) {
  for (let index = value.length - 1; index >= 0; index--) {
    const child = value[index];
    const childSegments = [...segments, String(index)];
    if (!isSecretRef(child)) {
      neutralizeUnapprovedCustomerSecretRefs(child, config, childSegments);
      continue;
    }
    const expected = expectedCustomerSecretRef(config, childSegments);
    if (expected) value[index] = expected;
    else value.splice(index, 1);
  }
}

function isCustomerSecretProviderPath(segments, key) {
  return segments.length === 1 && segments[0] === "secrets" && key === "providers";
}

function neutralizeSecretRefsInRecord(record, config, segments) {
  for (const [key, child] of Object.entries(record)) {
    if (isCustomerSecretProviderPath(segments, key)) continue;
    const childSegments = [...segments, key];
    if (!isSecretRef(child)) {
      neutralizeUnapprovedCustomerSecretRefs(child, config, childSegments);
      continue;
    }
    const expected = expectedCustomerSecretRef(config, childSegments);
    if (expected) record[key] = expected;
    else delete record[key];
  }
}

function neutralizeUnapprovedCustomerSecretRefs(value, config, segments = []) {
  if (Array.isArray(value)) {
    neutralizeSecretRefsInArray(value, config, segments);
    return;
  }
  const record = objectValue(value);
  if (record) neutralizeSecretRefsInRecord(record, config, segments);
}

function projectCustomerSecretProviders(config, openclawDir) {
  neutralizeUnapprovedCustomerSecretRefs(config, config);
  projectAgentStoreSecretRef(config);
  config.secrets ??= {};
  config.secrets.providers = {
    "gcp-secret-manager": {
      source: "exec",
      command: "/octogee/scripts/secret-resolver.mjs",
      passEnv: [
        "FLEET_BROKER_URL",
        "OCTOGEE_API_URL",
        "OCTOGEE_API_SA_TOKEN_PATH",
        "INTERNAL_SERVICE_KEY",
        "OPENCLAW_AGENTS_DIR",
        "HOME",
      ],
      jsonOnly: true,
      timeoutMs: 45000,
    },
    "octogee-mattermost": {
      source: "file",
      path: path.join(openclawDir, "secrets", "mattermost-accounts.json"),
      mode: "json",
    },
  };
}

function scrubCustomerHookNamespaces(config) {
  const hooks = objectValue(config.hooks);
  if (hooks) {
    delete hooks.transformsDir;
    if (Array.isArray(hooks.mappings)) {
      hooks.mappings = hooks.mappings.map((mapping) => {
        const entry = objectValue(mapping);
        if (!entry || !Object.prototype.hasOwnProperty.call(entry, "transform")) return mapping;
        const next = { ...entry };
        delete next.transform;
        return next;
      });
    }
  }
  const internalHooks = objectValue(config.hooks?.internal);
  if (!internalHooks) return;
  delete internalHooks.handlers;
  const load = objectValue(internalHooks.load);
  if (!load) return;
  delete load.extraDirs;
  if (Object.keys(load).length === 0) delete internalHooks.load;
}

function scrubCustomerProviderCommands(config) {
  const qmd = objectValue(config.memory?.qmd);
  if (qmd) delete qmd.command;
  const providers = objectValue(config.models?.providers);
  if (!providers) return;
  for (const provider of Object.values(providers)) {
    const localService = objectValue(objectValue(provider)?.localService);
    if (localService) delete localService.command;
  }
}

function commandlessModel(value, rejectCli) {
  const entry = objectValue(value);
  return Boolean(entry) && (!rejectCli || entry.type !== "cli") &&
    !Object.prototype.hasOwnProperty.call(entry, "command");
}

function scrubCustomerMediaCommands(config) {
  const media = objectValue(config.tools?.media);
  if (media && Array.isArray(media.models)) {
    media.models = media.models.filter((model) => commandlessModel(model, true));
  }
  const links = objectValue(config.tools?.links);
  if (links && Array.isArray(links.models)) {
    links.models = links.models.filter((model) => commandlessModel(model, false));
  }
}

function scrubCustomerInstallAndCronCommands(config) {
  const installPolicy = objectValue(config.security?.installPolicy);
  if (installPolicy) delete installPolicy.exec;
  const cron = objectValue(config.cron);
  if (!cron) return;
  for (const key of ["webhookToken", "webhookAuth", "failureAlert", "failureAlerts"]) {
    delete cron[key];
  }
}

function projectCustomerSpawnNamespaces(config) {
  scrubCustomerHookNamespaces(config);
  scrubCustomerProviderCommands(config);
  scrubCustomerMediaCommands(config);
  scrubCustomerInstallAndCronCommands(config);
}

function normalizedCatalogSelection(value) {
  if (typeof value === "string") {
    return CUSTOMER_MODEL_REFS.has(value) ? { primary: value, fallbacks: [] } : null;
  }
  const selection = objectValue(value);
  if (!selection || typeof selection.primary !== "string" ||
      !CUSTOMER_MODEL_REFS.has(selection.primary)) return null;
  const fallbacks = selection.fallbacks === undefined ? [] : selection.fallbacks;
  if (!Array.isArray(fallbacks) || fallbacks.some((ref) => !CUSTOMER_MODEL_REFS.has(ref))) {
    return null;
  }
  return {
    primary: selection.primary,
    fallbacks: [...new Set(fallbacks)].filter((ref) => ref !== selection.primary),
  };
}

function projectCatalogModelMap(models, ensureModelRef) {
  const modelMap = objectValue(models);
  if (!modelMap) return { changed: false, removedRefs: new Set() };
  let changed = false;
  const removedRefs = new Set();
  for (const modelRef of Object.keys(modelMap)) {
    if (!CUSTOMER_MODEL_REFS.has(modelRef)) {
      removedRefs.add(modelRef);
      delete modelMap[modelRef];
      changed = true;
      continue;
    }
    const expected = canonicalCustomerModelDefinition(modelRef);
    if (JSON.stringify(modelMap[modelRef]) !== JSON.stringify(expected)) {
      modelMap[modelRef] = expected;
      changed = true;
    }
  }
  if (ensureModelRef && !Object.prototype.hasOwnProperty.call(modelMap, ensureModelRef)) {
    modelMap[ensureModelRef] = canonicalCustomerModelDefinition(ensureModelRef);
    changed = true;
  }
  return { changed, removedRefs };
}

function scrubOwnedAgentRuntime(entry, forceSafeModel = false) {
  const agent = objectValue(entry);
  if (!agent) return false;
  const localModels = projectCatalogModelMap(agent.models);
  let affected = localModels.changed;
  const agentRuntime = objectValue(agent.agentRuntime);
  const hasSelection = Object.prototype.hasOwnProperty.call(agent, "model");
  const normalizedSelection = hasSelection ? normalizedCatalogSelection(agent.model) : null;
  const unsafePin = hasSelection && normalizedSelection === null;
  if (isDirectAgentRuntimeId(agentRuntime?.id)) {
    delete agent.agentRuntime;
    affected = true;
  }
  if (forceSafeModel || unsafePin) {
    agent.model = { primary: SAFE_CUSTOMER_MODEL, fallbacks: [] };
    affected = true;
  } else if (normalizedSelection && JSON.stringify(agent.model) !== JSON.stringify(normalizedSelection)) {
    agent.model = normalizedSelection;
  }
  return affected;
}

function configuredCustomerAgentIds(config) {
  const ids = new Set();
  if (Array.isArray(config.agents?.list)) {
    for (const entry of config.agents.list) {
      if (typeof entry?.id === "string" && parseAgentId(entry.id).kind !== "unknown") {
        ids.add(entry.id);
      }
    }
  }
  const entries = objectValue(config.agents?.entries);
  if (entries) {
    for (const agentId of Object.keys(entries)) {
      if (parseAgentId(agentId).kind !== "unknown") ids.add(agentId);
    }
  }
  return [...ids];
}

function customerModelProviders(env) {
  const anthropicBaseUrl = env.ANTHROPIC_BASE_URL?.trim();
  return anthropicBaseUrl
    ? { anthropic: { baseUrl: anthropicBaseUrl } }
    : {};
}

function resetConfiguredAgents(resetAgentIds, agentIds) {
  for (const agentId of agentIds) resetAgentIds.add(agentId);
}

function projectCustomerDefaultRuntime(config, unsafeProviders, allAgentIds, resetAgentIds) {
  config.agents.defaults.models ??= {};
  const defaultModels = projectCatalogModelMap(
    config.agents.defaults.models,
    SAFE_CUSTOMER_MODEL,
  );
  if (defaultModels.changed || unsafeProviders) {
    resetConfiguredAgents(resetAgentIds, allAgentIds);
  }
  const hasDefaultModel = Object.prototype.hasOwnProperty.call(config.agents.defaults, "model");
  const normalizedDefaultModel = hasDefaultModel
    ? normalizedCatalogSelection(config.agents.defaults.model)
    : null;
  if (unsafeProviders || (hasDefaultModel && normalizedDefaultModel === null)) {
    config.agents.defaults.model = { primary: SAFE_CUSTOMER_MODEL, fallbacks: [] };
    resetConfiguredAgents(resetAgentIds, allAgentIds);
  } else if (
    normalizedDefaultModel &&
    JSON.stringify(config.agents.defaults.model) !== JSON.stringify(normalizedDefaultModel)
  ) {
    config.agents.defaults.model = normalizedDefaultModel;
  }
  const defaultAgentRuntime = objectValue(config.agents.defaults.agentRuntime);
  if (isDirectAgentRuntimeId(defaultAgentRuntime?.id)) {
    delete config.agents.defaults.agentRuntime;
    resetConfiguredAgents(resetAgentIds, allAgentIds);
  }
  return new Set(defaultModels.removedRefs);
}

function unapprovedAgentModelRefs(entry) {
  const models = objectValue(objectValue(entry)?.models);
  if (!models) return [];
  return Object.keys(models).filter((modelRef) => !CUSTOMER_MODEL_REFS.has(modelRef));
}

function projectCustomerAgentRuntime(entry, agentId, unsafeProviders, resetAgentIds, directRefs) {
  if (!SAFE_AGENT_ID.test(agentId)) return;
  for (const modelRef of unapprovedAgentModelRefs(entry)) directRefs.add(modelRef);
  if (scrubOwnedAgentRuntime(entry, unsafeProviders)) resetAgentIds.add(agentId);
  if (agentId === "octogee-unmatched-route" && objectValue(entry)) delete entry.model;
}

function projectConfiguredCustomerAgentRuntimes(config, unsafeProviders, resetAgentIds, directRefs) {
  if (Array.isArray(config.agents.list)) {
    for (const entry of config.agents.list) {
      if (typeof entry?.id === "string") {
        projectCustomerAgentRuntime(entry, entry.id, unsafeProviders, resetAgentIds, directRefs);
      }
    }
  }
  const entries = objectValue(config.agents.entries);
  if (!entries) return;
  for (const [agentId, entry] of Object.entries(entries)) {
    projectCustomerAgentRuntime(entry, agentId, unsafeProviders, resetAgentIds, directRefs);
  }
}

function removeUnapprovedCustomerAuthProfiles(config) {
  const profiles = objectValue(config.auth?.profiles);
  if (!profiles) return;
  for (const [profileId, profile] of Object.entries(profiles)) {
    const provider = objectValue(profile)?.provider;
    const unapproved = profileId === CODEX_PROFILE ||
      profileId === CLAUDE_CLI_PROFILE ||
      provider === "openai-codex" ||
      provider === "claude-cli";
    if (unapproved) delete profiles[profileId];
  }
}

function scrubCustomerOauthConfig(config, env) {
  const resetAgentIds = new Set();
  config.agents ??= {};
  config.agents.defaults ??= {};
  config.agents.defaults.modelPolicy ??= {};
  config.agents.defaults.modelPolicy.allow = ["anthropic/*", "platform-openrouter/*", "platform-openai/*"];
  const allAgentIds = configuredCustomerAgentIds(config);
  const providers = objectValue(config.models?.providers);
  const expectedProviders = customerModelProviders(env);
  const unsafeProviders = JSON.stringify(providers ?? {}) !== JSON.stringify(expectedProviders);
  config.models ??= {};
  config.models.providers = expectedProviders;
  const directRuntimeModelRefs = projectCustomerDefaultRuntime(
    config,
    unsafeProviders,
    allAgentIds,
    resetAgentIds,
  );
  projectConfiguredCustomerAgentRuntimes(
    config,
    unsafeProviders,
    resetAgentIds,
    directRuntimeModelRefs,
  );
  removeUnapprovedCustomerAuthProfiles(config);
  return { resetAgentIds, directRuntimeModelRefs };
}

function removeFile(targetPath) {
  if (!fs.existsSync(targetPath)) return false;
  fs.rmSync(targetPath, { force: true });
  return true;
}

function canonicalAgentAuthProfiles(agentId) {
  const ref = (provider, id) => ({
    type: "api_key",
    provider,
    keyRef: { source: "exec", provider: "gcp-secret-manager", id },
  });
  return {
    "anthropic:default": ref("anthropic", `agent-model-token-${agentId}`),
    "platform-openrouter:default": ref(
      "platform-openrouter",
      `agent-model-token-openrouter-${agentId}`,
    ),
    "platform-openai:default": ref("platform-openai", `agent-model-token-openai-${agentId}`),
  };
}

function scrubAgentOauthProfiles(agentDir, agentId) {
  fs.mkdirSync(agentDir, { recursive: true, mode: 0o700 });
  const dbPath = path.join(agentDir, "openclaw-agent.sqlite");
  if (!fs.existsSync(dbPath)) return false;
  const db = new DatabaseSync(dbPath);
  try {
    if (db.prepare(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'openclaw_engine_anchor'",
    ).get()) return false;
    db.exec("PRAGMA busy_timeout = 30000;");
    db.exec(`
      CREATE TABLE IF NOT EXISTS auth_profile_store (
        store_key TEXT NOT NULL PRIMARY KEY,
        store_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
    const row = db.prepare(
      "SELECT store_json AS value FROM auth_profile_store WHERE store_key = ?",
    ).get("primary");
    const store = typeof row?.value === "string" ? JSON.parse(row.value) : {};
    if (!objectValue(store)) {
      throw new Error(`apply-gateway-class-policy: ${dbPath} auth profile store is invalid`);
    }
    const profiles = canonicalAgentAuthProfiles(agentId);
    if (JSON.stringify(store?.profiles) === JSON.stringify(profiles)) {
      fs.chmodSync(agentDir, 0o700);
      fs.chmodSync(dbPath, 0o600);
      return false;
    }
    store.profiles = profiles;
    db.prepare(
      `INSERT INTO auth_profile_store (store_key, store_json, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(store_key) DO UPDATE SET
         store_json = excluded.store_json,
         updated_at = excluded.updated_at`,
    ).run("primary", JSON.stringify(store), Date.now());
    fs.chmodSync(agentDir, 0o700);
    fs.chmodSync(dbPath, 0o600);
    return true;
  } finally {
    db.close();
  }
}

function projectAgentModelsJson(agentDir, providers) {
  const modelsPath = path.join(agentDir, "models.json");
  let current = {};
  if (fs.existsSync(modelsPath)) current = JSON.parse(fs.readFileSync(modelsPath, "utf8"));
  const desired = { providers };
  if (JSON.stringify(current) === JSON.stringify(desired)) {
    fs.chmodSync(agentDir, 0o700);
    fs.chmodSync(modelsPath, 0o600);
    return false;
  }
  fs.mkdirSync(agentDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(modelsPath, `${JSON.stringify(desired, null, 2)}\n`, { mode: 0o600 });
  fs.chmodSync(agentDir, 0o700);
  fs.chmodSync(modelsPath, 0o600);
  return true;
}

function readSessionMap(sessionsPath) {
  const sessions = JSON.parse(fs.readFileSync(sessionsPath, "utf8"));
  if (!objectValue(sessions)) {
    throw new Error(`apply-gateway-class-policy: ${sessionsPath} is not a session map`);
  }
  return sessions;
}

function resetLegacySessionStore(sessionsPath) {
  if (!fs.existsSync(sessionsPath)) return false;
  const sessions = readSessionMap(sessionsPath);
  let changed = false;
  for (const entry of Object.values(sessions)) {
    changed = clearSessionRuntimeState(entry) || changed;
  }
  if (!changed) return false;
  const tmpPath = `${sessionsPath}.oauth-purge.tmp`;
  fs.writeFileSync(tmpPath, `${JSON.stringify(sessions)}\n`, { mode: 0o600 });
  fs.renameSync(tmpPath, sessionsPath);
  return true;
}

function rollbackSessionTransaction(db, error) {
  try {
    db.exec("ROLLBACK");
  } catch {
    return error;
  }
  return error;
}

function parseSessionNode(row, dbPath) {
  if (typeof row.entry_json !== "string") return null;
  const entry = JSON.parse(row.entry_json);
  if (!objectValue(entry)) {
    throw new Error(
      `apply-gateway-class-policy: ${dbPath} session ${String(row.session_key)} is invalid`,
    );
  }
  return entry;
}

function mutateSqliteSessionStore(dbPath, mutateEntry) {
  if (!fs.existsSync(dbPath)) return false;
  const db = new DatabaseSync(dbPath);
  try {
    const table = db.prepare(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'session_nodes'",
    ).get();
    if (!table) return false;
    const rows = db.prepare("SELECT session_key, entry_json FROM session_nodes").all();
    const update = db.prepare(
      "UPDATE session_nodes SET entry_json = ? WHERE session_key = ?",
    );
    let changed = false;
    db.exec("BEGIN IMMEDIATE");
    try {
      for (const row of rows) {
        const entry = parseSessionNode(row, dbPath);
        if (!entry || !mutateEntry(entry)) continue;
        update.run(JSON.stringify(entry), row.session_key);
        changed = true;
      }
      db.exec("COMMIT");
      return changed;
    } catch (error) {
      throw rollbackSessionTransaction(db, error);
    }
  } finally {
    db.close();
  }
}

function resetAgentSessionStore(openclawDir, agentId) {
  const sessionsPath = path.join(openclawDir, "agents", agentId, "sessions", "sessions.json");
  const legacyChanged = resetLegacySessionStore(sessionsPath);
  const dbPath = path.join(openclawDir, "agents", agentId, "agent", "openclaw-agent.sqlite");
  const sqliteChanged = mutateSqliteSessionStore(dbPath, clearSessionRuntimeState);
  return legacyChanged || sqliteChanged;
}

function unsupportedCustomerModel(provider, model) {
  if (typeof model !== "string" || CUSTOMER_MODEL_REFS.has(model)) return false;
  return typeof provider !== "string" || !CUSTOMER_MODEL_REFS.has(`${provider}/${model}`);
}

function hasUnsafeSessionModelState(entry, directRuntimeModelRefs) {
  const providers = [entry.providerOverride, entry.modelProvider];
  const unsupportedProvider = providers.some(
    (provider) => typeof provider === "string" && !CUSTOMER_MODEL_PROVIDER_IDS.has(provider),
  );
  const bindings = [
    [entry.providerOverride, entry.modelOverride],
    [entry.modelProvider, entry.model],
    [entry.providerOverride, entry.modelOverrideFallbackOriginModel],
  ];
  const unsupportedModel = bindings.some(([provider, model]) =>
    unsupportedCustomerModel(provider, model));
  const directModel = bindings.some(([, model]) =>
    typeof model === "string" && directRuntimeModelRefs.has(model));
  return unsupportedProvider || unsupportedModel || directModel;
}

function hasUnsafeFallbackState(modelFallback, directRuntimeModelRefs) {
  const unsafeProvider = typeof modelFallback.prevProvider === "string" &&
    !CUSTOMER_MODEL_PROVIDER_IDS.has(modelFallback.prevProvider);
  const unsafeAuth = typeof modelFallback.prevAuthProfileOverride === "string" &&
    !CANONICAL_AGENT_AUTH_PROFILE_IDS.has(modelFallback.prevAuthProfileOverride);
  const unsafeModel = typeof modelFallback.prevModel === "string" && (
    unsupportedCustomerModel(modelFallback.prevProvider, modelFallback.prevModel) ||
    directRuntimeModelRefs.has(modelFallback.prevModel)
  );
  return unsafeProvider || unsafeAuth || unsafeModel;
}

function hasExecutableSessionState(entry) {
  return [
    entry.toolOverrides,
    entry.execHost,
    entry.execSecurity,
    entry.execAsk,
    entry.execNode,
    entry.execCwd,
    entry.elevatedLevel,
    entry.acpSessionBinding,
    entry.acp,
    entry.pluginExtensions,
  ].some((state) => state !== undefined);
}

function sessionEntryUsesUnsafeRuntime(rawEntry, directRuntimeModelRefs) {
  const entry = objectValue(rawEntry);
  if (!entry) return false;
  const modelFallback = objectValue(entry.modelFallback) ?? {};
  const cliSessionIds = Object.keys(objectValue(entry.cliSessionIds) ?? {});
  const cliSessionBindings = Object.keys(objectValue(entry.cliSessionBindings) ?? {});
  const unsafeAuth = typeof entry.authProfileOverride === "string" &&
    !CANONICAL_AGENT_AUTH_PROFILE_IDS.has(entry.authProfileOverride);
  return [
    hasUnsafeSessionModelState(entry, directRuntimeModelRefs),
    hasUnsafeFallbackState(modelFallback, directRuntimeModelRefs),
    [entry.agentRuntimeOverride, entry.agentHarnessId].some(isDirectAgentRuntimeId),
    entry.pluginOwnerId === "codex",
    typeof entry.claudeCliSessionId === "string",
    hasExecutableSessionState(entry),
    cliSessionIds.some(isDirectAgentRuntimeId),
    cliSessionBindings.some(isDirectAgentRuntimeId),
    unsafeAuth,
  ].some(Boolean);
}

function clearSessionRuntimeState(rawEntry) {
  const entry = objectValue(rawEntry);
  if (!entry) return false;
  let changed = false;
  for (const field of SESSION_RUNTIME_STATE_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(entry, field)) continue;
    delete entry[field];
    changed = true;
  }
  return changed;
}

function scrubUnsafeLegacySessions(sessionsPath, directRuntimeModelRefs) {
  if (!fs.existsSync(sessionsPath)) return false;
  const sessions = readSessionMap(sessionsPath);
  let changed = false;
  for (const entry of Object.values(sessions)) {
    if (sessionEntryUsesUnsafeRuntime(entry, directRuntimeModelRefs)) {
      changed = clearSessionRuntimeState(entry) || changed;
    }
  }
  if (changed) fs.writeFileSync(sessionsPath, `${JSON.stringify(sessions)}\n`, { mode: 0o600 });
  return changed;
}

function scrubUnsafePersistedSessions(openclawDir, agentId, directRuntimeModelRefs) {
  const sessionsPath = path.join(openclawDir, "agents", agentId, "sessions", "sessions.json");
  const legacyChanged = scrubUnsafeLegacySessions(sessionsPath, directRuntimeModelRefs);
  const dbPath = path.join(openclawDir, "agents", agentId, "agent", "openclaw-agent.sqlite");
  const sqliteChanged = mutateSqliteSessionStore(dbPath, (entry) =>
    sessionEntryUsesUnsafeRuntime(entry, directRuntimeModelRefs) && clearSessionRuntimeState(entry));
  return legacyChanged || sqliteChanged;
}

function projectUnmatchedRouteModelMetadata(openclawDir, config, modelProviders) {
  const unmatchedId = "octogee-unmatched-route";
  const configured = config.agents?.entries?.[unmatchedId] ||
    config.agents?.list?.some((agent) => agent.id === unmatchedId);
  if (!configured) return;
  const metadata = structuredClone(modelProviders);
  for (const provider of Object.values(metadata)) delete provider.apiKey;
  projectAgentModelsJson(path.join(openclawDir, "agents", unmatchedId, "agent"), metadata);
}

function scrubCustomerOauthDisk(
  configPath,
  config,
  env,
  {
    resetAgentIds,
    directRuntimeModelRefs,
    preserveNativeCredentials = false,
  },
) {
  const openclawDir = env.OPENCLAW_DIR ?? path.dirname(configPath);
  const homeDir = env.HOME ?? "/home/node";
  const nativeCredential = path.join(homeDir, ".claude", ".credentials.json");
  const nativeRemoved = preserveNativeCredentials
    ? false
    : [nativeCredential, `${nativeCredential}.tmp`].map(removeFile).some(Boolean);
  const agentIds = configuredCustomerAgentIds(config);
  const modelProviders = customerDiskModelProviders(env);
  if (nativeRemoved) agentIds.forEach((agentId) => resetAgentIds.add(agentId));
  for (const agentId of agentIds) {
    const agentDir = path.join(openclawDir, "agents", agentId, "agent");
    const authJson = path.join(agentDir, "codex-home", "auth.json");
    const authRemoved = preserveNativeCredentials
      ? false
      : [authJson, `${authJson}.tmp`, `${authJson}.promote.tmp`]
        .map(removeFile)
        .some(Boolean);
    const staging = path.join(agentDir, "codex-home.staging");
    const stagingRemoved = !preserveNativeCredentials && fs.existsSync(staging);
    if (stagingRemoved) fs.rmSync(staging, { recursive: true, force: true });
    const profilesScrubbed = scrubAgentOauthProfiles(agentDir, agentId);
    const modelsScrubbed = projectAgentModelsJson(agentDir, modelProviders);
    scrubUnsafePersistedSessions(openclawDir, agentId, directRuntimeModelRefs);
    if (
      authRemoved ||
      stagingRemoved ||
      profilesScrubbed ||
      modelsScrubbed
    ) {
      resetAgentIds.add(agentId);
    }
  }
  projectUnmatchedRouteModelMetadata(openclawDir, config, modelProviders);
  for (const agentId of resetAgentIds) resetAgentSessionStore(openclawDir, agentId);
}

function applyCustomerPolicy(config) {
  config.tools ??= {};
  config.tools.elevated ??= {};
  config.tools.elevated.enabled = false;
  config.tools.deny = addTools(
    removeTools(config.tools.deny, CUSTOMER_STRUCTURED_AVAILABLE_TOOLS),
    CUSTOMER_CODE_DENIED_TOOLS,
  );
  config.tools.exec = { mode: "deny" };
  config.tools.subagents ??= {};
  config.tools.subagents.tools ??= {};
  config.tools.subagents.tools.deny = addTools(config.tools.subagents.tools.deny, [
    "exec",
    "process",
  ]);
  removeSharedSubagentDefaults(config);
  setTerminal(config, false);
  restrictSessionVisibility(config);
  disableCustomerConfigMutation(config);
  disableCustomerAutomationsAndSkillWrites(config);
  forceCustomerMattermostProjection(config);
  forceCustomerWorkspaceOnly(config);
  convergePlatformCapabilities(config, false);
  clearConnectorWriteApproval(config);
  removePolicyCodexAuthPlaceholder(config);
  disableCodex(config);
}

function preserveBuilderPluginConfiguration(config) {
  if (!objectValue(config.plugins)) return;
  delete config.plugins.load;
  delete config.plugins.installs;
}

const BUILDER_SECRET_REF_PROVIDERS = new Set([
  "gcp-secret-manager",
  "octogee-mattermost",
]);
const INLINE_SECRET_KEYS = new Set([
  "apiKey",
  "key",
  "token",
  "secret",
  "password",
  "botToken",
  "keyRef",
  "tokenRef",
]);

function isSafeBuilderSecretRef(value) {
  const ref = objectValue(value);
  return (
    ref &&
    typeof ref.id === "string" &&
    BUILDER_SECRET_REF_PROVIDERS.has(ref.provider) &&
    ((ref.source === "exec" && ref.provider === "gcp-secret-manager") ||
      (ref.source === "file" && ref.provider === "octogee-mattermost"))
  );
}

function sanitizeBuilderSecretReferences(value) {
  if (Array.isArray(value)) {
    for (let index = value.length - 1; index >= 0; index--) {
      const child = value[index];
      if (isSecretRef(child)) {
        if (!isSafeBuilderSecretRef(child)) value.splice(index, 1);
        continue;
      }
      sanitizeBuilderSecretReferences(child);
    }
    return;
  }
  const record = objectValue(value);
  if (!record) return;
  for (const [key, child] of Object.entries(record)) {
    if (INLINE_SECRET_KEYS.has(key) && typeof child === "string") {
      delete record[key];
      continue;
    }
    if (isSecretRef(child)) {
      if (!isSafeBuilderSecretRef(child)) delete record[key];
      continue;
    }
    sanitizeBuilderSecretReferences(child);
  }
}

function projectBuilderSecretProviders(config, openclawDir) {
  sanitizeBuilderSecretReferences(config);
  projectAgentStoreSecretRef(config);
  config.secrets ??= {};
  const providers = objectValue(config.secrets.providers) ?? {};
  config.secrets.providers = providers;
  providers["gcp-secret-manager"] = {
    source: "exec",
    command: "/octogee/scripts/secret-resolver.mjs",
    passEnv: [
      "FLEET_BROKER_URL",
      "OCTOGEE_API_URL",
      "OCTOGEE_API_SA_TOKEN_PATH",
      "INTERNAL_SERVICE_KEY",
      "OPENCLAW_AGENTS_DIR",
      "OPENCLAW_DIR",
      "GATEWAY_ID",
      "HOME",
    ],
    jsonOnly: true,
    timeoutMs: 45000,
  };
  providers["octogee-mattermost"] = {
    source: "file",
    path: path.join(openclawDir, "secrets", "mattermost-accounts.json"),
    mode: "json",
  };
}

// A Builder gateway is the Builder's own OpenClaw. No platform credential lives
// in the pod, so host code, terminals, MCP servers, cron, skills, sub-agents,
// and the codex BYOSUB plugin stay at the Builder's discretion; the platform
// keeps only its plugin configuration boundary and tenant-scoped secret providers.
function applyBuilderPolicy(config, openclawDir, env) {
  projectMattermostAccounts(config, false);
  config.agents ??= {};
  config.agents.defaults ??= {};
  config.agents.defaults.modelPolicy ??= {};
  config.agents.defaults.modelPolicy.allow = [];
  convergePlatformCapabilities(config, true);
  preserveBuilderPluginConfiguration(config);
  projectBuilderSecretProviders(config, openclawDir);
  applyControlIdentityPolicy(config, env, readBuilderClaim(openclawDir, env.GATEWAY_ID?.trim()));
}

function applyBuilderTalkDefaults(config) {
  addBuilderToolCapabilities(config, ["screen", "talk_voice"]);
  config.plugins.entries["octogee-voice-tools"] ??= {};
  config.plugins.entries["octogee-voice-tools"].enabled ??= true;
  config.plugins.entries["octogee-voice-tools"].config = {
    brokerUrl: FLEET_BROKER_URL_TEMPLATE,
    tokenPath: API_SA_TOKEN_PATH_TEMPLATE,
  };
  config.talk ??= {};
  config.talk.realtime ??= {
    provider: "octogee-openai", providers: { "octogee-openai": { model: "gpt-live-1" }, octogee: {} },
    mode: "realtime", transport: "gateway-relay", brain: "agent-consult", consultRouting: "provider-direct",
  };
}

function applyControlIdentityPolicy(config, env, claim) {
  config.plugins ??= {};
  config.plugins.entries ??= {};
  config.plugins.entries["octogee-identity-tools"] = { enabled: isPerUserControlIdentity(env) };
  if (isPerUserControlIdentity(env)) {
    applyBuilderTalkDefaults(config);
    config.gateway ??= {};
    config.gateway.auth ??= {};
    const auth = config.gateway.auth;
    delete auth.token;
    delete auth.allowTailscale;
    auth.mode = OPENCLAW_TRUSTED_PROXY_AUTH.mode;
    auth.trustedProxy = structuredClone(OPENCLAW_TRUSTED_PROXY_AUTH.trustedProxy);
    auth.identityScopes = openClawIdentityScopes(claim?.ownerUid);
    config.gateway.trustedProxies = [...OPENCLAW_TRUSTED_PROXIES];
    config.gateway.roles = withOpenClawOperatorRoles(config.gateway.roles, claim?.builderSlug);
    // Only extend an allowlist that already exists. An absent `plugins.allow`
    // means "every plugin is allowed", so identity-tools is permitted already;
    // materializing a list here would narrow the gateway to this single entry
    // and drop the platform capability plugins convergence just enabled.
    if (Array.isArray(config.plugins.allow)) {
      config.plugins.allow = [...new Set([...config.plugins.allow, "octogee-identity-tools", "octogee-voice-tools", "talk-voice"])];
    }
    return;
  }
  const gateway = config.gateway;
  if (!gateway || typeof gateway !== "object") return;
  const auth = gateway.auth;
  const trustedProxyResidue = auth?.mode === "trusted-proxy" || auth?.trustedProxy !== undefined;
  if (trustedProxyResidue) {
    auth.mode = "token";
    delete auth.trustedProxy;
  }
  delete gateway.trustedProxies;
  delete gateway.roles;
}

function resolveGatewayClass(env) {
  if (env.GATEWAY_CLASS === "builder") {
    return env.GATEWAY_CLASS;
  }
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
  const openclawDir = env.OPENCLAW_DIR ?? path.dirname(configPath);
  const retiredMattermostInstallRecordRemoved =
    removeRetiredMattermostInstallRecord(openclawDir);
  const staleCodexInstallRecordRemoved = removeStaleCodexInstallRecord(openclawDir);
  const before = JSON.stringify(config);
  if (gatewayClass === "shared") {
    projectCustomerPlugins(config);
    projectCustomerSecretProviders(config, openclawDir);
    projectCustomerSpawnNamespaces(config);
    const scrub = scrubCustomerOauthConfig(config, env);
    scrubCustomerOauthDisk(
      configPath,
      config,
      env,
      {
        resetAgentIds: scrub.resetAgentIds,
        directRuntimeModelRefs: scrub.directRuntimeModelRefs,
        preserveNativeCredentials: gatewayClass === "builder",
      },
    );
    applyCustomerPolicy(config);
  } else if (gatewayClass === "builder") {
    applyBuilderPolicy(config, openclawDir, env);
  }
  if (JSON.stringify(config) === before) {
    const installRecordRemoved = retiredMattermostInstallRecordRemoved || staleCodexInstallRecordRemoved;
    let reason = "already-set";
    if (retiredMattermostInstallRecordRemoved) reason = "retired-mattermost-install";
    else if (staleCodexInstallRecordRemoved) reason = "source-mismatched-codex-install";
    return {
      applied: installRecordRemoved,
      reason,
      ...(installRecordRemoved ? { path: configPath } : {}),
      gatewayClass,
    };
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
