type JsonObject = Record<string, unknown>;

export const AGENT_IMPORT_FORMAT_VERSION = 1 as const;

export type AgentImportInventoryClassification =
  | "credential"
  | "host"
  | "customer"
  | "platform"
  | "unknown";

export interface AgentImportConfigInventoryEntry {
  path: string;
  valueType: "array" | "boolean" | "null" | "number" | "object" | "string";
  classification: AgentImportInventoryClassification;
  sourceAgent: boolean;
}

export interface AgentImportModelHint {
  primary?: string;
  fallbacks?: string[];
}

export interface AgentImportPortableAgent {
  sourceAgentId: string;
  sourceOpenClawVersion?: string;
  name?: string;
  persona?: string;
  identity?: { name?: string; emoji?: string };
  heartbeat?: {
    every?: string;
    activeHours?: { start?: string; end?: string; timezone?: string };
    lightContext?: boolean;
  };
  bootstrapMaxChars?: number;
  bootstrapTotalMaxChars?: number;
  thinkingDefault?: string;
  verboseDefault?: string;
  timeoutSeconds?: number;
  requestedModel?: AgentImportModelHint;
}

export interface AgentImportConfigArtifacts {
  formatVersion: typeof AGENT_IMPORT_FORMAT_VERSION;
  portableAgent: AgentImportPortableAgent;
  configInventory: AgentImportConfigInventoryEntry[];
  doctorCandidate: JsonObject;
}

export type AgentImportDoctorOutcome = "migrated" | "unchanged" | "unsupported" | "failed";
export type AgentImportConfigDisposition =
  | "apply"
  | "reauth_then_apply"
  | "drop_unsupported"
  | "drop_platform"
  | "manual_review";

export interface AgentImportConfigDecision {
  path: string;
  disposition: AgentImportConfigDisposition;
  reason: string;
}

export interface AgentImportConfigPlan {
  analyzer: "octogee-policy-v1";
  doctorOutcome: AgentImportDoctorOutcome;
  effectiveOutcome: "applied" | "safe_baseline";
  identity: { name?: string; persona?: string; emoji?: string };
  runtimePatch: JsonObject;
  decisions: AgentImportConfigDecision[];
  reauth: string[];
}

export interface AgentImportApprovalFields {
  source: Record<string, string>;
  destinationHead: string;
  workspaceDigest: string;
  configDigest: string;
  resolutions: Record<string, string>;
}

export class AgentImportConfigError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "AgentImportConfigError";
  }
}

function record(value: unknown): JsonObject | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as JsonObject
    : null;
}

function own(value: JsonObject, key: string): unknown {
  return Object.prototype.hasOwnProperty.call(value, key) ? value[key] : undefined;
}

function trimmedString(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed && trimmed.length <= max ? trimmed : undefined;
}

function boundedInteger(value: unknown, min: number, max: number): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max
    ? value
    : undefined;
}

function compact<T extends JsonObject>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as T;
}

function activeHours(value: unknown): AgentImportPortableAgent["heartbeat"] extends infer H
  ? H extends { activeHours?: infer A } ? A | undefined : never
  : never {
  const source = record(value);
  if (!source || Object.keys(source).some((key) => !["start", "end", "timezone"].includes(key))) {
    return undefined;
  }
  const result = compact({
    start: trimmedString(source.start, 20),
    end: trimmedString(source.end, 20),
    timezone: trimmedString(source.timezone, 100),
  });
  return Object.keys(result).length > 0 ? result : undefined;
}

function safeHeartbeat(defaults: JsonObject, agent: JsonObject): AgentImportPortableAgent["heartbeat"] {
  const defaultHeartbeat = record(defaults.heartbeat) ?? {};
  const agentHeartbeat = record(agent.heartbeat) ?? {};
  const merged = { ...defaultHeartbeat, ...agentHeartbeat };
  const result = compact({
    every: trimmedString(merged.every, 40),
    activeHours: activeHours(merged.activeHours),
    lightContext: typeof merged.lightContext === "boolean" ? merged.lightContext : undefined,
  });
  return Object.keys(result).length > 0 ? result : undefined;
}

