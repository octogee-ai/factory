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
  effectiveOutcome: "applied" | "safe_baseline" | "unchanged";
  identity: { name?: string; persona?: string; emoji?: string };
  workspaceRuntimePatch: JsonObject;
  runtimePatch: JsonObject;
  decisions: AgentImportConfigDecision[];
  reauth: string[];
}

export interface AgentImportWorkspacePolicy {
  preserveConvergedContextFiles: boolean;
}

export const AGENT_IMPORT_AUTHORIZATION_INTENTS = [
  "source_listing",
  "preview",
  "apply",
  "status",
  "abandon",
  "rollback",
] as const;

export type AgentImportAuthorizationIntent =
  typeof AGENT_IMPORT_AUTHORIZATION_INTENTS[number];

export function isAgentImportAuthorizationIntent(
  value: unknown,
): value is AgentImportAuthorizationIntent {
  return typeof value === "string" &&
    (AGENT_IMPORT_AUTHORIZATION_INTENTS as readonly string[]).includes(value);
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

function valueType(value: unknown): AgentImportConfigInventoryEntry["valueType"] {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value as AgentImportConfigInventoryEntry["valueType"];
}

const CREDENTIAL_SEGMENTS = new Set([
  "apikey", "api_key", "authkey", "authtoken", "cookie", "credential", "credentials", "key",
  "oauth", "passphrase", "password", "privatekey", "private_key", "secret", "secrets",
  "sharedkey", "token",
]);
const PLATFORM_ROOTS = new Set([
  "bindings", "channels", "cron", "discovery", "env", "gateway", "hooks", "logging",
  "nodes", "plugins", "sessions", "tools",
]);
const HOST_FIELDS = new Set(["agentdir", "workspace", "workspacedir", "statepath", "homedir"]);
const PORTABLE_AGENT_FIELDS = new Set([
  "id", "name", "persona", "identity", "heartbeat", "bootstrapmaxchars", "bootstraptotalmaxchars",
  "thinkingdefault", "verbosedefault", "timeoutseconds", "model",
]);
const FORBIDDEN_DOCTOR_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const OMIT_DOCTOR_VALUE = Symbol("omit-doctor-value");

function credentialKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[-_]/g, "");
  return CREDENTIAL_SEGMENTS.has(normalized) ||
    /(?:token|secret|password|passwd|credential|credentials|cookie|authorization|authheader|oauth|bearer|auth)$/.test(normalized) ||
    /(?:apikey|privatekey|accesskey|signingkey|encryptionkey|clientkey|webhookkey)$/.test(normalized);
}

function blockedDoctorKey(key: string, depth: number, remaining: number): boolean {
  const normalized = key.toLowerCase().replace(/-/g, "");
  return depth > 20 || remaining <= 0 || FORBIDDEN_DOCTOR_KEYS.has(normalized) ||
    credentialKey(key) || sensitiveInventoryKey(key) ||
    HOST_FIELDS.has(normalized) || PLATFORM_ROOTS.has(normalized);
}

function doctorArray(value: unknown[], depth: number, budget: { remaining: number }): unknown[] {
  return value.flatMap((entry) => {
    const sanitized = doctorValue(entry, "", depth + 1, budget);
    return sanitized === OMIT_DOCTOR_VALUE ? [] : [sanitized];
  });
}

function doctorObject(value: JsonObject, depth: number, budget: { remaining: number }): JsonObject {
  const result: JsonObject = {};
  for (const [childKey, entry] of Object.entries(value)) {
    const sanitized = doctorValue(entry, childKey, depth + 1, budget);
    if (sanitized !== OMIT_DOCTOR_VALUE) result[childKey] = sanitized;
  }
  return result;
}

