import {
  platformInvariantViolations,
  type SystemConfigInvariantContext,
} from "@octogee/core/system-config-invariants";
import JSON5 from "json5";
import type { OpenClawBrokerProfile } from "@octogee/core/gateway-principal-access";
import advertisedMethods from "./openclaw-2026.7.1-advertised-methods.json" with { type: "json" };
import delegatedInventory from "./openclaw-2026.7.1-delegated-dashboard-inventory.json" with { type: "json" };

export const OPENCLAW_CONTROL_PINNED_ADVERTISED_METHODS = Object.freeze(
  advertisedMethods as readonly string[],
);

export type OpenClawControlRpcCategory =
  | "read"
  | "config_mutation"
  | "tools_invoke"
  | "forbidden_mutation"
  | "unknown";

export interface OpenClawConfigSnapshot {
  raw: Record<string, unknown>;
  hash: string;
}

export interface OpenClawControlRpcDecision {
  allowed: boolean;
  category: OpenClawControlRpcCategory;
  reason?:
    | "invalid-frame"
    | "runtime-drift"
    | "method-unavailable"
    | "config-frozen"
    | "config-base-mismatch"
    | "config-invalid"
    | "config-unsafe-path"
    | "redacted-array-structural-edit"
    | "platform-invariant"
    | "tool-denied"
    | "tool-schema-invalid";
  outbound?: Record<string, unknown>;
  proposedConfig?: Record<string, unknown>;
}

export interface OpenClawControlRpcPolicyContext {
  installedMethods: ReadonlySet<string>;
  invariantContext: SystemConfigInvariantContext;
  currentConfig?: OpenClawConfigSnapshot;
  configFrozen?: boolean;
}

const READ_METHODS = new Set([
  "health",
  "status",
  "system.info",
  "gateway.identity.get",
  "config.get",
  "config.schema",
  "config.schema.lookup",
  "models.list",
  "agents.list",
  "channels.status",
  "tools.catalog",
  "tools.effective",
  "skills.status",
]);

const CONFIG_MUTATION_METHODS = new Set(["config.set", "config.apply", "config.patch"]);
const DELEGATED_READ_METHODS = new Set(delegatedInventory.delegatedReadMethods);
const BLOCKED_OBJECT_KEYS = new Set(["__proto__", "prototype", "constructor"]);
const REDACTED_SENTINEL = "__OPENCLAW_REDACTED__";
const ARRAY_IDENTITY_KEYS = ["id", "agentId", "accountId", "key"] as const;
const METHOD_UNAVAILABLE = "method-unavailable" as const;
const DELEGATED_MUTABLE_PATHS = new Set([
  "agents.defaults.maxConcurrent",
  "agents.defaults.model",
  "agents.defaults.model.primary",
  "agents.defaults.model.fallbacks[]",
  "agents.defaults.thinkingDefault",
  "agents.defaults.timeoutSeconds",
  "agents.list[].model",
  "agents.list[].model.primary",
  "agents.list[].model.fallbacks[]",
  "agents.list[].name",
]);
const SCHEMA_METADATA_FIELDS = [
  "type", "title", "description", "format", "minimum", "maximum",
  "minLength", "maxLength", "minItems", "maxItems", "readOnly",
] as const;

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function parsedRaw(raw: unknown): Record<string, unknown> | null {
  if (typeof raw !== "string" || raw.length > 1_048_576) return null;
  try {
    return record(JSON5.parse(raw));
  } catch {
    return null;
  }
}

function exactKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
  return Object.keys(value).every((key) => allowed.has(key) && !BLOCKED_OBJECT_KEYS.has(key));
}

function boundedString(value: unknown, max = 4_096): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= max;
}

function optionalInteger(value: unknown, min: number, max: number): boolean {
  return value === undefined || Number.isInteger(value) && (value as number) >= min && (value as number) <= max;
}

