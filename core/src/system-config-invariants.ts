import { parseAgentId, type ParsedAgentId } from "@octogee/shared/types/identity";

type JsonObject = Record<string, unknown>;

const ABSENT = Symbol("absent");
const REQUIRED_ARRAY = "required-array" as const;
const FORBIDDEN_ARRAY = "forbidden-array" as const;

export type GatewayConfigClass = "shared" | "builder";

export interface SystemConfigInvariantContext {
  gatewayClass: GatewayConfigClass;
  gatewayId?: string;
  apiOrigin?: string;
}

type ExactInvariant = {
  kind: "exact";
  path: string;
  value: unknown | typeof ABSENT;
};

type RequiredArrayInvariant = {
  kind: typeof REQUIRED_ARRAY;
  path: string;
  values: readonly string[];
};

type ForbiddenArrayInvariant = {
  kind: typeof FORBIDDEN_ARRAY;
  path: string;
  values: readonly string[];
};

type CustomerAgentWorkspaceInvariant = {
  kind: "customer-agent-workspace";
  path:
    | "agents.list[].tools.fs.workspaceOnly"
    | "agents.entries.*.tools.fs.workspaceOnly";
};

type MattermostAccountProjectionInvariant = {
  kind: "mattermost-account-projection";
  path: "channels.mattermost.accounts";
};

type CustomerAgentToolPolicyInvariant = {
  kind: "customer-agent-tool-policy";
  path: "agents.list[].tools" | "agents.entries.*.tools";
};

type ProjectAgentToolPolicyInvariant = {
  kind: "project-agent-tool-policy";
  path: "agents.list[].tools" | "agents.entries.*.tools";
};

export type PlatformInvariant =
  | ExactInvariant
  | RequiredArrayInvariant
  | ForbiddenArrayInvariant
  | CustomerAgentWorkspaceInvariant
  | CustomerAgentToolPolicyInvariant
  | ProjectAgentToolPolicyInvariant
  | MattermostAccountProjectionInvariant;

const REQUIRED_PLUGINS = [
  "mattermost",
  "anthropic",
  "memory-core",
  "octogee-chat-tools",
  "octogee-access-tools",
  "octogee-connector-tools",
  "octogee-ops-tools",
  "octogee-project-tools",
  "octogee-board-tools",
  "octogee-status-tools",
  "octogee-web-tools",
  "octogee-workspace-tools",
] as const;

const RETIRED_PLUGINS = [
  "octogee-mattermost-tools",
  "octogee-router",
  "octogee-preview-tools",
  "octogee-publish-tools",
] as const;

const PLUGIN_ENTRIES = REQUIRED_PLUGINS.filter((id) => id !== "memory-core");

const FLEET_BROKER_URL_PLACEHOLDER = "${FLEET_BROKER_URL}";
const OCTOGEE_API_SA_TOKEN_PATH_PLACEHOLDER = "${OCTOGEE_API_SA_TOKEN_PATH}";

const PLATFORM_PLUGIN_CONFIGS: Readonly<Record<string, JsonObject>> = {
  "octogee-chat-tools": {
    siteUrl: "${MM_SITE_URL}",
    brokerUrl: FLEET_BROKER_URL_PLACEHOLDER,
    tokenPath: OCTOGEE_API_SA_TOKEN_PATH_PLACEHOLDER,
    customersRoot: "${CUSTOMERS_DIR}",
  },
  "octogee-access-tools": {
    brokerUrl: FLEET_BROKER_URL_PLACEHOLDER,
    tokenPath: OCTOGEE_API_SA_TOKEN_PATH_PLACEHOLDER,
  },
  "octogee-ops-tools": {
    brokerUrl: FLEET_BROKER_URL_PLACEHOLDER,
    tokenPath: OCTOGEE_API_SA_TOKEN_PATH_PLACEHOLDER,
  },
  "octogee-project-tools": {
    brokerUrl: FLEET_BROKER_URL_PLACEHOLDER,
    tokenPath: OCTOGEE_API_SA_TOKEN_PATH_PLACEHOLDER,
  },
  "octogee-board-tools": {
    brokerUrl: FLEET_BROKER_URL_PLACEHOLDER,
    tokenPath: OCTOGEE_API_SA_TOKEN_PATH_PLACEHOLDER,
  },
  "octogee-status-tools": {
    brokerUrl: FLEET_BROKER_URL_PLACEHOLDER,
    tokenPath: OCTOGEE_API_SA_TOKEN_PATH_PLACEHOLDER,
    gatewayClass: "${GATEWAY_CLASS}",
  },
  "octogee-web-tools": {
    brokerUrl: FLEET_BROKER_URL_PLACEHOLDER,
    gatewayId: "${GATEWAY_ID}",
    tokenPath: OCTOGEE_API_SA_TOKEN_PATH_PLACEHOLDER,
  },
  "octogee-workspace-tools": {},
};