function safeModel(value: unknown): AgentImportModelHint | undefined {
  if (typeof value === "string") {
    const primary = trimmedString(value, 240);
    return primary ? { primary } : undefined;
  }
  const source = record(value);
  if (!source) return undefined;
  const primary = trimmedString(source.primary, 240);
  const fallbacks = Array.isArray(source.fallbacks)
    ? source.fallbacks.flatMap((entry) => {
        const fallback = trimmedString(entry, 240);
        return fallback ? [fallback] : [];
      }).slice(0, 20)
    : undefined;
  const result = compact({ primary, fallbacks: fallbacks?.length ? fallbacks : undefined });
  return Object.keys(result).length > 0 ? result : undefined;
}

function portableAgent(config: JsonObject, agent: JsonObject): AgentImportPortableAgent {
  const agents = record(config.agents) ?? {};
  const defaults = record(agents.defaults) ?? {};
  const identity = record(agent.identity) ?? {};
  const sourceOpenClawVersion = trimmedString(record(config.meta)?.lastTouchedVersion, 100);
  const id = trimmedString(agent.id, 160)!;
  const result: AgentImportPortableAgent = compact({
    sourceAgentId: id,
    sourceOpenClawVersion,
    name: trimmedString(agent.name, 80),
    persona: trimmedString(agent.persona, 4_000),
    identity: (() => {
      const safe = compact({
        name: trimmedString(identity.name, 80),
        emoji: trimmedString(identity.emoji, 32),
      });
      return Object.keys(safe).length > 0 ? safe : undefined;
    })(),
    heartbeat: safeHeartbeat(defaults, agent),
    bootstrapMaxChars: boundedInteger(own(agent, "bootstrapMaxChars") ?? defaults.bootstrapMaxChars, 1, 200_000),
    bootstrapTotalMaxChars: boundedInteger(
      own(agent, "bootstrapTotalMaxChars") ?? defaults.bootstrapTotalMaxChars,
      1,
      500_000,
    ),
    thinkingDefault: trimmedString(own(agent, "thinkingDefault") ?? defaults.thinkingDefault, 40),
    verboseDefault: trimmedString(own(agent, "verboseDefault") ?? defaults.verboseDefault, 40),
    timeoutSeconds: boundedInteger(own(agent, "timeoutSeconds") ?? defaults.timeoutSeconds, 1, 3_600),
    requestedModel: safeModel(own(agent, "model") ?? defaults.model),
  });
  return result;
}

function doctorAgent(portable: AgentImportPortableAgent): JsonObject {
  return compact({
    id: portable.sourceAgentId,
    name: portable.name,
    persona: portable.persona,
    identity: portable.identity ? structuredClone(portable.identity) : undefined,
    heartbeat: portable.heartbeat ? structuredClone(portable.heartbeat) : undefined,
    bootstrapMaxChars: portable.bootstrapMaxChars,
    bootstrapTotalMaxChars: portable.bootstrapTotalMaxChars,
    thinkingDefault: portable.thinkingDefault,
    verboseDefault: portable.verboseDefault,
    timeoutSeconds: portable.timeoutSeconds,
    model: portable.requestedModel ? structuredClone(portable.requestedModel) : undefined,
  });
}

function doctorCandidate(portable: AgentImportPortableAgent): JsonObject {
  return compact({
    meta: portable.sourceOpenClawVersion
      ? { lastTouchedVersion: portable.sourceOpenClawVersion }
      : undefined,
    agents: { list: [doctorAgent(portable)] },
  });
}

function valueType(value: unknown): AgentImportConfigInventoryEntry["valueType"] {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value as AgentImportConfigInventoryEntry["valueType"];
}