function optionalNumber(value: unknown, min: number, max: number): boolean {
  return value === undefined || typeof value === "number" && Number.isFinite(value) && value >= min && value <= max;
}

function validateMemorySearch(args: Record<string, unknown>): boolean {
  return exactKeys(args, new Set(["query", "maxResults", "minScore", "corpus"])) &&
    boundedString(args.query) &&
    optionalInteger(args.maxResults, 1, 20) &&
    optionalNumber(args.minScore, 0, 1) &&
    (args.corpus === undefined || ["memory", "wiki", "all", "sessions"].includes(String(args.corpus)));
}

function validateSessionStatus(args: Record<string, unknown>): boolean {
  return exactKeys(args, new Set(["sessionKey", "changesSince"])) &&
    (args.sessionKey === undefined || boundedString(args.sessionKey, 256)) &&
    optionalNumber(args.changesSince, 0, Number.MAX_SAFE_INTEGER);
}

function validateWebSearch(args: Record<string, unknown>): boolean {
  const allowed = new Set([
    "query", "count", "country", "language", "freshness", "date_after", "date_before",
    "search_lang", "ui_lang", "max_tokens", "max_tokens_per_page",
  ]);
  const strings = ["country", "language", "date_after", "date_before", "search_lang", "ui_lang"];
  return exactKeys(args, allowed) &&
    boundedString(args.query) &&
    optionalInteger(args.count, 1, 10) &&
    (args.freshness === undefined || ["day", "week", "month", "year"].includes(String(args.freshness))) &&
    strings.every((key) => args[key] === undefined || boundedString(args[key], 64)) &&
    optionalInteger(args.max_tokens, 1, 16_000) &&
    optionalInteger(args.max_tokens_per_page, 1, 8_000);
}

function safeToolDecision(request: Record<string, unknown>): OpenClawControlRpcDecision {
  const params = record(request.params);
  if (!params || !exactKeys(params, new Set(["name", "args"])) || typeof params.name !== "string") {
    return { allowed: false, category: "tools_invoke", reason: "tool-schema-invalid" };
  }
  const args = record(params.args);
  if (!args) return { allowed: false, category: "tools_invoke", reason: "tool-schema-invalid" };
  const validators: Record<string, (input: Record<string, unknown>) => boolean> = {
    memory_search: validateMemorySearch,
    session_status: validateSessionStatus,
    web_search: validateWebSearch,
  };
  const validate = validators[params.name];
  if (!validate) return { allowed: false, category: "tools_invoke", reason: "tool-denied" };
  return validate(args)
    ? { allowed: true, category: "tools_invoke", outbound: structuredClone(request) }
    : { allowed: false, category: "tools_invoke", reason: "tool-schema-invalid" };
}

function normalizedReplacePaths(value: unknown): Set<string> | null {
  if (value === undefined) return new Set();
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || !entry.trim())) return null;
  return new Set(value.map((entry) => (entry as string).trim().replace(/\[\d+\](?=\.)/gu, "[]")));
}

function stringIdRecord(value: unknown): value is Record<string, unknown> & { id: string } {
  const item = record(value);
  return item !== null && boundedString(item.id, 256);
}

function containsRedactedSentinel(value: unknown): boolean {
  if (value === REDACTED_SENTINEL) return true;
  if (Array.isArray(value)) return value.some(containsRedactedSentinel);
  const item = record(value);
  return item ? Object.values(item).some(containsRedactedSentinel) : false;
}

function structurallyEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right) && left.length === right.length &&
      left.every((value, index) => structurallyEqual(value, right[index]));
  }
  const leftRecord = record(left);
  const rightRecord = record(right);
  if (!leftRecord || !rightRecord) return false;
  const leftKeys = Object.keys(leftRecord).sort();
  const rightKeys = Object.keys(rightRecord).sort();
  return leftKeys.length === rightKeys.length &&
    leftKeys.every((key, index) => key === rightKeys[index] &&
      structurallyEqual(leftRecord[key], rightRecord[key]));
}