const PLATFORM_PLUGIN_CONFIG_FIELDS: Readonly<Record<string, unknown>> = {
  "plugins.entries.octogee-connector-tools.config.brokerUrl":
    FLEET_BROKER_URL_PLACEHOLDER,
  "plugins.entries.octogee-connector-tools.config.tokenPath":
    OCTOGEE_API_SA_TOKEN_PATH_PLACEHOLDER,
  "plugins.entries.octogee-chat-tools.hooks.allowPromptInjection": true,
  "plugins.entries.octogee-chat-tools.hooks.allowConversationAccess": true,
  "plugins.entries.octogee-chat-tools.hooks.timeouts.before_dispatch": 3000,
  "plugins.entries.octogee-chat-tools.hooks.timeouts.before_prompt_build": 3000,
  "plugins.entries.octogee-chat-tools.hooks.timeouts.before_agent_run": 3000,
};

const CUSTOMER_CODE_DENIED_TOOLS = [
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
  "automations",
  "skill_workshop",
  "conversations_list",
  "conversations_send",
  "conversations_turn",
  "browser",
] as const;

const CUSTOMER_STRUCTURED_AVAILABLE_TOOLS = [
  "workspace_commit",
  "octogee_project_commit",
  "octogee_project_build",
  "octogee_project_test",
  "octogee_project_preview",
  "octogee_project_run_status",
  "octogee_project_publish",
] as const;

const CUSTOMER_WORKFLOW_TOOLS = [
  "octogee_project_create",
  "octogee_project_commit",
  "octogee_project_list",
  "octogee_project_build",
  "octogee_project_test",
  "octogee_project_preview",
  "octogee_project_run_status",
  "octogee_project_publish",
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
] as const;

const PRODUCTIVITY_TOOL_NAMES = CUSTOMER_WORKFLOW_TOOLS.filter((tool) =>
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
  "octogee_project_commit",
  "octogee_project_build",
  "octogee_project_test",
  "octogee_project_preview",
  "octogee_project_run_status",
] as const;

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
  "octogee_project_publish",
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
] as const;