function doctorValue(
  value: unknown,
  key: string,
  depth: number,
  budget: { remaining: number },
): unknown | typeof OMIT_DOCTOR_VALUE {
  if (blockedDoctorKey(key, depth, budget.remaining)) return OMIT_DOCTOR_VALUE;
  budget.remaining -= 1;
  if (Array.isArray(value)) return doctorArray(value, depth, budget);
  const source = record(value);
  if (source) return doctorObject(source, depth, budget);
  if (value === null || typeof value === "boolean" || typeof value === "string") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : OMIT_DOCTOR_VALUE;
  return OMIT_DOCTOR_VALUE;
}

function sourceAgentEntries(config: JsonObject): Array<{ agent: JsonObject; path: string }> {
  const agents = record(config.agents);
  if (agents?.entries !== undefined) {
    const entries = record(agents.entries);
    if (!entries || agents.list !== undefined) {
      throw new AgentImportConfigError("invalid_source_config", "agents.entries must be a keyed object without agents.list");
    }
    return Object.entries(entries).map(([id, value]) => {
      const entry = record(value);
      if (!entry || Object.prototype.hasOwnProperty.call(entry, "id")) {
        throw new AgentImportConfigError("invalid_source_config", "keyed agent entries must use their key as the agent id");
      }
      return { agent: { ...entry, id }, path: `agents.entries.${id}` };
    });
  }
  return Array.isArray(agents?.list) ? agents.list.flatMap((value, index) => {
    const agent = record(value);
    return agent ? [{ agent, path: `agents.list[${index}]` }] : [];
  }) : [];
}

export function listAgentImportSourceAgents(source: unknown): Array<{ id: string; name: string }> {
  const config = record(source);
  if (!config) throw new AgentImportConfigError("invalid_source_config", "openclaw.json must contain an object");
  return sourceAgentEntries(config).flatMap(({ agent }) => {
    const id = trimmedString(agent.id, 160);
    return id ? [{ id, name: trimmedString(agent.name, 80) ?? id }] : [];
  });
}

function doctorCandidate(config: JsonObject, agent: JsonObject): JsonObject {
  const defaults = record(record(config.agents)?.defaults);
  const budget = { remaining: 5_000 };
  const keyed = record(record(config.agents)?.entries) !== null;
  const { id, ...entry } = agent;
  const sanitizedAgent = doctorValue(keyed ? entry : agent, "", 0, budget);
  const sanitizedDefaults = defaults ? doctorValue(defaults, "", 0, budget) : undefined;
  const sourceOpenClawVersion = trimmedString(record(config.meta)?.lastTouchedVersion, 100);
  return compact({
    meta: sourceOpenClawVersion ? { lastTouchedVersion: sourceOpenClawVersion } : undefined,
    agents: compact({
      defaults: record(sanitizedDefaults) && Object.keys(sanitizedDefaults as JsonObject).length > 0
        ? sanitizedDefaults as JsonObject
        : undefined,
      ...(keyed
        ? { entries: { [String(id)]: sanitizedAgent as JsonObject } }
        : { list: [sanitizedAgent as JsonObject] }),
    }),
  });
}

function normalizedPathSegments(path: string): string[] {
  return path.split("[").join(".").split("]").join(".").split(".")
    .filter(Boolean)
    .map((part) => part.toLowerCase().replace(/-/g, ""));
}

function inventoryClassification(path: string, sourcePrefix: string): AgentImportInventoryClassification {
  const rawSegments = path.split("[").join(".").split("]").join(".").split(".").filter(Boolean);
  if (rawSegments.some(sensitiveInventoryKey)) return "credential";
  const segments = normalizedPathSegments(path);
  if (segments.some(credentialKey)) {
    return "credential";
  }
  if (segments.some((segment) => HOST_FIELDS.has(segment))) return "host";
  const root = segments[0] ?? "";
  if (PLATFORM_ROOTS.has(root)) return "platform";
  if (path.startsWith(`${sourcePrefix}.`)) {
    const relative = path.slice(sourcePrefix.length + 1).toLowerCase().replace(/[-_]/g, "");
    const root = relative.split(".", 1)[0].split("[", 1)[0];
    const portableLeaf =
      /^(?:id|name|persona|bootstrapmaxchars|bootstraptotalmaxchars|thinkingdefault|verbosedefault|timeoutseconds)$/u.test(relative) ||
      /^identity(?:\.(?:name|emoji))?$/u.test(relative) ||
      /^heartbeat(?:\.(?:every|lightcontext))?$/u.test(relative) ||
      /^heartbeat\.activehours(?:\.(?:start|end|timezone))?$/u.test(relative) ||
      /^model(?:\.primary|\.fallbacks(?:\[\d+\])?)?$/u.test(relative);
    return PORTABLE_AGENT_FIELDS.has(root) && portableLeaf ? "customer" : "unknown";
  }
  return "unknown";
}