const CREDENTIAL_SEGMENTS = new Set([
  "apikey", "api_key", "authtoken", "cookie", "credential", "credentials", "oauth",
  "password", "privatekey", "private_key", "secret", "secrets", "token",
]);
const PLATFORM_ROOTS = new Set([
  "bindings", "channels", "cron", "discovery", "env", "gateway", "hooks", "logging",
  "nodes", "plugins", "sessions", "tools",
]);
const HOST_FIELDS = new Set(["agentdir", "workspace", "workspacedir", "statepath", "homedir"]);
const PORTABLE_AGENT_FIELDS = new Set([
  "name", "persona", "identity", "heartbeat", "bootstrapmaxchars", "bootstraptotalmaxchars",
  "thinkingdefault", "verbosedefault", "timeoutseconds", "model",
]);

function normalizedPathSegments(path: string): string[] {
  return path.split("[").join(".").split("]").join(".").split(".")
    .filter(Boolean)
    .map((part) => part.toLowerCase().replace(/-/g, ""));
}

function inventoryClassification(path: string, sourcePrefix: string): AgentImportInventoryClassification {
  const segments = normalizedPathSegments(path);
  if (segments.some((segment) => CREDENTIAL_SEGMENTS.has(segment))) return "credential";
  if (segments.some((segment) => HOST_FIELDS.has(segment))) return "host";
  const root = segments[0] ?? "";
  if (PLATFORM_ROOTS.has(root)) return "platform";
  if (path.startsWith(`${sourcePrefix}.`)) {
    const relative = path.slice(sourcePrefix.length + 1).split(".", 1)[0].split("[", 1)[0].toLowerCase();
    return PORTABLE_AGENT_FIELDS.has(relative) ? "customer" : "unknown";
  }
  return "unknown";
}

function inventoryEntries(
  value: unknown,
  path: string,
  sourcePrefix: string,
  entries: AgentImportConfigInventoryEntry[],
): void {
  const object = record(value);
  if (object && Object.keys(object).length > 0) {
    for (const key of Object.keys(object).sort()) {
      inventoryEntries(object[key], path ? `${path}.${key}` : key, sourcePrefix, entries);
    }
    return;
  }
  if (Array.isArray(value) && value.length > 0) {
    value.forEach((entry, index) => inventoryEntries(entry, `${path}[${index}]`, sourcePrefix, entries));
    return;
  }
  entries.push({
    path,
    valueType: valueType(value),
    classification: inventoryClassification(path, sourcePrefix),
    sourceAgent: path === sourcePrefix || path.startsWith(`${sourcePrefix}.`) || path.startsWith(`${sourcePrefix}[`),
  });
}

export function buildAgentImportConfigArtifacts(
  source: unknown,
  selectedAgentId: string,
): AgentImportConfigArtifacts {
  const config = record(source);
  if (!config) throw new AgentImportConfigError("invalid_source_config", "openclaw.json must contain an object");
  const list = record(config.agents)?.list;
  if (!Array.isArray(list)) {
    throw new AgentImportConfigError("source_agent_not_found", "openclaw.json has no agents.list");
  }
  const matches = list.flatMap((entry, index) => {
    const agent = record(entry);
    return agent?.id === selectedAgentId ? [{ agent, index }] : [];
  });
  if (matches.length === 0) {
    throw new AgentImportConfigError("source_agent_not_found", `source agent ${selectedAgentId} was not found`);
  }
  if (matches.length !== 1) {
    throw new AgentImportConfigError("source_agent_ambiguous", `source agent ${selectedAgentId} is duplicated`);
  }
  const selected = matches[0];
  const portable = portableAgent(config, selected.agent);
  const inventory: AgentImportConfigInventoryEntry[] = [];
  inventoryEntries(config, "", `agents.list[${selected.index}]`, inventory);
  return {
    formatVersion: AGENT_IMPORT_FORMAT_VERSION,
    portableAgent: portable,
    configInventory: inventory,
    doctorCandidate: doctorCandidate(portable),
  };
}