function collectChangedConfigPaths(
  current: unknown,
  proposed: unknown,
  path: string,
  changed: Set<string>,
): void {
  if (structurallyEqual(current, proposed)) return;
  if (Array.isArray(current) || Array.isArray(proposed)) {
    const currentItems = Array.isArray(current) ? current : [];
    const proposedItems = Array.isArray(proposed) ? proposed : [];
    const itemPath = `${path}[]`;
    const length = Math.max(currentItems.length, proposedItems.length);
    for (let index = 0; index < length; index++) {
      collectChangedConfigPaths(currentItems[index], proposedItems[index], itemPath, changed);
    }
    return;
  }
  const currentRecord = record(current);
  const proposedRecord = record(proposed);
  if (currentRecord || proposedRecord) {
    const keys = new Set([
      ...Object.keys(currentRecord ?? {}),
      ...Object.keys(proposedRecord ?? {}),
    ]);
    for (const key of keys) {
      const childPath = path ? `${path}.${key}` : key;
      collectChangedConfigPaths(currentRecord?.[key], proposedRecord?.[key], childPath, changed);
    }
    return;
  }
  changed.add(path);
}

function delegatedMutationUsesSafePaths(
  current: Record<string, unknown>,
  proposed: Record<string, unknown>,
): boolean {
  const changed = new Set<string>();
  collectChangedConfigPaths(current, proposed, "", changed);
  return [...changed].every((path) => DELEGATED_MUTABLE_PATHS.has(path));
}

function normalizedConfigPath(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 && value.length <= 512
    ? value.replace(/\[\d+\]/gu, "[]")
    : null;
}

function delegatedConfigPathIsSafe(path: string): boolean {
  return DELEGATED_MUTABLE_PATHS.has(path) || [...DELEGATED_MUTABLE_PATHS].some(
    (candidate) => candidate.startsWith(`${path}.`) || candidate.startsWith(`${path}[]`),
  );
}

function delegatedSchemaLookupIsSafe(request: Record<string, unknown>): boolean {
  const params = record(request.params);
  if (!params || !exactKeys(params, new Set(["path"]))) return false;
  const path = normalizedConfigPath(params.path);
  return path !== null && delegatedConfigPathIsSafe(path);
}

function arrayItemIdentityPreserved(current: unknown, proposed: unknown): boolean {
  const currentItem = record(current);
  const proposedItem = record(proposed);
  if (!currentItem || !proposedItem) return structurallyEqual(current, proposed);
  for (const key of ARRAY_IDENTITY_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(currentItem, key)) continue;
    const value = currentItem[key];
    if ((typeof value !== "string" && typeof value !== "number") || value === REDACTED_SENTINEL) {
      return structurallyEqual(current, proposed);
    }
    return Object.is(value, proposedItem[key]);
  }
  return structurallyEqual(current, proposed);
}

function redactedArrayStructurePreserved(current: unknown, proposed: unknown): boolean {
  if (Array.isArray(current)) {
    if (!Array.isArray(proposed)) return !containsRedactedSentinel(current);
    if (containsRedactedSentinel(current) &&
      (current.length !== proposed.length ||
        current.some((entry, index) => !arrayItemIdentityPreserved(entry, proposed[index])))) {
      return false;
    }
    return current.every((entry, index) =>
      redactedArrayStructurePreserved(entry, proposed[index]));
  }
  const currentItem = record(current);
  if (!currentItem) return true;
  const proposedItem = record(proposed);
  return Object.entries(currentItem).every(([key, value]) =>
    redactedArrayStructurePreserved(value, proposedItem?.[key]));
}