function inventoryEntries(
  value: unknown,
  path: string,
  sourcePrefix: string,
  entries: AgentImportConfigInventoryEntry[],
  sourcePath = path,
): void {
  const object = record(value);
  if (object && Object.keys(object).length > 0) {
    for (const key of Object.keys(object).sort()) {
      const safeKey = sensitiveInventoryKey(key) ? "$key" : key;
      inventoryEntries(
        object[key],
        path ? `${path}.${safeKey}` : safeKey,
        sourcePrefix,
        entries,
        sourcePath ? `${sourcePath}.${key}` : key,
      );
    }
    return;
  }
  if (Array.isArray(value) && value.length > 0) {
    value.forEach((entry, index) => inventoryEntries(
      entry,
      `${path}[${index}]`,
      sourcePrefix,
      entries,
      `${sourcePath}[${index}]`,
    ));
    return;
  }
  entries.push({
    path,
    valueType: valueType(value),
    classification: inventoryClassification(sourcePath, sourcePrefix),
    sourceAgent: sourcePath === sourcePrefix || sourcePath.startsWith(`${sourcePrefix}.`) || sourcePath.startsWith(`${sourcePrefix}[`),
  });
}

export function buildAgentImportConfigArtifacts(
  source: unknown,
  selectedAgentId: string,
): AgentImportConfigArtifacts {
  const config = record(source);
  if (!config) throw new AgentImportConfigError("invalid_source_config", "openclaw.json must contain an object");
  const matches = sourceAgentEntries(config).filter(({ agent }) => agent.id === selectedAgentId);
  if (matches.length === 0) {
    throw new AgentImportConfigError("source_agent_not_found", `source agent ${selectedAgentId} was not found`);
  }
  if (matches.length !== 1) {
    throw new AgentImportConfigError("source_agent_ambiguous", `source agent ${selectedAgentId} is duplicated`);
  }
  const selected = matches[0];
  const portable = portableAgent(config, selected.agent);
  const inventory: AgentImportConfigInventoryEntry[] = [];
  inventoryEntries(config, "", selected.path, inventory);
  const boundedInventory = inventory.length <= 500
    ? inventory
    : [
      ...inventory.slice(0, 499),
      {
        path: `$inventory.truncated[${inventory.length - 499}]`,
        valueType: "number" as const,
        classification: "unknown" as const,
        sourceAgent: false,
      },
    ];
  return {
    formatVersion: AGENT_IMPORT_FORMAT_VERSION,
    portableAgent: portable,
    configInventory: boundedInventory,
    doctorCandidate: doctorCandidate(config, selected.agent),
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
    if (credentialKey(key) || normalized === "env" || sensitiveInventoryKey(key)) {
      throw new AgentImportConfigError("unsafe_config_artifact", "credential-bearing config path is forbidden");
    }
    assertNoCredentialKeys(entry);
  }
}

const KNOWN_SECRET_PATTERNS = [
  /\bsk-[\w-]{20,}/u,
  /\bgh[pousr]_[A-Za-z\d]{30,}/u,
  /\bgithub_pat_\w{20,}/u,
  /\bxox[baprs]-[\w-]{20,}/u,
  /\bAKIA[\dA-Z]{16}\b/u,
  /\bAIza[\w-]{30,}/u,
];

function knownSecretValue(value: string): boolean {
  return KNOWN_SECRET_PATTERNS.some((pattern) => pattern.test(value));
}