function customerToolInvariants(): PlatformInvariant[] {
  return [
    {
      kind: REQUIRED_ARRAY,
      path: "tools.deny",
      values: CUSTOMER_CODE_DENIED_TOOLS,
    },
    {
      kind: FORBIDDEN_ARRAY,
      path: "tools.deny",
      values: CUSTOMER_STRUCTURED_AVAILABLE_TOOLS,
    },
    { kind: "exact", path: "tools.profile", value: "coding" },
    { kind: "exact", path: "tools.allow", value: ABSENT },
    { kind: "exact", path: "tools.alsoAllow", value: CUSTOMER_WORKFLOW_TOOLS },
    { kind: "exact", path: "tools.exec", value: { mode: "deny" } },
    { kind: "exact", path: "tools.fs.workspaceOnly", value: true },
    { kind: "exact", path: "tools.sessions.visibility", value: "self" },
    {
      kind: REQUIRED_ARRAY,
      path: "tools.subagents.tools.deny",
      values: ["exec", "process"],
    },
    { kind: "exact", path: "gateway.terminal.enabled", value: false },
    {
      kind: "exact",
      path: "channels.mattermost.network",
      value: { dangerouslyAllowPrivateNetwork: true },
    },
    {
      kind: "exact",
      path: "channels.mattermost.interactions",
      value: {
        callbackBaseUrl: "${MM_INTERACTIONS_CALLBACK_BASE_URL}",
        allowedSourceIps: ["${MM_INTERACTIONS_ALLOWED_SOURCE_IPS}"],
      },
    },
    { kind: "exact", path: "commands.bash", value: false },
    { kind: "exact", path: "commands.config", value: false },
    { kind: "exact", path: "commands.mcp", value: false },
    { kind: "exact", path: "commands.plugins", value: false },
    { kind: "exact", path: "commands.debug", value: false },
    { kind: "exact", path: "mcp.servers", value: ABSENT },
    { kind: "exact", path: "cron.triggers.enabled", value: false },
    { kind: "exact", path: "skills.load.allowSymlinkTargets", value: ABSENT },
    { kind: "exact", path: "skills.load.extraDirs", value: ABSENT },
    { kind: "exact", path: "skills.workshop.autonomous", value: { mode: "off" } },
    { kind: "exact", path: "skills.workshop.approvalPolicy", value: "pending" },
    { kind: "exact", path: "skills.workshop.allowSymlinkTargetWrites", value: false },
    { kind: FORBIDDEN_ARRAY, path: "plugins.allow", values: ["codex"] },
    { kind: "exact", path: "plugins.entries.codex", value: { enabled: false } },
    {
      kind: "customer-agent-workspace",
      path: "agents.list[].tools.fs.workspaceOnly",
    },
    {
      kind: "customer-agent-workspace",
      path: "agents.entries.*.tools.fs.workspaceOnly",
    },
    { kind: "customer-agent-tool-policy", path: "agents.list[].tools" },
    { kind: "customer-agent-tool-policy", path: "agents.entries.*.tools" },
  ];
}

function builderToolInvariants(): PlatformInvariant[] {
  return [
    { kind: "exact", path: "tools.elevated.enabled", value: false },
    {
      kind: FORBIDDEN_ARRAY,
      path: "tools.deny",
      values: CUSTOMER_CODE_DENIED_TOOLS,
    },
    { kind: "exact", path: "tools.exec", value: ABSENT },
    {
      kind: FORBIDDEN_ARRAY,
      path: "tools.subagents.tools.deny",
      values: ["exec", "process"],
    },
    { kind: "exact", path: "gateway.terminal.enabled", value: true },
    { kind: REQUIRED_ARRAY, path: "plugins.allow", values: ["codex"] },
    { kind: "exact", path: "plugins.entries.codex.enabled", value: true },
    {
      kind: "exact",
      path: "plugins.entries.codex.config.appServer.sandbox",
      value: "danger-full-access",
    },
    {
      kind: "exact",
      path: "plugins.entries.codex.config.appServer.approvalPolicy",
      value: "never",
    },
    { kind: "project-agent-tool-policy", path: "agents.list[].tools" },
    { kind: "project-agent-tool-policy", path: "agents.entries.*.tools" },
  ];
}

