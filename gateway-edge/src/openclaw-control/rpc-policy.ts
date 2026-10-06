import { platformInvariantViolations, type SystemConfigInvariantContext } from "@octogee/core/system-config-invariants";
import JSON5 from "json5";
export type OpenClawControlRpcCategory =
  | "read"
  | "config_mutation"
  | "approval_read"
  | "approval_mutation"
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
    | "method-unavailable"
    | "config-frozen"
    | "workspace-not-serving"
    | "roster-loading"
    | "config-base-mismatch"
    | "config-invalid"
    | "config-unsafe-path"
    | "redacted-array-structural-edit"
    | "platform-invariant"
    | "tool-denied"
    | "tool-schema-invalid"
    | "approval-schema-invalid";
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

const NATIVE_READ_METHODS = new Set([
  "sessions.list", "sessions.describe", "sessions.preview", "sessions.catalog",
  "sessions.files.get", "chat.history", "chat.startup", "board.get", "question.list",
  "models.authStatus", "taskSuggestions.list", "progressCard.get", "tasks.list",
  "talk.catalog", "terminal.list", "plugins.list", "plugins.controlUi.list",
]);

const CONFIG_MUTATION_METHODS = new Set(["config.set", "config.apply", "config.patch"]);

const APPROVAL_READ_METHODS = new Set([
  "approval.history",
  "approval.get",
  "exec.approval.list",
  "plugin.approval.list",
  "openclaw.approval.list",
]);

const APPROVAL_MUTATION_METHODS = new Set([
  "approval.resolve",
  "exec.approval.resolve",
  "plugin.approval.resolve",
]);

const BLOCKED_OBJECT_KEYS = new Set(["__proto__", "prototype", "constructor"]);

const APPROVAL_KINDS = new Set(["exec", "plugin", "system-agent"]);

const APPROVAL_DECISIONS = new Set(["allow-once", "allow-always", "deny"]);

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

function wellFormedApprovalId(value: unknown): value is string {
  if (!boundedString(value, 4_096) || value === "." || value === "..") return false;
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function validApprovalHistoryParams(params: Record<string, unknown>): boolean {
  return exactKeys(params, new Set(["cursor", "limit", "kind"])) &&
    (params.cursor === undefined || boundedString(params.cursor, 512)) &&
    optionalInteger(params.limit, 1, 100) &&
    (params.kind === undefined || typeof params.kind === "string" && APPROVAL_KINDS.has(params.kind));
}

function validApprovalGetParams(params: Record<string, unknown>): boolean {
  return exactKeys(params, new Set(["id"])) && wellFormedApprovalId(params.id);
}

function validApprovalResolveParams(params: Record<string, unknown>): boolean {
  return exactKeys(params, new Set(["id", "kind", "decision"])) &&
    wellFormedApprovalId(params.id) &&
    typeof params.kind === "string" && APPROVAL_KINDS.has(params.kind) &&
    typeof params.decision === "string" && APPROVAL_DECISIONS.has(params.decision);
}

function validLegacyApprovalResolveParams(params: Record<string, unknown>): boolean {
  return exactKeys(params, new Set(["id", "decision"])) &&
    wellFormedApprovalId(params.id) &&
    typeof params.decision === "string" && APPROVAL_DECISIONS.has(params.decision);
}

function nativeApprovalDecision(request: Record<string, unknown>): OpenClawControlRpcDecision {
  const params = record(request.params);
  const method = typeof request.method === "string" ? request.method : "";
  let valid = false;
  if (params !== null) {
    switch (method) {
      case "approval.history":
        valid = validApprovalHistoryParams(params);
        break;
      case "approval.get":
        valid = validApprovalGetParams(params);
        break;
      case "exec.approval.list":
      case "plugin.approval.list":
      case "openclaw.approval.list":
        valid = exactKeys(params, new Set());
        break;
      case "approval.resolve":
        valid = validApprovalResolveParams(params);
        break;
      default:
        valid = validLegacyApprovalResolveParams(params);
    }
  }
  if (!valid) {
    return {
      allowed: false,
      category: APPROVAL_MUTATION_METHODS.has(method)
        ? "approval_mutation"
        : "approval_read",
      reason: "approval-schema-invalid",
    };
  }
  return {
    allowed: true,
    category: APPROVAL_MUTATION_METHODS.has(method) ? "approval_mutation" : "approval_read",
    outbound: structuredClone(request),
  };
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

function parsedOpenClawControlRequest(
  frame: unknown,
): { request: Record<string, unknown>; method: string } | OpenClawControlRpcDecision {
  const request = record(frame);
  if (!request || request.type !== "req" || !boundedString(request.id, 256) ||
    !boundedString(request.method, 256) || (request.params !== undefined && !record(request.params))) {
    return { allowed: false, category: "unknown", reason: "invalid-frame" };
  }
  return { request: { ...request, params: request.params ?? {} }, method: request.method as string };
}

export function openClawControlRpcCategory(method: string): OpenClawControlRpcCategory {
  if (READ_METHODS.has(method) || NATIVE_READ_METHODS.has(method)) return "read";
  if (CONFIG_MUTATION_METHODS.has(method)) return "config_mutation";
  if (APPROVAL_READ_METHODS.has(method)) return "approval_read";
  if (APPROVAL_MUTATION_METHODS.has(method)) return "approval_mutation";
  if (method === "tools.invoke") return "tools_invoke";
  return "unknown";
}

function nativeConfigMutationDecision(
  request: Record<string, unknown>,
  context: OpenClawControlRpcPolicyContext,
): OpenClawControlRpcDecision {
  const category = "config_mutation";
  if (context.configFrozen) return { allowed: false, category, reason: "config-frozen" };
  const params = record(request.params);
  const current = context.currentConfig;
  const raw = params ? parsedRaw(params.raw) : null;
  const replacePaths = params ? normalizedReplacePaths(params.replacePaths) : null;
  if (!raw || !replacePaths || request.method === "config.patch" && !current) {
    return { allowed: false, category, reason: "config-invalid" };
  }
  const proposed = request.method === "config.patch"
    ? proposedMutationConfig(request.method, current!.raw, raw, replacePaths)
    : structuredClone(raw);
  if (platformInvariantViolations(proposed, context.invariantContext).length > 0) {
    return { allowed: false, category, reason: "platform-invariant" };
  }
  return { allowed: true, category, proposedConfig: proposed, outbound: structuredClone(request) };
}

export function evaluateOpenClawControlRpc(
  frame: unknown,
  context: OpenClawControlRpcPolicyContext,
  canAdminister: boolean,
): OpenClawControlRpcDecision {
  const parsed = parsedOpenClawControlRequest(frame);
  if ("allowed" in parsed) return parsed;
  if (APPROVAL_READ_METHODS.has(parsed.method) || APPROVAL_MUTATION_METHODS.has(parsed.method)) {
    return nativeApprovalDecision(parsed.request);
  }
  const category = openClawControlRpcCategory(parsed.method);
  if (category === "config_mutation") {
    if (!canAdminister) return { allowed: false, category, reason: "method-unavailable" };
    return nativeConfigMutationDecision(parsed.request, context);
  }
  return {
    allowed: true,
    category,
    outbound: structuredClone(parsed.request),
  };
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
  return category === "config_mutation" || category === "approval_mutation";
}