function mergeIdentifiedArray(
  base: unknown[],
  patch: unknown[],
  replacePaths: ReadonlySet<string>,
  itemPath: string,
): unknown[] {
  const merged: unknown[] = structuredClone(base);
  const indexes = new Map(merged.filter(stringIdRecord).map((entry, index) => [entry.id, index]));
  for (const patchEntry of patch) {
    if (!stringIdRecord(patchEntry) || !indexes.has(patchEntry.id)) {
      merged.push(structuredClone(patchEntry));
      if (stringIdRecord(patchEntry)) indexes.set(patchEntry.id, merged.length - 1);
      continue;
    }
    const index = indexes.get(patchEntry.id)!;
    merged[index] = mergePatch(record(merged[index]) ?? {}, patchEntry, replacePaths, `${itemPath}[]`);
  }
  return merged;
}

function mergePatchValue(
  current: unknown,
  value: unknown,
  replacePaths: ReadonlySet<string>,
  itemPath: string,
): unknown {
  if (Array.isArray(current) && Array.isArray(value)) {
    return replacePaths.has(itemPath) || !current.every(stringIdRecord)
      ? structuredClone(value)
      : mergeIdentifiedArray(current, value, replacePaths, itemPath);
  }
  const nested = record(value);
  return nested
    ? mergePatch(record(current) ?? {}, nested, replacePaths, itemPath)
    : structuredClone(value);
}

function mergePatch(
  current: Record<string, unknown>,
  patch: Record<string, unknown>,
  replacePaths: ReadonlySet<string>,
  parentPath = "",
): Record<string, unknown> {
  const candidate = structuredClone(current);
  for (const [key, value] of Object.entries(patch)) {
    if (BLOCKED_OBJECT_KEYS.has(key)) continue;
    const itemPath = parentPath ? `${parentPath}.${key}` : key;
    if (value === null) {
      delete candidate[key];
      continue;
    }
    candidate[key] = mergePatchValue(candidate[key], value, replacePaths, itemPath);
  }
  return candidate;
}

function allowedMutationParams(method: unknown): ReadonlySet<string> {
  if (method === "config.set") return new Set(["raw", "baseHash"]);
  if (method === "config.apply") return new Set(["raw", "baseHash", "sessionKey"]);
  return new Set(["raw", "baseHash", "sessionKey", "note", "replacePaths"]);
}

function validMutationParams(params: Record<string, unknown>, method: unknown): boolean {
  return exactKeys(params, allowedMutationParams(method)) &&
    (params.sessionKey === undefined ||
      typeof params.sessionKey === "string" && params.sessionKey.length <= 512) &&
    (params.note === undefined || typeof params.note === "string" && params.note.length <= 512);
}

function proposedMutationConfig(
  method: unknown,
  current: Record<string, unknown>,
  raw: Record<string, unknown>,
  replacePaths: ReadonlySet<string>,
): Record<string, unknown> {
  return method === "config.patch"
    ? mergePatch(current, raw, replacePaths)
    : structuredClone(raw);
}

function configMutationDecision(
  request: Record<string, unknown>,
  context: OpenClawControlRpcPolicyContext,
): OpenClawControlRpcDecision {
  if (context.configFrozen) {
    return { allowed: false, category: "config_mutation", reason: "config-frozen" };
  }
  const params = record(request.params);
  const current = context.currentConfig;
  if (!params || !current || params.baseHash !== current.hash) {
    return { allowed: false, category: "config_mutation", reason: "config-base-mismatch" };
  }
  if (!validMutationParams(params, request.method)) {
    return { allowed: false, category: "config_mutation", reason: "config-invalid" };
  }
  const replacePaths = normalizedReplacePaths(params.replacePaths);
  const parsed = parsedRaw(params.raw);
  if (!replacePaths || !parsed) {
    return { allowed: false, category: "config_mutation", reason: "config-invalid" };
  }
  const raw = parsed;
  const proposed = proposedMutationConfig(request.method, current.raw, raw, replacePaths);
  if (!redactedArrayStructurePreserved(current.raw, proposed)) {
    return {
      allowed: false,
      category: "config_mutation",
      reason: "redacted-array-structural-edit",
    };
  }
  if (platformInvariantViolations(proposed, context.invariantContext).length > 0) {
    return { allowed: false, category: "config_mutation", reason: "platform-invariant" };
  }
  return {
    allowed: true,
    category: "config_mutation",
    proposedConfig: proposed,
    outbound: {
      ...structuredClone(request),
      params: { ...structuredClone(params), raw: JSON.stringify(raw) },
    },
  };
}