function exactKeys(value: JsonObject, keys: readonly string[], code = "invalid_config_artifact"): void {
  if (Object.keys(value).some((key) => !keys.includes(key))) {
    throw new AgentImportConfigError(code, "config artifact contains an unknown field");
  }
}

function assertNoCredentialKeys(value: unknown): void {
  if (Array.isArray(value)) {
    value.forEach(assertNoCredentialKeys);
    return;
  }
  const object = record(value);
  if (!object) return;
  for (const [key, entry] of Object.entries(object)) {
    const normalized = key.toLowerCase().replace(/-/g, "");
    if (CREDENTIAL_SEGMENTS.has(normalized) || normalized === "env") {
      throw new AgentImportConfigError("unsafe_config_artifact", "credential-bearing config path is forbidden");
    }
    assertNoCredentialKeys(entry);
  }
}

function validatePortable(value: unknown): AgentImportPortableAgent {
  const portable = record(value);
  if (!portable) throw new AgentImportConfigError("invalid_config_artifact", "portableAgent must be an object");
  exactKeys(portable, [
    "sourceAgentId", "sourceOpenClawVersion", "name", "persona", "identity", "heartbeat",
    "bootstrapMaxChars", "bootstrapTotalMaxChars", "thinkingDefault", "verboseDefault",
    "timeoutSeconds", "requestedModel",
  ]);
  const sourceAgentId = trimmedString(portable.sourceAgentId, 160);
  if (!sourceAgentId) throw new AgentImportConfigError("invalid_config_artifact", "sourceAgentId is required");
  const synthetic = {
    meta: { lastTouchedVersion: portable.sourceOpenClawVersion },
    agents: { list: [{
      id: sourceAgentId,
      name: portable.name,
      persona: portable.persona,
      identity: portable.identity,
      heartbeat: portable.heartbeat,
      bootstrapMaxChars: portable.bootstrapMaxChars,
      bootstrapTotalMaxChars: portable.bootstrapTotalMaxChars,
      thinkingDefault: portable.thinkingDefault,
      verboseDefault: portable.verboseDefault,
      timeoutSeconds: portable.timeoutSeconds,
      model: portable.requestedModel,
    }] },
  };
  const rebuilt = buildAgentImportConfigArtifacts(synthetic, sourceAgentId).portableAgent;
  if (stableJson(rebuilt) !== stableJson(portable)) {
    throw new AgentImportConfigError("invalid_config_artifact", "portableAgent contains an invalid value");
  }
  return rebuilt;
}

function validateInventory(value: unknown): AgentImportConfigInventoryEntry[] {
  if (!Array.isArray(value) || value.length > 20_000) {
    throw new AgentImportConfigError("invalid_config_artifact", "configInventory must be a bounded array");
  }
  return value.map((raw) => {
    const entry = record(raw);
    if (!entry) throw new AgentImportConfigError("invalid_config_artifact", "inventory entry must be an object");
    exactKeys(entry, ["path", "valueType", "classification", "sourceAgent"]);
    if (
      typeof entry.path !== "string" || entry.path.length > 1_024 ||
      !["array", "boolean", "null", "number", "object", "string"].includes(String(entry.valueType)) ||
      !["credential", "host", "customer", "platform", "unknown"].includes(String(entry.classification)) ||
      typeof entry.sourceAgent !== "boolean"
    ) {
      throw new AgentImportConfigError("invalid_config_artifact", "inventory entry is invalid");
    }
    return entry as unknown as AgentImportConfigInventoryEntry;
  });
}

