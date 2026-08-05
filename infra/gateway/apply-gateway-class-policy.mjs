#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { parseAgentId } from "../../shared/dist/types/identity.js";

export const CUSTOMER_CODE_DENIED_TOOLS = [
  "exec",
  "process",
  "subagents",
  "sessions_spawn",
  "terminal",
  "preview_start",
  "octogee_publish",
  "workspace_commit",
  "octogee_project_commit",
  "bundle-mcp",
  "automations",
  "skill_workshop",
  "conversations_list",
  "conversations_send",
  "conversations_turn",
  "browser",
];
export const OCTOGEE_WORKFLOW_TOOLS = [
  "preview_start",
  "preview_stop",
  "preview_list",
  "octogee_publish",
  "octogee_project_create",
  "octogee_project_commit",
  "octogee_project_list",
  "delegated_access",
  "workspace_commit",
  "brave_search",
  "tavily_search",
  "tavily_extract",
  "octogee_chat_search",
  "octogee_chat_history",
  "octogee_chat_set_identity",
  "octogee_status",
  "octogee_ask_ops",
  "octogee_google_calendar_list",
  "octogee_google_calendar_read",
  "octogee_google_calendar_write",
  "octogee_google_gmail_read",
  "octogee_google_gmail_write",
  "octogee_google_drive_read",
  "octogee_google_docs_read",
  "octogee_google_docs_write",
  "octogee_google_contacts_read",
  "octogee_google_tasks_read",
  "octogee_google_tasks_write",
  "octogee_google_sheets_read",
  "octogee_google_sheets_write",
  "octogee_obsidian_read",
  "octogee_obsidian_write",
];
const PRODUCTIVITY_TOOL_NAMES = OCTOGEE_WORKFLOW_TOOLS.filter((tool) =>
  tool.startsWith("octogee_google_") || tool.startsWith("octogee_obsidian_"));
