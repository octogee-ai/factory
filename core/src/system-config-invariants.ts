type JsonObject = Record<string, unknown>;

const ABSENT = Symbol("absent");

export type GatewayConfigClass = "shared" | "builder" | "operator";

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
  kind: "required-array";
  path: string;
  values: readonly string[];
};

type ForbiddenArrayInvariant = {
  kind: "forbidden-array";
  path: string;
  values: readonly string[];
};

export type PlatformInvariant = ExactInvariant | RequiredArrayInvariant | ForbiddenArrayInvariant;

const REQUIRED_PLUGINS = [
  "mattermost",
  "anthropic",
  "memory-core",
  "octogee-chat-tools",
  "octogee-access-tools",
  "octogee-connector-tools",
  "octogee-ops-tools",
  "octogee-preview-tools",
  "octogee-project-tools",
  "octogee-board-tools",
  "octogee-status-tools",
  "octogee-web-tools",
  "octogee-workspace-tools",
  "octogee-publish-tools",
] as const;

const RETIRED_PLUGINS = ["octogee-mattermost-tools", "octogee-router"] as const;

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
  "octogee-preview-tools": {},
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
  "octogee-publish-tools": {},
};

const PLATFORM_PLUGIN_CONFIG_FIELDS: Readonly<Record<string, unknown>> = {
  "plugins.entries.octogee-connector-tools.config.brokerUrl":
    FLEET_BROKER_URL_PLACEHOLDER,
  "plugins.entries.octogee-connector-tools.config.tokenPath":
    OCTOGEE_API_SA_TOKEN_PATH_PLACEHOLDER,
};

function isolatedToolInvariants(): PlatformInvariant[] {
  return [
    {
      kind: "forbidden-array",
      path: "tools.deny",
      values: ["exec", "process", "subagents", "sessions_spawn"],
    },
    { kind: "exact", path: "tools.exec", value: ABSENT },
    { kind: "exact", path: "tools.elevated.enabled", value: false },
  ];
}

export function platformInvariantTable(
  context: SystemConfigInvariantContext,
): readonly PlatformInvariant[] {
  const isolated = context.gatewayClass === "builder" || context.gatewayClass === "operator";
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
    { kind: "exact", path: "gateway.controlUi.allowInsecureAuth", value: ABSENT },
    { kind: "exact", path: "gateway.controlUi.dangerouslyDisableDeviceAuth", value: isolated ? false : ABSENT },
    { kind: "exact", path: "gateway.controlUi.dangerouslyAllowHostHeaderOriginFallback", value: false },
    { kind: "exact", path: "gateway.terminal.enabled", value: false },
    { kind: "exact", path: "logging.redactSensitive", value: ABSENT },
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
    { kind: "exact", path: "plugins.enabled", value: true },
    { kind: "required-array", path: "plugins.allow", values: REQUIRED_PLUGINS },
    { kind: "forbidden-array", path: "plugins.allow", values: RETIRED_PLUGINS },
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
  return isolated ? [...base, ...isolatedToolInvariants()] : base;
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

function invariantSatisfied(config: JsonObject, invariant: PlatformInvariant): boolean {
  const actual = readPath(config, invariant.path);
  if (invariant.kind === "exact") return equal(actual, invariant.value);
  if (invariant.kind === "required-array") {
    return Array.isArray(actual) && invariant.values.every((value) => actual.includes(value));
  }
  return !Array.isArray(actual) || invariant.values.every((value) => !actual.includes(value));
}

function applyInvariant(config: JsonObject, invariant: PlatformInvariant): void {
  const [parent, leaf] = parentForPath(config, invariant.path);
  if (invariant.kind === "exact") {
    if (invariant.value === ABSENT) delete parent[leaf];
    else parent[leaf] = structuredClone(invariant.value);
    return;
  }
  const actual = Array.isArray(parent[leaf])
    ? parent[leaf].filter((value): value is string => typeof value === "string")
    : [];
  parent[leaf] = invariant.kind === "required-array"
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