export function validateAgentImportConfigArtifacts(value: unknown): AgentImportConfigArtifacts {
  const artifacts = record(value);
  if (!artifacts) throw new AgentImportConfigError("invalid_config_artifact", "config artifacts must be an object");
  exactKeys(artifacts, ["formatVersion", "portableAgent", "configInventory", "doctorCandidate"]);
  if (artifacts.formatVersion !== AGENT_IMPORT_FORMAT_VERSION) {
    throw new AgentImportConfigError("invalid_config_artifact", "unsupported config artifact version");
  }
  assertNoCredentialKeys(artifacts.portableAgent);
  assertNoCredentialKeys(artifacts.doctorCandidate);
  const portable = validatePortable(artifacts.portableAgent);
  const inventory = validateInventory(artifacts.configInventory);
  const expectedCandidate = doctorCandidate(portable);
  if (stableJson(expectedCandidate) !== stableJson(artifacts.doctorCandidate)) {
    throw new AgentImportConfigError("unsafe_config_artifact", "doctorCandidate does not match portableAgent");
  }
  return {
    formatVersion: AGENT_IMPORT_FORMAT_VERSION,
    portableAgent: portable,
    configInventory: inventory,
    doctorCandidate: expectedCandidate,
  };
}

function runtimeEntries(portable: AgentImportPortableAgent): Array<[string, unknown]> {
  const entries: Array<[string, unknown]> = [
    ["heartbeat", portable.heartbeat],
    ["bootstrapMaxChars", portable.bootstrapMaxChars],
    ["bootstrapTotalMaxChars", portable.bootstrapTotalMaxChars],
    ["thinkingDefault", portable.thinkingDefault],
    ["verboseDefault", portable.verboseDefault],
    ["timeoutSeconds", portable.timeoutSeconds],
  ];
  return entries.filter((entry) => entry[1] !== undefined);
}

function runtimeDecisionPaths(path: string, value: unknown): string[] {
  const object = record(value);
  if (!object) return [path];
  return Object.entries(object).flatMap(([key, entry]) =>
    runtimeDecisionPaths(`${path}.${key}`, entry)
  );
}

export function planAgentImportConfig(
  input: AgentImportConfigArtifacts,
  options: { doctorOutcome: AgentImportDoctorOutcome },
): AgentImportConfigPlan {
  const artifacts = validateAgentImportConfigArtifacts(input);
  const portable = artifacts.portableAgent;
  const doctorSafe = options.doctorOutcome === "migrated" || options.doctorOutcome === "unchanged";
  const runtimePatch: JsonObject = {};
  const decisions: AgentImportConfigDecision[] = [];
  const identity = compact({
    name: portable.name ?? portable.identity?.name,
    persona: portable.persona,
    emoji: portable.identity?.emoji,
  });
  for (const path of Object.keys(identity)) {
    decisions.push({ path: `identity.${path}`, disposition: "apply", reason: "portable identity field" });
  }
  for (const [path, value] of runtimeEntries(portable)) {
    const paths = runtimeDecisionPaths(path, value);
    if (doctorSafe) {
      runtimePatch[path] = structuredClone(value);
      decisions.push(...paths.map((decisionPath) => ({
        path: decisionPath,
        disposition: "apply" as const,
        reason: "validated by current OpenClaw doctor",
      })));
    } else {
      decisions.push(...paths.map((decisionPath) => ({
        path: decisionPath,
        disposition: "manual_review" as const,
        reason: "current OpenClaw could not validate the source config",
      })));
    }
  }
  if (portable.requestedModel?.primary) {
    decisions.push({
      path: "model.primary",
      disposition: "reauth_then_apply",
      reason: "model selection requires a new Octogee credential",
    });
  }
  if (portable.requestedModel?.fallbacks?.length) {
    decisions.push({
      path: "model.fallbacks",
      disposition: "reauth_then_apply",
      reason: "fallback models require new Octogee credentials",
    });
  }
  const seen = new Set(decisions.map((entry) => entry.path));
  for (const entry of artifacts.configInventory) {
    if (entry.classification === "customer") continue;
    const disposition = entry.classification === "unknown" ? "drop_unsupported" : "drop_platform";
    if (seen.has(entry.path)) continue;
    decisions.push({
      path: entry.path,
      disposition,
      reason: entry.classification === "credential"
        ? "credentials are never imported"
        : entry.classification === "unknown"
          ? "field is not in the portable allowlist"
          : "field is owned by the source host or Octogee platform",
    });
    seen.add(entry.path);
  }
  const reauth = [
    ...(portable.requestedModel?.primary ? ["models"] : []),
    ...(artifacts.configInventory.some((entry) => entry.path.startsWith("channels.")) ? ["channels"] : []),
    ...(artifacts.configInventory.some((entry) => entry.path.toLowerCase().includes("github")) ? ["github"] : []),
  ];
  return {
    analyzer: "octogee-policy-v1",
    doctorOutcome: options.doctorOutcome,
    effectiveOutcome: doctorSafe && Object.keys(runtimePatch).length > 0 ? "applied" : "safe_baseline",
    identity,
    runtimePatch,
    decisions,
    reauth: [...new Set(reauth)],
  };
}