const PROJECT_AGENT_ALLOWED_TOOLS = [
  "read",
  "write",
  "edit",
  "apply_patch",
  "web_search",
  "web_fetch",
  "brave_search",
  "tavily_search",
  "tavily_extract",
];
const PROJECT_AGENT_DENIED_TOOLS = [
  ...PRODUCTIVITY_TOOL_NAMES,
  "exec",
  "process",
  "subagents",
  "sessions_spawn",
  "terminal",
  "preview_start",
  "octogee_publish",
  "workspace_commit",
  "octogee_project_commit",
  "octogee_project_create",
  "delegated_access",
  "octogee_status",
  "octogee_chat_search",
  "octogee_chat_history",
  "octogee_chat_set_identity",
  "bundle-mcp",
  "automations",
  "skill_workshop",
  "conversations_list",
  "conversations_send",
  "conversations_turn",
  "browser",
];
export const CUSTOMER_APPROVED_PLUGINS = [
  "mattermost",
  "anthropic",
  "memory-core",
  "octogee-chat-tools",
  "octogee-connector-tools",
  "octogee-access-tools",
  "octogee-preview-tools",
  "octogee-project-tools",
  "octogee-status-tools",
  "octogee-ops-tools",
  "octogee-web-tools",
  "octogee-workspace-tools",
  "octogee-publish-tools",
  "openai",
];
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
      brokerUrl: "${FLEET_BROKER_URL}",
      tokenPath: "${OCTOGEE_API_SA_TOKEN_PATH}",
      customersRoot: "${CUSTOMERS_DIR}",
    },
  },
  "octogee-connector-tools": {
    enabled: true,
    config: {
      brokerUrl: "${FLEET_BROKER_URL}",
      tokenPath: "${OCTOGEE_API_SA_TOKEN_PATH}",
      requireWriteApproval: true,
    },
  },
  "octogee-access-tools": {
    enabled: true,
    config: {
      brokerUrl: "${FLEET_BROKER_URL}",
      tokenPath: "${OCTOGEE_API_SA_TOKEN_PATH}",
    },
  },
  "octogee-preview-tools": { enabled: true, config: {} },
  "octogee-project-tools": {
    enabled: true,
    config: {
      brokerUrl: "${FLEET_BROKER_URL}",
      tokenPath: "${OCTOGEE_API_SA_TOKEN_PATH}",
    },
  },
  "octogee-status-tools": {
    enabled: true,
    config: {
      brokerUrl: "${FLEET_BROKER_URL}",
      tokenPath: "${OCTOGEE_API_SA_TOKEN_PATH}",
      gatewayClass: "${GATEWAY_CLASS}",
    },
  },
  "octogee-ops-tools": {
    enabled: true,
    config: {
      brokerUrl: "${FLEET_BROKER_URL}",
      tokenPath: "${OCTOGEE_API_SA_TOKEN_PATH}",
    },
  },
  "octogee-web-tools": {
    enabled: true,
    config: {
      brokerUrl: "${FLEET_BROKER_URL}",
      gatewayId: "${GATEWAY_ID}",
      tokenPath: "${OCTOGEE_API_SA_TOKEN_PATH}",
    },
  },
  "octogee-workspace-tools": { enabled: true, config: {} },
  "octogee-publish-tools": { enabled: true, config: {} },
};
const CONNECTOR_TOOLS_PLUGIN = "octogee-connector-tools";
const PROJECT_TOOLS_PLUGIN = "octogee-project-tools";
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
const CUSTOMER_MODEL_REFS = new Set([
  "anthropic/claude-sonnet-4-6",
  "anthropic/claude-haiku-4-5",
  "platform-openrouter/z-ai/glm-5.2",
  "platform-openrouter/minimax/minimax-m3",
  "platform-openrouter/deepseek/deepseek-v4-pro",
  "platform-openrouter/openai/gpt-5.6-luna",
  "platform-openai/gpt-5.4-mini",
]);
const CUSTOMER_MODEL_PROVIDER_IDS = new Set([
  "anthropic",
  "platform-openrouter",
  "platform-openai",
]);
const CUSTOMER_BROKER_MODELS = {
  "platform-openrouter": [
    ["z-ai/glm-5.2", 1_048_576],
    ["minimax/minimax-m3", 524_288],
    ["deepseek/deepseek-v4-pro", 1_048_576],
    ["openai/gpt-5.6-luna", 1_050_000],
  ],
  "platform-openai": [["gpt-5.4-mini", 400_000]],
};

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
      models: CUSTOMER_BROKER_MODELS[providerId].map(([id, contextTokens]) => ({
        id,
        name: id,
        contextTokens,
        contextWindow: contextTokens,
      })),
    };
  }
  return providers;
}

function canonicalCustomerModelDefinition(modelRef) {
  if (modelRef === "platform-openrouter/deepseek/deepseek-v4-pro") {
    return { alias: "deepseek" };
  }
  if (modelRef === "platform-openrouter/z-ai/glm-5.2") {
    return { alias: "glm", params: { thinking: "xhigh" } };
  }
  if (modelRef === "anthropic/claude-sonnet-4-6") {
    return { alias: "sonnet", params: { cacheRetention: "short" } };
  }
  if (modelRef === "anthropic/claude-haiku-4-5") {
    return { alias: "haiku", params: { cacheRetention: "short" } };
  }
  return {};
}
const CUSTOMER_AGENT_ID = /^octogee-[a-z0-9]+(?:-[a-z0-9]+)*-coach$/;

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
  config.tools.profile = "coding";
  delete config.tools.allow;
  config.tools.alsoAllow = [...OCTOGEE_WORKFLOW_TOOLS];
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

function allowPlugin(config, id) {
  config.plugins ??= {};
  if (Array.isArray(config.plugins.allow)) {
    if (!config.plugins.allow.includes(id)) config.plugins.allow.push(id);
  } else {
    config.plugins.allow = [id];
  }
  config.plugins.entries ??= {};
}