export function platformInvariantTable(
  context: SystemConfigInvariantContext,
): readonly PlatformInvariant[] {
  const isolated = context.gatewayClass === "builder";
  const gatewayId = context.gatewayId?.trim();
  const apiOrigin = context.apiOrigin?.trim().replace(/\/$/, "");
  if (isolated && (!gatewayId || !apiOrigin)) {
    throw new Error("gatewayId and apiOrigin are required for isolated config invariants");
  }
  const base: PlatformInvariant[] = [
    { kind: "exact", path: "discovery.mdns.mode", value: "off" },
    { kind: "exact", path: "gateway.port", value: 18789 },
    { kind: "exact", path: "gateway.mode", value: "local" },
    { kind: "exact", path: "gateway.bind", value: "lan" },
    { kind: "exact", path: "gateway.auth.mode", value: "token" },
    { kind: "exact", path: "gateway.auth.token", value: ABSENT },
    { kind: "exact", path: "gateway.auth.password", value: ABSENT },
    {
      kind: "exact",
      path: "gateway.controlUi.allowedOrigins",
      value: isolated
        ? [apiOrigin]
        : ["http://localhost:18789", "http://127.0.0.1:18789"],
    },
    {
      kind: "exact",
      path: "gateway.controlUi.basePath",
      value: isolated ? `/g/${gatewayId}/openclaw` : ABSENT,
    },
    { kind: "exact", path: "gateway.controlUi.allowInsecureAuth", value: isolated ? false : ABSENT },
    { kind: "exact", path: "gateway.controlUi.dangerouslyDisableDeviceAuth", value: isolated ? false : ABSENT },
    { kind: "exact", path: "gateway.controlUi.dangerouslyAllowHostHeaderOriginFallback", value: false },
    { kind: "exact", path: "logging.redactSensitive", value: "tools" },
    {
      kind: "exact",
      path: "secrets.providers.octogee-mattermost",
      value: {
        source: "file",
        path: "/home/node/.openclaw/secrets/mattermost-accounts.json",
        mode: "json",
      },
    },
    { kind: "exact", path: "channels.mattermost.enabled", value: true },
    { kind: "exact", path: "channels.mattermost.baseUrl", value: "${MM_URL}" },
    { kind: "exact", path: "channels.mattermost.network.dangerouslyAllowPrivateNetwork", value: true },
    {
      kind: "exact",
      path: "channels.mattermost.interactions.callbackBaseUrl",
      value: "${MM_INTERACTIONS_CALLBACK_BASE_URL}",
    },
    {
      kind: "exact",
      path: "channels.mattermost.interactions.allowedSourceIps",
      value: ["${MM_INTERACTIONS_ALLOWED_SOURCE_IPS}"],
    },
    { kind: "exact", path: "channels.mattermost.commands.native", value: false },
    { kind: "mattermost-account-projection", path: "channels.mattermost.accounts" },
    { kind: "exact", path: "plugins.enabled", value: true },
    { kind: REQUIRED_ARRAY, path: "plugins.allow", values: REQUIRED_PLUGINS },
    { kind: FORBIDDEN_ARRAY, path: "plugins.allow", values: RETIRED_PLUGINS },
    ...RETIRED_PLUGINS.map<PlatformInvariant>((id) => ({
      kind: "exact",
      path: `plugins.entries.${id}`,
      value: ABSENT,
    })),
    ...PLUGIN_ENTRIES.map<PlatformInvariant>((id) => ({
      kind: "exact",
      path: `plugins.entries.${id}.enabled`,
      value: true,
    })),
    ...Object.entries(PLATFORM_PLUGIN_CONFIGS).map<PlatformInvariant>(([id, value]) => ({
      kind: "exact",
      path: `plugins.entries.${id}.config`,
      value,
    })),
    ...Object.entries(PLATFORM_PLUGIN_CONFIG_FIELDS).map<PlatformInvariant>(([path, value]) => ({
      kind: "exact",
      path,
      value,
    })),
  ];
  return [...base, ...(context.gatewayClass === "shared" ? customerToolInvariants() : builderToolInvariants())];
}

function asObject(value: unknown): JsonObject | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as JsonObject
    : null;
}

function readPath(root: JsonObject, dottedPath: string): unknown | typeof ABSENT {
  let current: unknown = root;
  for (const part of dottedPath.split(".")) {
    const record = asObject(current);
    if (!record || !Object.prototype.hasOwnProperty.call(record, part)) return ABSENT;
    current = record[part];
  }
  return current;
}

function parentForPath(root: JsonObject, dottedPath: string): [JsonObject, string] {
  const parts = dottedPath.split(".");
  const leaf = parts.pop()!;
  let current = root;
  for (const part of parts) {
    const existing = asObject(current[part]);
    if (existing) {
      current = existing;
      continue;
    }
    const created: JsonObject = {};
    current[part] = created;
    current = created;
  }
  return [current, leaf];
}