const ARCHIVE_METADATA = new Set([
  "manifest.json", "portable-agent.json", "config-inventory.json", "doctor-candidate.json",
]);
const BLOCKED_WORKSPACE_SEGMENTS = new Set([
  ".git", ".ssh", "auth", "auth-profiles", "credentials", "secrets", "sessions", "state",
]);

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code <= 31 || code === 127) return true;
  }
  return false;
}

function safeRelativePath(path: string): string[] | null {
  if (!path || path.length > 2_048 || hasControlCharacter(path) || path.includes("\\")) return null;
  if (path.startsWith("/") || /^[A-Za-z]:/.test(path)) return null;
  const segments = path.split("/");
  return segments.some((segment) => !segment || segment === "." || segment === "..") ? null : segments;
}

export function classifyAgentImportArchivePath(path: string): "git" | "metadata" | "workspace" | null {
  if (ARCHIVE_METADATA.has(path)) return "metadata";
  const segments = safeRelativePath(path);
  if (!segments) return null;
  if (segments[0] === "workspace") {
    const relative = segments.slice(1);
    if (relative.length === 0) return null;
    const lowered = relative.map((segment) => segment.toLowerCase());
    if (lowered.some((segment) => BLOCKED_WORKSPACE_SEGMENTS.has(segment))) return null;
    if (lowered.some((segment) => segment === ".env" || segment.startsWith(".env."))) return null;
    const leaf = lowered[lowered.length - 1]!;
    if (
      leaf === "openclaw.json" || [".npmrc", ".pypirc", ".netrc"].includes(leaf) ||
      /^(credentials?|secrets?|tokens?|auth(?:-profiles?)?)([._-].*)?$/.test(leaf) ||
      /(^|[._-])(id_rsa|id_ed25519|private[-_.]?key)([._-]|$)/.test(leaf)
    ) return null;
    return "workspace";
  }
  if (segments[0] !== "git") return null;
  const relative = segments.slice(1).join("/");
  if (["HEAD", "packed-refs", "shallow"].includes(relative)) return "git";
  if (/^refs\/(heads|tags)\/[A-Za-z0-9][A-Za-z0-9._/-]{0,249}$/.test(relative)) return "git";
  if (/^objects\/[0-9a-f]{2}\/[0-9a-f]{38}$/.test(relative)) return "git";
  if (/^objects\/pack\/pack-[0-9a-f]{40}\.(pack|idx)$/.test(relative)) return "git";
  return null;
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  const object = record(value);
  if (!object) return value;
  return Object.fromEntries(Object.keys(object).sort().map((key) => [key, stableValue(object[key])]));
}

function stableJson(value: unknown): string {
  return JSON.stringify(stableValue(value));
}

export function buildAgentImportApprovalInput(fields: AgentImportApprovalFields): string {
  return stableJson(fields);
}