function enableConnectorTools(config) {
  allowPlugin(config, CONNECTOR_TOOLS_PLUGIN);
  config.plugins.entries[CONNECTOR_TOOLS_PLUGIN] ??= {};
  config.plugins.entries[CONNECTOR_TOOLS_PLUGIN].enabled = true;
  config.plugins.entries[CONNECTOR_TOOLS_PLUGIN].config ??= {};
}

function requireConnectorWriteApproval(config) {
  enableConnectorTools(config);
  config.plugins.entries[CONNECTOR_TOOLS_PLUGIN].config.requireWriteApproval = true;
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

function enableOpsTools(config) {
  allowPlugin(config, OPS_TOOLS_PLUGIN);
  config.plugins.entries[OPS_TOOLS_PLUGIN] ??= {};
  config.plugins.entries[OPS_TOOLS_PLUGIN].enabled = true;
  config.plugins.entries[OPS_TOOLS_PLUGIN].config ??= {};
}

function enableAccessTools(config) {
  allowPlugin(config, ACCESS_TOOLS_PLUGIN);
  config.plugins.entries[ACCESS_TOOLS_PLUGIN] ??= {};
  config.plugins.entries[ACCESS_TOOLS_PLUGIN].enabled = true;
  config.plugins.entries[ACCESS_TOOLS_PLUGIN].config ??= {};
}

function disableCodex(config) {
  config.plugins ??= {};
  config.plugins.allow = [...CUSTOMER_APPROVED_PLUGINS];
  config.plugins.entries ??= {};
  delete config.plugins.entries.codex;
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
  if (config.mcp && typeof config.mcp === "object" && !Array.isArray(config.mcp)) {
    delete config.mcp.servers;
  }
}

function forceCustomerWorkspaceOnly(config) {
  config.tools ??= {};
  config.tools.fs ??= {};
  config.tools.fs.workspaceOnly = true;
  if (Array.isArray(config.agents?.list)) {
    for (const entry of config.agents.list) {
      if (!objectValue(entry)) continue;
      entry.tools ??= {};
      entry.tools.fs ??= {};
      entry.tools.fs.workspaceOnly = true;
      const parsedLane = typeof entry.id === "string" && CUSTOMER_AGENT_ID.test(entry.id)
        ? (entry.id.includes("-proj-") ? "project" : "coach")
        : "unknown";
      entry.tools.profile = parsedLane === "coach" ? "coding" : "minimal";
      entry.tools.alsoAllow = parsedLane === "coach"
        ? [...OCTOGEE_WORKFLOW_TOOLS]
        : parsedLane === "project" ? [...PROJECT_AGENT_ALLOWED_TOOLS] : [];
      entry.tools.deny = parsedLane === "project"
        ? [...PROJECT_AGENT_DENIED_TOOLS]
        : addTools(entry.tools.deny, CUSTOMER_CODE_DENIED_TOOLS);
      entry.tools.toolsBySender = customerToolsBySender(config, entry.id);
      delete entry.tools.allow;
    }
  }
  const entries = objectValue(config.agents?.entries);
  if (!entries) return;
  for (const [agentId, rawEntry] of Object.entries(entries)) {
    const entry = objectValue(rawEntry);
    if (!entry) continue;
    entry.tools ??= {};
    entry.tools.fs ??= {};
    entry.tools.fs.workspaceOnly = true;
    const parsedLane = CUSTOMER_AGENT_ID.test(agentId)
      ? (agentId.includes("-proj-") ? "project" : "coach")
      : "unknown";
    entry.tools.profile = parsedLane === "coach" ? "coding" : "minimal";
    entry.tools.alsoAllow = parsedLane === "coach"
      ? [...OCTOGEE_WORKFLOW_TOOLS]
      : parsedLane === "project" ? [...PROJECT_AGENT_ALLOWED_TOOLS] : [];
    entry.tools.deny = parsedLane === "project"
      ? [...PROJECT_AGENT_DENIED_TOOLS]
      : addTools(entry.tools.deny, CUSTOMER_CODE_DENIED_TOOLS);
    entry.tools.toolsBySender = customerToolsBySender(config, agentId);
    delete entry.tools.allow;
  }
}

function customerToolsBySender(_config, agentId) {
  return agentId.includes("-proj-")
    ? { "*": { deny: [...PRODUCTIVITY_TOOL_NAMES] } }
    : {};
}

const MATTERMOST_ID_RE = /^[a-z0-9]{26}$/u;

function trustedOwnerAllowFrom(value) {
  if (Array.isArray(value) && value.length === 1 &&
      typeof value[0] === "string" && MATTERMOST_ID_RE.test(value[0])) return [value[0]];
  return [];
}

function managedMattermostAccountIds(config) {
  const accountIds = new Set();
  const accountIdForAgentId = (agentId) => {
    if (!CUSTOMER_AGENT_ID.test(agentId)) return null;
    const body = agentId.slice("octogee-".length, -"-coach".length);
    return body.includes("-proj-") ? body : `${body}-coach`;
  };
  if (Array.isArray(config.agents?.list)) {
    for (const entry of config.agents.list) {
      const accountId = objectValue(entry) ? accountIdForAgentId(entry.id) : null;
      if (accountId) accountIds.add(accountId);
    }
  }
  const entries = objectValue(config.agents?.entries);
  if (entries) {
    for (const agentId of Object.keys(entries)) {
      const accountId = accountIdForAgentId(agentId);
      if (accountId) accountIds.add(accountId);
    }
  }
  return accountIds;
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
  config.skills.workshop.approvalPolicy = "pending";
  config.skills.workshop.allowSymlinkTargetWrites = false;
}

function mattermostAccountSecretRef(accountId) {
  return {
    source: "file",
    provider: "octogee-mattermost",
    id: `/${accountId.replaceAll("~", "~0").replaceAll("/", "~1")}`,
  };
}

function forceCustomerMattermostProjection(config) {
  config.channels ??= {};
  config.channels.mattermost ??= {};
  const mattermost = config.channels.mattermost;
  mattermost.baseUrl = "${MM_URL}";
  mattermost.network = { dangerouslyAllowPrivateNetwork: true };
  mattermost.interactions = {
    callbackBaseUrl: "${MM_INTERACTIONS_CALLBACK_BASE_URL}",
    allowedSourceIps: ["${MM_INTERACTIONS_ALLOWED_SOURCE_IPS}"],
  };
  const managed = managedMattermostAccountIds(config);
  const accounts = objectValue(mattermost.accounts) ?? {};
  mattermost.accounts = accounts;
  for (const [accountId, rawAccount] of Object.entries(accounts)) {
    const account = objectValue(rawAccount);
    if (!managed.has(accountId) || !account) {
      delete accounts[accountId];
      continue;
    }
    account.botToken = mattermostAccountSecretRef(accountId);
    account.allowFrom = trustedOwnerAllowFrom(account.allowFrom) ?? [];
    delete account.baseUrl;
    delete account.network;
    delete account.interactions;
    delete account.callbackBaseUrl;
  }
}

function objectValue(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : null;
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

function neutralizeUnapprovedCustomerSecretRefs(value, config, segments = []) {
  if (Array.isArray(value)) {
    for (let index = value.length - 1; index >= 0; index--) {
      const child = value[index];
      if (isSecretRef(child)) {
        const expected = expectedCustomerSecretRef(config, [...segments, String(index)]);
        if (expected) value[index] = expected;
        else value.splice(index, 1);
        continue;
      }
      neutralizeUnapprovedCustomerSecretRefs(child, config, [...segments, String(index)]);
    }
    return;
  }
  const record = objectValue(value);
  if (!record) return;
  for (const [key, child] of Object.entries(record)) {
    if (segments.length === 1 && segments[0] === "secrets" && key === "providers") continue;
    if (isSecretRef(child)) {
      const expected = expectedCustomerSecretRef(config, [...segments, key]);
      if (expected) record[key] = expected;
      else delete record[key];
      continue;
    }
    neutralizeUnapprovedCustomerSecretRefs(child, config, [...segments, key]);
  }
}

function projectCustomerSecretProviders(config, openclawDir) {
  neutralizeUnapprovedCustomerSecretRefs(config, config);
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
      timeoutMs: 5000,
    },
    "octogee-mattermost": {
      source: "file",
      path: path.join(openclawDir, "secrets", "mattermost-accounts.json"),
      mode: "json",
    },
  };
}