function equal(left: unknown, right: unknown): boolean {
  if (left === ABSENT || right === ABSENT) return left === right;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right) && left.length === right.length &&
      left.every((value, index) => equal(value, right[index]));
  }
  const leftObject = asObject(left);
  const rightObject = asObject(right);
  if (leftObject || rightObject) {
    if (!leftObject || !rightObject) return false;
    const leftKeys = Object.keys(leftObject).sort();
    const rightKeys = Object.keys(rightObject).sort();
    return leftKeys.length === rightKeys.length &&
      leftKeys.every((key, index) => key === rightKeys[index] && equal(leftObject[key], rightObject[key]));
  }
  return Object.is(left, right);
}

function customerAgentRecords(
  config: JsonObject,
  path: CustomerAgentWorkspaceInvariant["path"],
): JsonObject[] {
  const agents = asObject(config.agents);
  if (!agents) return [];
  if (path === "agents.list[].tools.fs.workspaceOnly") {
    return Array.isArray(agents.list)
      ? agents.list.flatMap((entry) => {
        const record = asObject(entry);
        return record ? [record] : [];
      })
      : [];
  }
  const entries = asObject(agents.entries);
  return entries
    ? Object.values(entries).flatMap((entry) => {
      const record = asObject(entry);
      return record ? [record] : [];
    })
    : [];
}

function agentWorkspaceOnly(agent: JsonObject): boolean {
  return asObject(asObject(agent.tools)?.fs)?.workspaceOnly === true;
}

function forceAgentWorkspaceOnly(agent: JsonObject): void {
  const tools = asObject(agent.tools) ?? {};
  agent.tools = tools;
  const fs = asObject(tools.fs) ?? {};
  tools.fs = fs;
  fs.workspaceOnly = true;
}

function customerAgentEntries(
  config: JsonObject,
  path: CustomerAgentToolPolicyInvariant["path"],
): Array<{ agent: JsonObject; agentId: string }> {
  const agents = asObject(config.agents);
  if (!agents) return [];
  if (path === "agents.list[].tools") {
    return Array.isArray(agents.list)
      ? agents.list.flatMap((entry) => {
        const agent = asObject(entry);
        return agent && typeof agent.id === "string"
          ? [{ agent, agentId: agent.id }]
          : [];
      })
      : [];
  }
  const entries = asObject(agents.entries);
  return entries
    ? Object.entries(entries).flatMap(([agentId, entry]) => {
      const agent = asObject(entry);
      return agent ? [{ agent, agentId }] : [];
    })
    : [];
}

function agentToolPolicySatisfied(config: JsonObject, agent: JsonObject, agentId: string): boolean {
  const parsed = parseAgentId(agentId);
  const tools = asObject(agent.tools);
  const deny = Array.isArray(tools?.deny) ? tools.deny : [];
  const expectedAlsoAllow = allowedToolsForAgent(parsed.kind);
  const expectedSenderPolicy = customerToolsBySenderPolicy(config, agentId);
  return tools !== null
    && tools.profile === (parsed.kind === "coach" ? "coding" : "minimal")
    && equal(tools.alsoAllow, expectedAlsoAllow)
    && !Object.prototype.hasOwnProperty.call(tools, "allow")
    && (parsed.kind === "project"
      ? equal(deny, PROJECT_AGENT_DENIED_TOOLS)
      : CUSTOMER_CODE_DENIED_TOOLS.every((tool) => deny.includes(tool))
        && CUSTOMER_STRUCTURED_AVAILABLE_TOOLS.every((tool) => !deny.includes(tool)))
    && equal(tools.toolsBySender, expectedSenderPolicy);
}

function forceAgentToolPolicy(config: JsonObject, agent: JsonObject, agentId: string): void {
  const parsed = parseAgentId(agentId);
  const tools = asObject(agent.tools) ?? {};
  agent.tools = tools;
  tools.profile = parsed.kind === "coach" ? "coding" : "minimal";
  tools.alsoAllow = structuredClone(allowedToolsForAgent(parsed.kind));
  const deny = Array.isArray(tools.deny)
    ? tools.deny.filter((value): value is string => typeof value === "string")
    : [];
  tools.deny = parsed.kind === "project"
    ? structuredClone(PROJECT_AGENT_DENIED_TOOLS)
    : [
      ...deny.filter((tool) => !CUSTOMER_STRUCTURED_AVAILABLE_TOOLS.includes(
        tool as typeof CUSTOMER_STRUCTURED_AVAILABLE_TOOLS[number],
      )),
      ...CUSTOMER_CODE_DENIED_TOOLS.filter((tool) => !deny.includes(tool)),
    ];
  tools.toolsBySender = customerToolsBySenderPolicy(config, agentId);
  delete tools.allow;
}