export function pinnedOpenClawRuntimeMatches(installedMethods: ReadonlySet<string>): boolean {
  if (installedMethods.size !== OPENCLAW_CONTROL_PINNED_ADVERTISED_METHODS.length) return false;
  return OPENCLAW_CONTROL_PINNED_ADVERTISED_METHODS.every((method) => installedMethods.has(method));
}

export function evaluateOpenClawControlRpc(
  frame: unknown,
  context: OpenClawControlRpcPolicyContext,
): OpenClawControlRpcDecision {
  const request = record(frame);
  if (!request || request.type !== "req" || !boundedString(request.id, 256) ||
    !boundedString(request.method, 256) || !record(request.params)) {
    return { allowed: false, category: "unknown", reason: "invalid-frame" };
  }
  if (!pinnedOpenClawRuntimeMatches(context.installedMethods)) {
    return { allowed: false, category: "unknown", reason: "runtime-drift" };
  }
  const method = request.method as string;
  if (!context.installedMethods.has(method)) {
    return { allowed: false, category: "forbidden_mutation", reason: METHOD_UNAVAILABLE };
  }
  if (READ_METHODS.has(method)) {
    return { allowed: true, category: "read", outbound: structuredClone(request) };
  }
  if (CONFIG_MUTATION_METHODS.has(method)) return configMutationDecision(request, context);
  if (method === "tools.invoke") return safeToolDecision(request);
  return { allowed: false, category: "forbidden_mutation", reason: METHOD_UNAVAILABLE };
}

export function evaluateDelegatedOpenClawControlRpc(
  frame: unknown,
  context: OpenClawControlRpcPolicyContext,
  profile: "delegated-read" | "delegated-config",
): OpenClawControlRpcDecision {
  const decision = evaluateOpenClawControlRpc(frame, context);
  if (!decision.allowed) return decision;
  const request = record(frame);
  const method = typeof request?.method === "string" ? request.method : "";
  if (method === "config.schema.lookup" && request && !delegatedSchemaLookupIsSafe(request)) {
    return { allowed: false, category: "read", reason: METHOD_UNAVAILABLE };
  }
  if (decision.category === "read" && DELEGATED_READ_METHODS.has(method)) return decision;
  if (profile === "delegated-config" && decision.category === "config_mutation") {
    const proposed = decision.proposedConfig;
    const current = context.currentConfig?.raw;
    return proposed && current && delegatedMutationUsesSafePaths(current, proposed)
      ? decision
      : { allowed: false, category: decision.category, reason: "config-unsafe-path" };
  }
  return { allowed: false, category: decision.category, reason: METHOD_UNAVAILABLE };
}

export function projectOpenClawHelloForProfile(
  frame: Record<string, unknown>,
  profile: OpenClawBrokerProfile,
): Record<string, unknown> {
  if (profile === "native-owner" || profile === "native-co-owner") {
    return structuredClone(frame);
  }
  const projected = structuredClone(frame);
  const payload = record(projected.payload);
  const features = record(payload?.features);
  if (payload?.type !== "hello-ok" || !Array.isArray(features?.methods)) return projected;
  const allowed = profile === "delegated-config"
    ? new Set([...DELEGATED_READ_METHODS, ...CONFIG_MUTATION_METHODS])
    : DELEGATED_READ_METHODS;
  features.methods = features.methods.filter(
    (method): method is string => typeof method === "string" && allowed.has(method),
  );
  features.octogeeAccess = {
    profile,
    canConfigure: profile === "delegated-config",
    canUseShell: false,
  };
  return projected;
}

