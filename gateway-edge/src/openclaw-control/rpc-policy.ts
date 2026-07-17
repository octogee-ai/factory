import {
  platformInvariantViolations,
  type SystemConfigInvariantContext,
} from "@octogee/core/system-config-invariants";
import JSON5 from "json5";
import advertisedMethods from "./openclaw-2026.7.1-advertised-methods.json" with { type: "json" };

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

export type OpenClawControlRpcPolicyMode = "native" | "sanitized";

export function openClawControlRpcPolicyMode(
  env: NodeJS.ProcessEnv = process.env,
): OpenClawControlRpcPolicyMode {
  const value = env.OPENCLAW_CONTROL_RPC_POLICY_MODE?.trim() || "native";
  if (value === "native" || value === "sanitized") return value;
  throw new Error(
    `OPENCLAW_CONTROL_RPC_POLICY_MODE must be native or sanitized, got ${JSON.stringify(value)}`,
  );
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
const BLOCKED_OBJECT_KEYS = new Set(["__proto__", "prototype", "constructor"]);
const REDACTED_SENTINEL = "__OPENCLAW_REDACTED__";
const ARRAY_IDENTITY_KEYS = ["id", "agentId", "accountId", "key"] as const;

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
    return { allowed: false, category: "forbidden_mutation", reason: "method-unavailable" };
  }
  if (READ_METHODS.has(method)) {
    return { allowed: true, category: "read", outbound: structuredClone(request) };
  }
  if (CONFIG_MUTATION_METHODS.has(method)) return configMutationDecision(request, context);
  if (method === "tools.invoke") return safeToolDecision(request);
  return { allowed: false, category: "forbidden_mutation", reason: "method-unavailable" };
}

export function evaluateNativeOpenClawControlRpc(
  frame: unknown,
  context: Pick<OpenClawControlRpcPolicyContext, "installedMethods">,
): OpenClawControlRpcDecision {
  const request = record(frame);
  if (!request || request.type !== "req" || !boundedString(request.id, 256) ||
    !boundedString(request.method, 256) || !record(request.params)) {
    return { allowed: false, category: "unknown", reason: "invalid-frame" };
  }
  const method = request.method as string;
  if (!context.installedMethods.has(method)) {
    return { allowed: false, category: "unknown", reason: "method-unavailable" };
  }
  let category: OpenClawControlRpcCategory = "unknown";
  if (CONFIG_MUTATION_METHODS.has(method)) category = "config_mutation";
  else if (method === "tools.invoke") category = "tools_invoke";
  else if (READ_METHODS.has(method)) category = "read";
  return { allowed: true, category, outbound: structuredClone(request) };
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