function accountIdForAgentId(agentId: string): string | null {
  const parsed = parseAgentId(agentId);
  if (parsed.kind === "coach") return `${parsed.username}-coach`;
  if (parsed.kind === "project") return `${parsed.username}-proj-${parsed.project}`;
  return null;
}

function allowedToolsForAgent(kind: ParsedAgentId["kind"]): readonly string[] {
  if (kind === "coach") return CUSTOMER_WORKFLOW_TOOLS;
  if (kind === "project") return PROJECT_AGENT_ALLOWED_TOOLS;
  return [];
}

function customerToolsBySenderPolicy(_config: JsonObject, agentId: string): JsonObject {
  return parseAgentId(agentId).kind === "project"
    ? { "*": { deny: structuredClone(PRODUCTIVITY_TOOL_NAMES) } }
    : {};
}

const MATTERMOST_ID_RE = /^[a-z0-9]{26}$/u;

function trustedOwnerAllowFrom(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  if (value.length === 0) return [];
  return value.length === 1 &&
      typeof value[0] === "string" && MATTERMOST_ID_RE.test(value[0])
    ? [value[0]]
    : null;
}

function managedMattermostAccountIds(config: JsonObject): Set<string> {
  const result = new Set<string>();
  const agents = asObject(config.agents);
  if (!agents) return result;
  if (Array.isArray(agents.list)) {
    for (const entry of agents.list) {
      const agent = asObject(entry);
      const accountId = typeof agent?.id === "string" ? accountIdForAgentId(agent.id) : null;
      if (accountId) result.add(accountId);
    }
  }
  const entries = asObject(agents.entries);
  if (entries) {
    for (const agentId of Object.keys(entries)) {
      const accountId = accountIdForAgentId(agentId);
      if (accountId) result.add(accountId);
    }
  }
  return result;
}

function mattermostAccountSecretRef(accountId: string): JsonObject {
  return {
    source: "file",
    provider: "octogee-mattermost",
    id: `/${accountId.replace(/~/gu, "~0").replace(/\//gu, "~1")}`,
  };
}

function mattermostAccounts(config: JsonObject): JsonObject | null | typeof ABSENT {
  const value = readPath(config, "channels.mattermost.accounts");
  return value === ABSENT ? ABSENT : asObject(value);
}

function accountProjectionSatisfied(config: JsonObject): boolean {
  const accounts = mattermostAccounts(config);
  if (accounts === ABSENT) return true;
  if (!accounts) return false;
  const managed = managedMattermostAccountIds(config);
  return Object.entries(accounts).every(([accountId, rawAccount]) => {
    const account = asObject(rawAccount);
    return managed.has(accountId)
      && account !== null
      && equal(account.botToken, mattermostAccountSecretRef(accountId))
      && trustedOwnerAllowFrom(account.allowFrom) !== null
      && !Object.prototype.hasOwnProperty.call(account, "baseUrl")
      && !Object.prototype.hasOwnProperty.call(account, "network")
      && !Object.prototype.hasOwnProperty.call(account, "interactions")
      && !Object.prototype.hasOwnProperty.call(account, "callbackBaseUrl");
  });
}