function safeModelSelection(value: unknown): unknown {
  if (boundedString(value, 256) && value !== REDACTED_SENTINEL) return value;
  const item = record(value);
  if (!item) return undefined;
  const primary = boundedString(item.primary, 256) && item.primary !== REDACTED_SENTINEL
    ? item.primary
    : undefined;
  const fallbacks = Array.isArray(item.fallbacks)
    ? item.fallbacks.filter((entry) => boundedString(entry, 256) && entry !== REDACTED_SENTINEL)
    : undefined;
  return {
    ...(primary ? { primary } : {}),
    ...(fallbacks ? { fallbacks } : {}),
  };
}

function safeAgentDefaults(value: unknown): Record<string, unknown> | null {
  const item = record(value);
  if (!item) return null;
  const model = safeModelSelection(item.model);
  return {
    ...(model ? { model } : {}),
    ...(typeof item.timeoutSeconds === "number" ? { timeoutSeconds: item.timeoutSeconds } : {}),
    ...(typeof item.maxConcurrent === "number" ? { maxConcurrent: item.maxConcurrent } : {}),
    ...(boundedString(item.thinkingDefault, 128)
      ? { thinkingDefault: item.thinkingDefault }
      : {}),
  };
}

function safeAgent(value: unknown): Record<string, unknown> | null {
  const item = record(value);
  if (!item || !boundedString(item.id, 256) || item.id === REDACTED_SENTINEL) return null;
  const model = safeModelSelection(item.model);
  return {
    id: item.id,
    ...(boundedString(item.name, 256) && item.name !== REDACTED_SENTINEL
      ? { name: item.name }
      : {}),
    ...(typeof item.default === "boolean" ? { default: item.default } : {}),
    ...(model ? { model } : {}),
  };
}

function safeDelegatedConfig(value: unknown): Record<string, unknown> {
  const config = record(value);
  const agents = record(config?.agents);
  if (!agents) return {};
  const defaults = safeAgentDefaults(agents.defaults);
  const list = Array.isArray(agents.list)
    ? agents.list.map(safeAgent).filter((agent): agent is Record<string, unknown> => agent !== null)
    : undefined;
  return {
    agents: {
      ...(defaults ? { defaults } : {}),
      ...(list ? { list } : {}),
    },
  };
}

function projectDelegatedConfigGet(frame: Record<string, unknown>): Record<string, unknown> {
  const projected = {
    type: frame.type,
    id: frame.id,
    ok: frame.ok,
  } as Record<string, unknown>;
  const payload = record(frame.payload);
  const raw = parsedRaw(payload?.raw);
  if (frame.ok === true && payload && raw && boundedString(payload.hash, 512)) {
    projected.payload = {
      hash: payload.hash,
      raw: JSON.stringify(safeDelegatedConfig(raw)),
    };
  } else if (frame.ok !== true) {
    projected.error = { code: "REQUEST_FAILED", message: "OpenClaw request failed" };
  }
  return projected;
}

function displayFields(
  value: unknown,
  fields: readonly string[],
): Record<string, unknown> | null {
  const item = record(value);
  if (!item) return null;
  const projected: Record<string, unknown> = {};
  for (const field of fields) {
    const candidate = item[field];
    if (typeof candidate === "string" && candidate !== REDACTED_SENTINEL ||
      typeof candidate === "number" && Number.isFinite(candidate) ||
      typeof candidate === "boolean") {
      projected[field] = candidate;
    } else if (Array.isArray(candidate) && candidate.every((entry) =>
      typeof entry === "string" && entry !== REDACTED_SENTINEL)) {
      projected[field] = structuredClone(candidate);
    }
  }
  return projected;
}

function projectedListPayload(
  payload: unknown,
  key: string,
  fields: readonly string[],
): Record<string, unknown> {
  const items = record(payload)?.[key];
  return {
    [key]: Array.isArray(items)
      ? items.map((item) => displayFields(item, fields)).filter((item) => item !== null)
      : [],
  };
}