function tokenEntropy(value: string): number {
  const counts = new Map<string, number>();
  for (const character of value) counts.set(character, (counts.get(character) ?? 0) + 1);
  return [...counts.values()].reduce((entropy, count) => {
    const probability = count / value.length;
    return entropy - probability * Math.log2(probability);
  }, 0);
}

function highEntropyCredential(value: string): boolean {
  const candidates: string[] = [];
  let start = -1;
  for (let index = 0; index <= value.length; index += 1) {
    const character = value[index] ?? "";
    const allowed = /[\w+/=-]/u.test(character);
    if (allowed && start < 0) start = index;
    if (!allowed && start >= 0) {
      if (index - start >= 40) candidates.push(value.slice(start, index));
      start = -1;
    }
  }
  return candidates.some((candidate) =>
    /[a-z]/u.test(candidate) && /[A-Z]/u.test(candidate) && /\d/u.test(candidate) && tokenEntropy(candidate) >= 4.5
  );
}

function looksLikeEmail(value: string): boolean {
  if ([...value].some((character) => character.trim() === "")) return false;
  const at = value.indexOf("@");
  const dot = value.lastIndexOf(".");
  return at > 0 && at === value.lastIndexOf("@") && dot > at + 1 && dot < value.length - 1;
}

function sensitiveInventoryKey(value: string): boolean {
  return knownSecretValue(value) || highEntropyCredential(value) || looksLikeEmail(value);
}

function sensitiveInventoryPath(value: string): boolean {
  return value.includes("@") || sensitiveInventoryKey(value) ||
    value.split("[").join(".").split("]").join(".").split(".").filter(Boolean).some(sensitiveInventoryKey);
}