function projectCustomerSpawnNamespaces(config) {
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
  if (internalHooks) {
    delete internalHooks.handlers;
    const load = objectValue(internalHooks.load);
    if (load) {
      delete load.extraDirs;
      if (Object.keys(load).length === 0) delete internalHooks.load;
    }
  }
  const qmd = objectValue(config.memory?.qmd);
  if (qmd) delete qmd.command;
  const providers = objectValue(config.models?.providers);
  if (providers) {
    for (const provider of Object.values(providers)) {
      const localService = objectValue(objectValue(provider)?.localService);
      if (localService) delete localService.command;
    }
  }
  const media = objectValue(config.tools?.media);
  if (media && Array.isArray(media.models)) {
    media.models = media.models.filter((model) => {
      const entry = objectValue(model);
      return entry && entry.type !== "cli" &&
        !Object.prototype.hasOwnProperty.call(entry, "command");
    });
  }
  const links = objectValue(config.tools?.links);
  if (links && Array.isArray(links.models)) {
    links.models = links.models.filter((model) => {
      const entry = objectValue(model);
      return entry && !Object.prototype.hasOwnProperty.call(entry, "command");
    });
  }
  const installPolicy = objectValue(config.security?.installPolicy);
  if (installPolicy) delete installPolicy.exec;
  const cron = objectValue(config.cron);
  if (cron) {
    for (const key of ["webhookToken", "webhookAuth", "failureAlert", "failureAlerts"]) {
      delete cron[key];
    }
  }
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

function scrubCustomerOauthConfig(config, env) {
  const resetAgentIds = new Set();
  config.agents ??= {};
  config.agents.defaults ??= {};
  const allAgentIds = configuredCustomerAgentIds(config);
  const providers = objectValue(config.models?.providers);
  const anthropicBaseUrl = env.ANTHROPIC_BASE_URL?.trim();
  const expectedProviders = anthropicBaseUrl
    ? { anthropic: { baseUrl: anthropicBaseUrl } }
    : {};
  const unsafeProviders = JSON.stringify(providers ?? {}) !== JSON.stringify(expectedProviders);
  config.models ??= {};
  config.models.providers = expectedProviders;
  config.agents.defaults.models ??= {};
  const defaultModels = projectCatalogModelMap(
    config.agents.defaults.models,
    SAFE_CUSTOMER_MODEL,
  );
  const directRefs = defaultModels.removedRefs;
  const allDirectRefs = new Set(directRefs);
  if (defaultModels.changed || unsafeProviders) {
    allAgentIds.forEach((agentId) => resetAgentIds.add(agentId));
  }
  const hasDefaultModel = Object.prototype.hasOwnProperty.call(config.agents.defaults, "model");
  const normalizedDefaultModel = hasDefaultModel
    ? normalizedCatalogSelection(config.agents.defaults.model)
    : null;
  if (unsafeProviders || (hasDefaultModel && normalizedDefaultModel === null)) {
    config.agents.defaults.model = { primary: SAFE_CUSTOMER_MODEL, fallbacks: [] };
    allAgentIds.forEach((agentId) => resetAgentIds.add(agentId));
  } else if (
    normalizedDefaultModel &&
    JSON.stringify(config.agents.defaults.model) !== JSON.stringify(normalizedDefaultModel)
  ) {
    config.agents.defaults.model = normalizedDefaultModel;
  }
  const defaultAgentRuntime = objectValue(config.agents.defaults.agentRuntime);
  if (isDirectAgentRuntimeId(defaultAgentRuntime?.id)) {
    delete config.agents.defaults.agentRuntime;
    allAgentIds.forEach((agentId) => resetAgentIds.add(agentId));
  }
  if (Array.isArray(config.agents.list)) {
    for (const entry of config.agents.list) {
      if (typeof entry?.id !== "string" || !SAFE_AGENT_ID.test(entry.id)) continue;
      const localRefs = objectValue(entry.models)
        ? Object.keys(entry.models).filter((modelRef) => !CUSTOMER_MODEL_REFS.has(modelRef))
        : [];
      localRefs.forEach((modelRef) => allDirectRefs.add(modelRef));
      if (scrubOwnedAgentRuntime(entry, unsafeProviders)) resetAgentIds.add(entry.id);
    }
  }
  const entries = objectValue(config.agents.entries);
  if (entries) {
    for (const [agentId, entry] of Object.entries(entries)) {
      if (!SAFE_AGENT_ID.test(agentId)) continue;
      const localModels = objectValue(objectValue(entry)?.models);
      if (localModels) {
        Object.keys(localModels)
          .filter((modelRef) => !CUSTOMER_MODEL_REFS.has(modelRef))
          .forEach((modelRef) => allDirectRefs.add(modelRef));
      }
      if (scrubOwnedAgentRuntime(entry, unsafeProviders)) resetAgentIds.add(agentId);
    }
  }
  const profiles = objectValue(config.auth?.profiles);
  if (profiles) {
    for (const [profileId, profile] of Object.entries(profiles)) {
      const provider = objectValue(profile)?.provider;
      if (
        profileId === CODEX_PROFILE ||
        profileId === CLAUDE_CLI_PROFILE ||
        provider === "openai-codex" ||
        provider === "claude-cli"
      ) {
        delete profiles[profileId];
      }
    }
  }
  return { resetAgentIds, directRuntimeModelRefs: allDirectRefs };
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
  const db = new DatabaseSync(dbPath);
  try {
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

function resetAgentSessionStore(openclawDir, agentId) {
  const sessionsPath = path.join(openclawDir, "agents", agentId, "sessions", "sessions.json");
  let changed = false;
  if (fs.existsSync(sessionsPath)) {
    const sessions = JSON.parse(fs.readFileSync(sessionsPath, "utf8"));
    if (!objectValue(sessions)) {
      throw new Error(`apply-gateway-class-policy: ${sessionsPath} is not a session map`);
    }
    let sessionsChanged = false;
    for (const entry of Object.values(sessions)) {
      sessionsChanged = clearSessionRuntimeState(entry) || sessionsChanged;
    }
    if (sessionsChanged) {
      const tmpPath = `${sessionsPath}.oauth-purge.tmp`;
      fs.writeFileSync(tmpPath, `${JSON.stringify(sessions)}\n`, { mode: 0o600 });
      fs.renameSync(tmpPath, sessionsPath);
      changed = true;
    }
  }
  const dbPath = path.join(openclawDir, "agents", agentId, "agent", "openclaw-agent.sqlite");
  if (fs.existsSync(dbPath)) {
    const db = new DatabaseSync(dbPath);
    try {
      const table = db.prepare(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'session_nodes'",
      ).get();
      if (table) {
        const rows = db.prepare("SELECT session_key, entry_json FROM session_nodes").all();
        const update = db.prepare(
          "UPDATE session_nodes SET entry_json = ? WHERE session_key = ?",
        );
        db.exec("BEGIN IMMEDIATE");
        for (const row of rows) {
          if (typeof row.entry_json !== "string") continue;
          const entry = JSON.parse(row.entry_json);
          if (!objectValue(entry)) {
            throw new Error(
              `apply-gateway-class-policy: ${dbPath} session ${String(row.session_key)} is invalid`,
            );
          }
          if (!clearSessionRuntimeState(entry)) continue;
          update.run(JSON.stringify(entry), row.session_key);
          changed = true;
        }
        db.exec("COMMIT");
      }
    } catch (error) {
      try {
        db.exec("ROLLBACK");
      } catch {
        // Preserve the original failure when no transaction was active.
      }
      throw error;
    } finally {
      db.close();
    }
  }
  return changed;
}

function sessionEntryUsesUnsafeRuntime(rawEntry, directRuntimeModelRefs) {
  const entry = objectValue(rawEntry);
  if (!entry) return false;
  const providers = [entry.providerOverride, entry.modelProvider];
  const unsupportedModel = (provider, model) => {
    if (typeof model !== "string") return false;
    if (CUSTOMER_MODEL_REFS.has(model)) return false;
    return typeof provider !== "string" || !CUSTOMER_MODEL_REFS.has(`${provider}/${model}`);
  };
  const modelFallback = objectValue(entry.modelFallback) ?? {};
  const cliSessionIds = Object.keys(objectValue(entry.cliSessionIds) ?? {});
  const cliSessionBindings = Object.keys(objectValue(entry.cliSessionBindings) ?? {});
  const hasExecutableSessionState = [
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
  return (
    providers.some(
      (provider) =>
        typeof provider === "string" && !CUSTOMER_MODEL_PROVIDER_IDS.has(provider),
    ) ||
    unsupportedModel(entry.providerOverride, entry.modelOverride) ||
    unsupportedModel(entry.modelProvider, entry.model) ||
    unsupportedModel(entry.providerOverride, entry.modelOverrideFallbackOriginModel) ||
    [entry.modelOverride, entry.model, entry.modelOverrideFallbackOriginModel].some(
      (model) => typeof model === "string" && directRuntimeModelRefs.has(model),
    ) ||
    isDirectAgentRuntimeId(entry.agentRuntimeOverride) ||
    isDirectAgentRuntimeId(entry.agentHarnessId) ||
    entry.pluginOwnerId === "codex" ||
    typeof entry.claudeCliSessionId === "string" ||
    hasExecutableSessionState ||
    cliSessionIds.some(isDirectAgentRuntimeId) ||
    cliSessionBindings.some(isDirectAgentRuntimeId) ||
    (typeof entry.authProfileOverride === "string" &&
      !CANONICAL_AGENT_AUTH_PROFILE_IDS.has(entry.authProfileOverride)) ||
    (typeof modelFallback.prevProvider === "string" &&
      !CUSTOMER_MODEL_PROVIDER_IDS.has(modelFallback.prevProvider)) ||
    (typeof modelFallback.prevAuthProfileOverride === "string" &&
      !CANONICAL_AGENT_AUTH_PROFILE_IDS.has(modelFallback.prevAuthProfileOverride)) ||
    (typeof modelFallback.prevModel === "string" &&
      (unsupportedModel(modelFallback.prevProvider, modelFallback.prevModel) ||
        directRuntimeModelRefs.has(modelFallback.prevModel)))
  );
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

function scrubUnsafePersistedSessions(openclawDir, agentId, directRuntimeModelRefs) {
  let changed = false;
  const sessionsPath = path.join(openclawDir, "agents", agentId, "sessions", "sessions.json");
  if (fs.existsSync(sessionsPath)) {
    const sessions = JSON.parse(fs.readFileSync(sessionsPath, "utf8"));
    if (!objectValue(sessions)) {
      throw new Error(`apply-gateway-class-policy: ${sessionsPath} is not a session map`);
    }
    for (const entry of Object.values(sessions)) {
      if (sessionEntryUsesUnsafeRuntime(entry, directRuntimeModelRefs)) {
        changed = clearSessionRuntimeState(entry) || changed;
      }
    }
    if (changed) fs.writeFileSync(sessionsPath, `${JSON.stringify(sessions)}\n`, { mode: 0o600 });
  }
  const dbPath = path.join(openclawDir, "agents", agentId, "agent", "openclaw-agent.sqlite");
  if (!fs.existsSync(dbPath)) return changed;
  const db = new DatabaseSync(dbPath);
  try {
    const table = db.prepare(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'session_nodes'",
    ).get();
    if (!table) return changed;
    const rows = db.prepare("SELECT session_key, entry_json FROM session_nodes").all();
    const update = db.prepare(
      "UPDATE session_nodes SET entry_json = ? WHERE session_key = ?",
    );
    db.exec("BEGIN IMMEDIATE");
    for (const row of rows) {
      if (typeof row.entry_json !== "string") continue;
      const entry = JSON.parse(row.entry_json);
      if (!objectValue(entry)) {
        throw new Error(
          `apply-gateway-class-policy: ${dbPath} session ${String(row.session_key)} is invalid`,
        );
      }
      if (
        !sessionEntryUsesUnsafeRuntime(entry, directRuntimeModelRefs) ||
        !clearSessionRuntimeState(entry)
      ) continue;
      update.run(JSON.stringify(entry), row.session_key);
      changed = true;
    }
    db.exec("COMMIT");
    return changed;
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // Preserve the original failure when no transaction was active.
    }
    throw error;
  } finally {
    db.close();
  }
}

function scrubCustomerOauthDisk(configPath, config, env, resetAgentIds, directRuntimeModelRefs) {
  const openclawDir = env.OPENCLAW_DIR ?? path.dirname(configPath);
  const homeDir = env.HOME ?? "/home/node";
  const nativeCredential = path.join(homeDir, ".claude", ".credentials.json");
  const nativeRemoved = [nativeCredential, `${nativeCredential}.tmp`]
    .map(removeFile)
    .some(Boolean);
  const agentIds = configuredCustomerAgentIds(config);
  const modelProviders = customerDiskModelProviders(env);
  if (nativeRemoved) agentIds.forEach((agentId) => resetAgentIds.add(agentId));
  for (const agentId of agentIds) {
    const agentDir = path.join(openclawDir, "agents", agentId, "agent");
    const authJson = path.join(agentDir, "codex-home", "auth.json");
    const authRemoved = [authJson, `${authJson}.tmp`, `${authJson}.promote.tmp`]
      .map(removeFile)
      .some(Boolean);
    const staging = path.join(agentDir, "codex-home.staging");
    const stagingRemoved = fs.existsSync(staging);
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
  for (const agentId of resetAgentIds) resetAgentSessionStore(openclawDir, agentId);
}

function applySharedPolicy(config) {
  config.tools ??= {};
  config.tools.deny = addTools(config.tools.deny, CUSTOMER_CODE_DENIED_TOOLS);
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
  allowOctogeeWorkflowTools(config);
  enableProjectTools(config);
  enableOpsTools(config);
  enableAccessTools(config);
  requireConnectorWriteApproval(config);
  removePolicyCodexAuthPlaceholder(config);
  disableCodex(config);
}

function applyBuilderPolicy(config) {
  config.tools ??= {};
  config.tools.deny = addTools(config.tools.deny, CUSTOMER_CODE_DENIED_TOOLS);
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
  allowOctogeeWorkflowTools(config);
  enableProjectTools(config);
  enableOpsTools(config);
  enableAccessTools(config);
  removePolicyCodexAuthPlaceholder(config);
  requireConnectorWriteApproval(config);
  disableCodex(config);
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
    const openclawDir = env.OPENCLAW_DIR ?? path.dirname(configPath);
    projectCustomerPlugins(config);
    projectCustomerSecretProviders(config, openclawDir);
    projectCustomerSpawnNamespaces(config);
    const scrub = scrubCustomerOauthConfig(config, env);
    scrubCustomerOauthDisk(
      configPath,
      config,
      env,
      scrub.resetAgentIds,
      scrub.directRuntimeModelRefs,
    );
    applyBuilderPolicy(config);
  } else if (gatewayClass === "shared") {
    const openclawDir = env.OPENCLAW_DIR ?? path.dirname(configPath);
    projectCustomerPlugins(config);
    projectCustomerSecretProviders(config, openclawDir);
    projectCustomerSpawnNamespaces(config);
    const scrub = scrubCustomerOauthConfig(config, env);
    scrubCustomerOauthDisk(
      configPath,
      config,
      env,
      scrub.resetAgentIds,
      scrub.directRuntimeModelRefs,
    );
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