function schemaMetadata(value: Record<string, unknown>): Record<string, unknown> {
  const projected: Record<string, unknown> = {};
  for (const field of SCHEMA_METADATA_FIELDS) {
    const candidate = value[field];
    if (typeof candidate === "string" && candidate !== REDACTED_SENTINEL ||
      typeof candidate === "number" && Number.isFinite(candidate) ||
      typeof candidate === "boolean") {
      projected[field] = candidate;
    }
  }
  if (Array.isArray(value.enum) && value.enum.every((entry) =>
    typeof entry === "string" && entry !== REDACTED_SENTINEL ||
    typeof entry === "number" && Number.isFinite(entry) ||
    typeof entry === "boolean" || entry === null)) {
    projected.enum = structuredClone(value.enum);
  }
  return projected;
}

function delegatedSchemaProperties(value: unknown, path: string): Record<string, unknown> {
  const properties = record(value);
  if (!properties) return {};
  const safeProperties: Record<string, unknown> = {};
  for (const [name, child] of Object.entries(properties)) {
    if (BLOCKED_OBJECT_KEYS.has(name)) continue;
    const childPath = path ? `${path}.${name}` : name;
    if (!delegatedConfigPathIsSafe(childPath)) continue;
    const projectedChild = delegatedSchemaNode(child, childPath);
    if (projectedChild) safeProperties[name] = projectedChild;
  }
  return safeProperties;
}

function delegatedSchemaItems(value: unknown, path: string): Record<string, unknown> | null {
  const itemsPath = `${path}[]`;
  return value !== undefined && delegatedConfigPathIsSafe(itemsPath)
    ? delegatedSchemaNode(value, itemsPath)
    : null;
}

function delegatedRequiredFields(
  value: unknown,
  properties: Record<string, unknown>,
): string[] {
  return Array.isArray(value)
    ? value.filter((name): name is string =>
      typeof name === "string" && Object.prototype.hasOwnProperty.call(properties, name))
    : [];
}

function delegatedSchemaNode(value: unknown, path = ""): Record<string, unknown> | null {
  const node = record(value);
  if (!node) return null;
  const projected = schemaMetadata(node);
  const properties = delegatedSchemaProperties(node.properties, path);
  if (Object.keys(properties).length > 0) projected.properties = properties;
  const items = delegatedSchemaItems(node.items, path);
  if (items) projected.items = items;
  const required = delegatedRequiredFields(node.required, properties);
  if (required.length > 0) projected.required = required;
  return projected;
}

function delegatedSchemaPayload(payload: unknown): Record<string, unknown> {
  const source = record(payload);
  if (!source) return {};
  const schema = delegatedSchemaNode(source.schema ?? source);
  if (!schema) return {};
  return source.schema === undefined ? schema : { schema };
}

function delegatedReadPayload(method: string, payload: unknown): Record<string, unknown> {
  if (method === "config.schema" || method === "config.schema.lookup") {
    return delegatedSchemaPayload(payload);
  }
  if (method === "models.list") {
    return projectedListPayload(payload, "models", [
      "id", "name", "displayName", "provider", "family", "description",
      "contextWindow", "maxTokens", "reasoning", "input", "output", "available", "status",
    ]);
  }
  if (method === "agents.list") {
    return projectedListPayload(payload, "agents", [
      "id", "name", "displayName", "model", "default", "status", "enabled",
    ]);
  }
  if (method === "channels.status") {
    return projectedListPayload(payload, "channels", [
      "id", "name", "displayName", "type", "status", "connected", "enabled", "accountId",
    ]);
  }
  const fieldsByMethod: Record<string, readonly string[]> = {
    health: ["status", "healthy", "uptime", "version", "timestamp"],
    status: ["status", "healthy", "uptime", "version", "timestamp"],
    "system.info": ["version", "platform", "runtime", "arch"],
    "gateway.identity.get": ["id", "gatewayId", "name", "version", "profile"],
  };
  return displayFields(payload, fieldsByMethod[method] ?? []) ?? {};
}