function reconcileMattermostAccounts(config: JsonObject): void {
  const current = mattermostAccounts(config);
  if (current === ABSENT) return;
  const [mattermost, leaf] = parentForPath(config, "channels.mattermost.accounts");
  if (!current) {
    mattermost[leaf] = {};
    return;
  }
  const managed = managedMattermostAccountIds(config);
  for (const [accountId, rawAccount] of Object.entries(current)) {
    const account = asObject(rawAccount);
    if (!managed.has(accountId) || !account) {
      delete current[accountId];
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

function invariantSatisfied(config: JsonObject, invariant: PlatformInvariant): boolean {
  if (invariant.kind === "customer-agent-workspace") {
    return customerAgentRecords(config, invariant.path).every(agentWorkspaceOnly);
  }
  if (invariant.kind === "customer-agent-tool-policy") {
    return customerAgentEntries(config, invariant.path).every(({ agent, agentId }) =>
      agentToolPolicySatisfied(config, agent, agentId));
  }
  if (invariant.kind === "project-agent-tool-policy") {
    return customerAgentEntries(config, invariant.path)
      .filter(({ agentId }) => parseAgentId(agentId).kind === "project")
      .every(({ agent, agentId }) => agentToolPolicySatisfied(config, agent, agentId));
  }
  if (invariant.kind === "mattermost-account-projection") {
    return accountProjectionSatisfied(config);
  }
  const actual = readPath(config, invariant.path);
  if (invariant.kind === "exact") return equal(actual, invariant.value);
  if (invariant.kind === REQUIRED_ARRAY) {
    return Array.isArray(actual) && invariant.values.every((value) => actual.includes(value));
  }
  return !Array.isArray(actual) || invariant.values.every((value) => !actual.includes(value));
}

function applyInvariant(config: JsonObject, invariant: PlatformInvariant): void {
  if (invariant.kind === "customer-agent-workspace") {
    customerAgentRecords(config, invariant.path).forEach(forceAgentWorkspaceOnly);
    return;
  }
  if (invariant.kind === "customer-agent-tool-policy") {
    for (const { agent, agentId } of customerAgentEntries(config, invariant.path)) {
      forceAgentToolPolicy(config, agent, agentId);
    }
    return;
  }
  if (invariant.kind === "project-agent-tool-policy") {
    for (const { agent, agentId } of customerAgentEntries(config, invariant.path)) {
      if (parseAgentId(agentId).kind === "project") forceAgentToolPolicy(config, agent, agentId);
    }
    return;
  }
  if (invariant.kind === "mattermost-account-projection") {
    reconcileMattermostAccounts(config);
    return;
  }
  const [parent, leaf] = parentForPath(config, invariant.path);
  if (invariant.kind === "exact") {
    if (invariant.value === ABSENT) delete parent[leaf];
    else parent[leaf] = structuredClone(invariant.value);
    return;
  }
  const actual = Array.isArray(parent[leaf])
    ? parent[leaf].filter((value): value is string => typeof value === "string")
    : [];
  parent[leaf] = invariant.kind === REQUIRED_ARRAY
    ? [...actual, ...invariant.values.filter((value) => !actual.includes(value))]
    : actual.filter((value) => !invariant.values.includes(value));
}

export class PlatformInvariantPolicyError extends Error {
  readonly code = "platform-invariant-violation";

  constructor(readonly paths: string[]) {
    super(`platform-owned config paths changed: ${paths.join(", ")}`);
    this.name = "PlatformInvariantPolicyError";
  }
}

export function platformInvariantViolations(
  config: JsonObject,
  context: SystemConfigInvariantContext,
): string[] {
  return platformInvariantTable(context)
    .filter((invariant) => !invariantSatisfied(config, invariant))
    .map((invariant) => invariant.path);
}

export function assertPlatformInvariants(
  config: JsonObject,
  context: SystemConfigInvariantContext,
): void {
  const paths = platformInvariantViolations(config, context);
  if (paths.length > 0) throw new PlatformInvariantPolicyError(paths);
}

export function reconcilePlatformInvariants(
  config: JsonObject,
  context: SystemConfigInvariantContext,
): { changedPaths: string[] } {
  const table = platformInvariantTable(context);
  const changedPaths = Array.from(new Set(
    table
      .filter((invariant) => !invariantSatisfied(config, invariant))
      .map((invariant) => invariant.path),
  ));
  for (const invariant of table) {
    if (changedPaths.includes(invariant.path)) applyInvariant(config, invariant);
  }
  return { changedPaths };
}