function assertNoCredentialValues(value: unknown): void {
  if (typeof value === "string" && (knownSecretValue(value) || highEntropyCredential(value))) {
    throw new AgentImportConfigError("unsafe_config_artifact", "credential-like config value is forbidden");
  }
  if (Array.isArray(value)) {
    value.forEach(assertNoCredentialValues);
    return;
  }
  const object = record(value);
  if (object) Object.values(object).forEach(assertNoCredentialValues);
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
  if (!Array.isArray(value) || value.length > 500) {
    throw new AgentImportConfigError("invalid_config_artifact", "configInventory must be a bounded array");
  }
  return value.map((raw) => {
    const entry = record(raw);
    if (!entry) throw new AgentImportConfigError("invalid_config_artifact", "inventory entry must be an object");
    exactKeys(entry, ["path", "valueType", "classification", "sourceAgent"]);
    if (
      typeof entry.path !== "string" || entry.path.length > 512 ||
      !["array", "boolean", "null", "number", "object", "string"].includes(String(entry.valueType)) ||
      !["credential", "host", "customer", "platform", "unknown"].includes(String(entry.classification)) ||
      typeof entry.sourceAgent !== "boolean"
    ) {
      throw new AgentImportConfigError("invalid_config_artifact", "inventory entry is invalid");
    }
    if (sensitiveInventoryPath(entry.path)) {
      throw new AgentImportConfigError("unsafe_config_artifact", "inventory path contains credential-like data");
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
  assertNoCredentialValues(artifacts.portableAgent);
  assertNoCredentialValues(artifacts.doctorCandidate);
  const portable = validatePortable(artifacts.portableAgent);
  const inventory = validateInventory(artifacts.configInventory);
  const candidate = record(artifacts.doctorCandidate);
  const candidateAgents = candidate ? sourceAgentEntries(candidate) : [];
  const candidateAgent = candidateAgents.length === 1 ? candidateAgents[0].agent : null;
  if (!candidate || !candidateAgent || candidateAgent.id !== portable.sourceAgentId) {
    throw new AgentImportConfigError("invalid_config_artifact", "doctorCandidate must contain only the selected agent");
  }
  const expectedCandidate = doctorCandidate(candidate, candidateAgent);
  if (stableJson(expectedCandidate) !== stableJson(artifacts.doctorCandidate)) {
    throw new AgentImportConfigError("unsafe_config_artifact", "doctorCandidate contains a forbidden or non-canonical field");
  }
  const candidatePortable = portableAgent(candidate, candidateAgent);
  if (stableJson(candidatePortable) !== stableJson(portable)) {
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

function plannedRuntime(
  portable: AgentImportPortableAgent,
  doctorSafe: boolean,
  sourceHeartbeat: AgentImportPortableAgent["heartbeat"],
): {
  runtimePatch: JsonObject;
  decisions: AgentImportConfigDecision[];
} {
  const runtimePatch: JsonObject = {};
  const decisions: AgentImportConfigDecision[] = [];
  for (const [path, value] of runtimeEntries(portable)) {
    const paths = runtimeDecisionPaths(path, value);
    const disposition: AgentImportConfigDisposition = doctorSafe ? "apply" : "manual_review";
    const reason = doctorSafe
      ? "validated by current OpenClaw doctor"
      : "current OpenClaw could not validate the source config";
    if (doctorSafe) runtimePatch[path] = structuredClone(value);
    decisions.push(...paths.map((decisionPath) => ({ path: decisionPath, disposition, reason })));
  }
  if (sourceHeartbeat) {
    decisions.push(...runtimeDecisionPaths("heartbeat", sourceHeartbeat).map((path) => ({
      path,
      disposition: "manual_review" as const,
      reason: "Legacy heartbeat settings belong to native Doctor and ordinary Automations; this workspace import does not transfer schedules. Recreate the schedule through the Octogee agent.",
    })));
  }
  return { runtimePatch, decisions };
}

function modelDecisions(portable: AgentImportPortableAgent): AgentImportConfigDecision[] {
  const decisions: AgentImportConfigDecision[] = [];
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
  return decisions;
}

function droppedConfigReason(classification: AgentImportConfigInventoryEntry["classification"]): string {
  if (classification === "credential") return "credentials are never imported";
  if (classification === "unknown") return "field is not in the portable allowlist";
  return "field is owned by the source host or Octogee platform";
}

function appendDroppedConfigDecisions(
  decisions: AgentImportConfigDecision[],
  inventory: AgentImportConfigInventoryEntry[],
): void {
  const seen = new Set(decisions.map((entry) => entry.path));
  for (const entry of inventory) {
    if (entry.classification === "customer" || seen.has(entry.path)) continue;
    decisions.push({
      path: entry.path,
      disposition: entry.classification === "unknown" ? "drop_unsupported" : "drop_platform",
      reason: droppedConfigReason(entry.classification),
    });
    seen.add(entry.path);
  }
}

function reauthenticationRequirements(
  portable: AgentImportPortableAgent,
  inventory: AgentImportConfigInventoryEntry[],
): string[] {
  const requirements = [
    ...(portable.requestedModel?.primary ? ["models"] : []),
    ...(inventory.some((entry) => entry.path.startsWith("channels.")) ? ["channels"] : []),
    ...(inventory.some((entry) => entry.path.toLowerCase().includes("github")) ? ["github"] : []),
  ];
  return [...new Set(requirements)];
}

export function planAgentImportConfig(
  input: AgentImportConfigArtifacts,
  options: {
    doctorOutcome: AgentImportDoctorOutcome;
    sourceHeartbeat?: AgentImportPortableAgent["heartbeat"];
    workspacePolicy: AgentImportWorkspacePolicy;
  },
): AgentImportConfigPlan {
  const artifacts = validateAgentImportConfigArtifacts(input);
  const portable = artifacts.portableAgent;
  const doctorSafe = options.doctorOutcome === "migrated" || options.doctorOutcome === "unchanged";
  const identity = compact({
    name: portable.name ?? portable.identity?.name,
    persona: portable.persona,
    emoji: portable.identity?.emoji,
  });
  const sourceHeartbeat = options.sourceHeartbeat ?? portable.heartbeat;
  const planned = plannedRuntime(portable, doctorSafe, sourceHeartbeat);
  planned.decisions.push({
    path: "skipBootstrap",
    disposition: "apply",
    reason: options.workspacePolicy.preserveConvergedContextFiles
      ? "OpenClaw converges house-only context files"
      : "Builder-owned context files must not be recreated after import",
  });
  const decisions: AgentImportConfigDecision[] = Object.keys(identity).map((path) => ({
    path: `identity.${path}`,
    disposition: "apply",
    reason: "portable identity field",
  }));
  decisions.push(...planned.decisions, ...modelDecisions(portable));
  appendDroppedConfigDecisions(decisions, artifacts.configInventory);
  return {
    analyzer: "octogee-policy-v1",
    doctorOutcome: options.doctorOutcome,
    effectiveOutcome: agentImportConfigOutcome(portable, planned.runtimePatch, Boolean(sourceHeartbeat)),
    identity,
    workspaceRuntimePatch: {
      skipBootstrap: !options.workspacePolicy.preserveConvergedContextFiles,
    },
    runtimePatch: planned.runtimePatch,
    decisions,
    reauth: reauthenticationRequirements(portable, artifacts.configInventory),
  };
}

function agentImportConfigOutcome(
  portable: AgentImportPortableAgent,
  runtimePatch: JsonObject,
  hasLegacyHeartbeat: boolean,
): AgentImportConfigPlan["effectiveOutcome"] {
  if (Object.keys(runtimePatch).length > 0) return "applied";
  return !hasLegacyHeartbeat && runtimeEntries(portable).length === 0 ? "unchanged" : "safe_baseline";
}

const ARCHIVE_METADATA = new Set([
  "manifest.json", "portable-agent.json", "config-inventory.json", "doctor-candidate.json",
]);
const BLOCKED_WORKSPACE_SEGMENTS = new Set([
  ".git", ".ssh", ".openclaw", ".aws", ".azure", ".kube", ".docker",
]);
const SENSITIVE_WORKSPACE_DIRECTORY = /^(?:credentials?|secrets?|sessions?|auth[-_]?profiles?)$/;
const OPENCLAW_CONFIG_BACKUP = /^openclaw\.json(?:[._-].+|~)$/;
const RUNTIME_WORKSPACE_FILES = new Set(["openclaw-workspace-state.json"]);

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
  if (segments[0] === "workspace") return classifyWorkspaceArchivePath(segments.slice(1));
  return segments[0] === "git" ? classifyGitArchivePath(segments.slice(1).join("/")) : null;
}

function classifyWorkspaceArchivePath(relative: string[]): "workspace" | null {
  if (relative.length === 0) return null;
  const lowered = relative.map((segment) => segment.toLowerCase());
  if (lowered.some((segment) => BLOCKED_WORKSPACE_SEGMENTS.has(segment))) return null;
  if (lowered.some((segment) => SENSITIVE_WORKSPACE_DIRECTORY.test(segment))) return null;
  if (lowered.some((segment) => segment === ".env" || segment.startsWith(".env."))) return null;
  const leaf = lowered[lowered.length - 1]!;
  if (
    leaf === "openclaw.json" || OPENCLAW_CONFIG_BACKUP.test(leaf) ||
    [".npmrc", ".pypirc", ".netrc", ".git-credentials", "application_default_credentials.json"].includes(leaf) ||
    lowered.some((segment, index) => segment === ".config" && lowered[index + 1] === "gcloud")
  ) return null;
  if (relative.length === 1 && RUNTIME_WORKSPACE_FILES.has(leaf)) return null;
  if (relative.length === 1 && /^(credentials?|secrets?)([._-].*)?$/.test(leaf)) return null;
  if (/(^|[._-])(id_rsa|id_ed25519|private[-_.]?key)([._-]|$)/.test(leaf)) return null;
  return "workspace";
}

function classifyGitArchivePath(relative: string): "git" | null {
  if (["HEAD", "packed-refs"].includes(relative)) return "git";
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