function projectDelegatedReadResponse(
  frame: Record<string, unknown>,
  method: string,
): Record<string, unknown> {
  const projected: Record<string, unknown> = {
    type: frame.type,
    id: frame.id,
    ok: frame.ok,
  };
  if (frame.ok === true) projected.payload = delegatedReadPayload(method, frame.payload);
  else projected.error = { code: "REQUEST_FAILED", message: "OpenClaw request failed" };
  return projected;
}

function projectDelegatedOutcome(frame: Record<string, unknown>): Record<string, unknown> {
  const projected: Record<string, unknown> = {
    type: frame.type,
    id: frame.id,
    ok: frame.ok,
  };
  if (frame.ok !== true) {
    projected.error = { code: "REQUEST_FAILED", message: "OpenClaw request failed" };
  }
  return projected;
}

function projectDelegatedConnectChallenge(
  frame: Record<string, unknown>,
): Record<string, unknown> | null {
  const payload = record(frame.payload);
  return frame.type === "event" && frame.event === "connect.challenge" &&
    boundedString(payload?.nonce, 512)
    ? { type: "event", event: "connect.challenge", payload: { nonce: payload.nonce } }
    : null;
}

export function projectOpenClawServerFrameForProfile(
  frame: Record<string, unknown>,
  requestedMethod: string | undefined,
  profile: OpenClawBrokerProfile,
): Record<string, unknown> | null {
  if (profile === "native-owner" || profile === "native-co-owner") {
    return structuredClone(frame);
  }
  if (requestedMethod === "config.get" && frame.type === "res") {
    return projectDelegatedConfigGet(frame);
  }
  if (requestedMethod && frame.type === "res" && DELEGATED_READ_METHODS.has(requestedMethod)) {
    return projectDelegatedReadResponse(frame, requestedMethod);
  }
  if (record(frame.payload)?.type === "hello-ok") {
    return projectOpenClawHelloForProfile(frame, profile);
  }
  if (requestedMethod && frame.type === "res") return projectDelegatedOutcome(frame);
  return projectDelegatedConnectChallenge(frame);
}

export function openClawConfigSnapshotFromGetResponse(
  frame: unknown,
  requestedMethod: string | undefined,
): OpenClawConfigSnapshot | null {
  const response = record(frame);
  const payload = record(response?.payload);
  const raw = parsedRaw(payload?.raw);
  return requestedMethod === "config.get" && response?.type === "res" && response.ok === true &&
    raw && boundedString(payload?.hash, 512)
    ? { raw, hash: payload!.hash as string }
    : null;
}

export function installedMethodsFromHello(frame: unknown): Set<string> | undefined {
  const response = record(frame);
  const payload = record(response?.payload);
  const features = record(payload?.features);
  if (response?.type !== "res" || response.ok !== true || payload?.type !== "hello-ok" ||
    !Array.isArray(features?.methods) || features.methods.some((method) => typeof method !== "string")) {
    return undefined;
  }
  return new Set(features.methods as string[]);
}

export function openClawControlPolicyError(frame: unknown, reason: string): string {
  const request = record(frame);
  return JSON.stringify({
    type: "res",
    id: typeof request?.id === "string" ? request.id : "policy",
    ok: false,
    error: {
      code: "POLICY_DENIED",
      message: `Octogee policy denied this operation (${reason})`,
    },
  });
}

export function openClawControlTimeoutError(frame: unknown): string {
  const request = record(frame);
  return JSON.stringify({
    type: "res",
    id: typeof request?.id === "string" ? request.id : "timeout",
    ok: false,
    error: { code: "UPSTREAM_TIMEOUT", message: "OpenClaw did not respond before the request deadline" },
  });
}

export function isOpenClawControlMutation(category: OpenClawControlRpcCategory): boolean {
  return category === "config_mutation";
}
