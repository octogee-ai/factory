import { parseArgs, stripVTControlCharacters } from "node:util";
import { JSONParser } from "@streamparser/json";
import pc from "picocolors";

const NAME_PATTERN = /^[a-z0-9][a-z0-9-]*$/i;
const LEVELS = ["DEFAULT", "DEBUG", "INFO", "NOTICE", "WARNING", "ERROR", "CRITICAL", "ALERT", "EMERGENCY"];
const ALIASES: Record<string, string> = { WARN: "WARNING", FATAL: "CRITICAL", TRACE: "DEBUG" };
const SERVICE_NAMES: Record<string, string> = { "octogee-api": "api", "glm-controller": "cowboy", "octogee-gateway": "gateway", "octogee-gateway-edge": "gateway-edge", "octogee-gitea": "gitea" };
export const FLEET_LOGS_TAIL_ENV = { PYTHONUNBUFFERED: "1" } as const;

export function severityName(raw: unknown): string {
  const name = String(raw ?? "DEFAULT").toUpperCase();
  return ALIASES[name] ?? (/^\d+$/.test(name) ? LEVELS[Number(name) / 100] : name) ?? "DEFAULT";
}

function validatedLevel(value: string): string {
  const level = severityName(value);
  if (!LEVELS.includes(level)) throw new Error(`Invalid log level '${value}'; use debug, info, notice, warn, error, critical, alert, emergency, or default`);
  return level;
}

function name(value: string, what: string): string {
  if (!NAME_PATTERN.test(value)) throw new Error(`Invalid ${what} '${value}'; use letters, digits, and hyphens`);
  return value;
}

function list(value: string | undefined, what: string): string[] | undefined {
  return value === undefined ? undefined : value.split(",").map(v => name(v.trim(), what));
}

export interface FleetLogsOptions {
  environment: "test" | "prod";
  level?: string;
  levelExact?: string[];
  services?: string[];
  builders?: string[];
  gatewayId?: string;
  container?: string;
  follow: boolean;
  since?: string;
  limit: number;
  format: "pretty" | "json";
  timestamps: "short" | "full";
  color: "auto" | "always" | "never";
  bufferWindow: string;
}

function choice<T extends string>(value: string | undefined, fallback: T, allowed: readonly T[], option: string): T {
  const selected = value ?? fallback;
  if (!allowed.includes(selected as T)) throw new Error(`--${option} must be ${allowed.join(", ")}`);
  return selected as T;
}

function optionalName(value: string | undefined, what: string): string | undefined {
  return value === undefined ? undefined : name(value, what);
}

function historyOptions(since: string | undefined, noFollow: boolean | undefined, rawLimit: string | undefined) {
  if (since !== undefined && !/^[1-9]\d*[smhd]$/.test(since)) throw new Error("--since must be a positive duration, such as 30m or 2h");
  if (since !== undefined && !noFollow) throw new Error("--since is for history: add --no-follow; omit --since to stream live logs");
  const limit = Number(rawLimit ?? 1000);
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error("--limit must be a positive integer");
  return { follow: !noFollow, since, limit };
}

function bufferWindowOption(value = "2s"): string {
  if (!/^\d+(?:\.\d+)?s$/.test(value) || Number(value.slice(0, -1)) > 60) throw new Error("--buffer-window must be 0s through 60s");
  return value;
}

function parseLogArguments(argv: string[]) {
  const { values: v, positionals, tokens } = parseArgs({ args: argv, allowPositionals: true, tokens: true, options: {
    env: { type: "string" }, level: { type: "string" }, "level-exact": { type: "string" },
    service: { type: "string" }, builder: { type: "string" }, gateway: { type: "string" }, container: { type: "string" },
    "no-follow": { type: "boolean" }, since: { type: "string" }, limit: { type: "string" },
    format: { type: "string" }, timestamps: { type: "string" }, color: { type: "string" }, "buffer-window": { type: "string" },
  } });
  const seen = new Set<string>();
  for (const token of tokens) {
    if (token.kind !== "option") continue;
    if (seen.has(token.name)) throw new Error(`Duplicate --${token.name}; use comma-separated values for lists`);
    seen.add(token.name);
  }
  if (positionals.join(" ") !== "logs") throw new Error("Usage: fleet --env=<test|prod> logs [options]");
  return v;
}

export function parseFleetLogsOptions(argv: string[]): FleetLogsOptions {
  const v = parseLogArguments(argv);
  if (v.env !== "test" && v.env !== "prod") throw new Error("--env must be test or prod");
  if (v.level !== undefined && v["level-exact"] !== undefined) throw new Error("Use either --level or --level-exact");
  return {
    environment: v.env, level: v["level-exact"] ? undefined : validatedLevel(v.level ?? "info"),
    levelExact: v["level-exact"]?.split(",").map(validatedLevel),
    services: list(v.service, "service")?.map(s => SERVICE_NAMES[s] ?? s), builders: list(v.builder, "Builder slug"),
    gatewayId: optionalName(v.gateway, "gateway"), container: optionalName(v.container, "container"),
    ...historyOptions(v.since, v["no-follow"], v.limit),
    format: choice(v.format, "pretty", ["pretty", "json"], "format"),
    timestamps: choice(v.timestamps, "short", ["short", "full"], "timestamps"),
    color: choice(v.color, "auto", ["auto", "always", "never"], "color"),
    bufferWindow: bufferWindowOption(v["buffer-window"]),
  };
}

export function buildFleetLogsFilter(query: { namespace: string; gatewayId?: string; container?: string }): string {
  const namespace = name(query.namespace, "namespace");
  const vm = (label: string) => `jsonPayload.container.metadata."ai.octogee.${label}"`;
  const clauses = [`((resource.type="k8s_container" AND resource.labels.namespace_name="${namespace}") OR (resource.type="gce_instance" AND ${vm("namespace")}="${namespace}"))`];
  if (query.gatewayId) {
    const id = name(query.gatewayId, "gateway");
    clauses.push(`(jsonPayload.gatewayId="${id}" OR resource.labels.pod_name=~"^octogee-gateway-${id}(-r[0-9]+)?-[a-z0-9]+-[a-z0-9]+$" OR ${vm("gateway-id")}="${id}")`);
  }
  if (query.container) {
    const container = name(query.container, "container");
    clauses.push(`(resource.labels.container_name="${container}" OR ${vm("container")}="${container}")`);
  }
  return clauses.join(" AND ");
}

export function fleetLogsTailArgs(input: { projectId: string; filter: string; bufferWindow?: string }): string[] {
  return ["alpha", "logging", "tail", input.filter, `--project=${input.projectId}`, `--buffer-window=${input.bufferWindow ?? "2s"}`, "--format=json"];
}

export function createFleetLogsParser(onEntry: (entry: unknown) => void): JSONParser {
  const parser = new JSONParser({ paths: ["$.*"], keepStack: false });
  parser.onValue = ({ value }) => onEntry(value);
  return parser;
}

type Obj = Record<string, unknown>;
function object(value: unknown): Obj { return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Obj : {}; }
function string(value: unknown): string | undefined { return typeof value === "string" && value.length > 0 ? value : undefined; }

export interface FleetLogLine {
  timestamp: string;
  severity: string;
  service: string;
  instance: string;
  gatewayId?: string;
  builderSlug?: string;
  category?: string;
  status?: string;
  message: string;
  details: Obj;
  raw: Obj;
}

const ENVELOPE_KEYS = new Set(["timestamp", "time", "severity", "level", "message", "msg", "service", "instance", "container", "gatewayId", "builderSlug", "category", "status", "pid", "hostname"]);

function applicationPayload(raw: Obj, envelope: Obj): Obj {
  if (string(envelope.message)?.trimStart().startsWith("{") && object(raw.resource).type === "gce_instance") {
    let decoded: unknown;
    try { decoded = JSON.parse(envelope.message as string); } catch { decoded = undefined; }
    if (string(object(decoded).message) || string(object(decoded).msg)) return object(decoded);
  }
  return envelope;
}

function logIdentity(raw: Obj, envelope: Obj, payload: Obj) {
  const container = object(envelope.container);
  const labels = object(object(raw.resource).labels);
  const metadata = object(container.metadata);
  const source = string(labels.container_name) ?? string(metadata["ai.octogee.container"]) ?? string(container.name)?.replace(/^\//, "") ?? "unknown";
  return {
    service: string(payload.service) ?? SERVICE_NAMES[source] ?? source,
    instance: string(labels.pod_name) ?? string(object(envelope.instance).name) ?? string(labels.instance_id) ?? "unknown",
    gatewayId: string(payload.gatewayId) ?? string(metadata["ai.octogee.gateway-id"]),
    builderSlug: string(payload.builderSlug) ?? string(metadata["ai.octogee.builder-slug"]),
  };
}

export function normalizeFleetLog(value: unknown): FleetLogLine {
  const raw = object(value);
  if (!string(raw.timestamp)) throw new Error("Cloud Logging entry is missing its timestamp");
  const envelope = object(raw.jsonPayload ?? raw.json_payload);
  const payload = applicationPayload(raw, envelope);
  const timestamp = new Date(raw.timestamp as string).toISOString();
  const applicationLevel = typeof payload.level === "number"
    ? ({ 10: "DEBUG", 20: "DEBUG", 30: "INFO", 40: "WARNING", 50: "ERROR", 60: "CRITICAL" } as Record<number, string>)[payload.level]
    : payload.level;
  const details = Object.fromEntries(Object.entries(payload).filter(([key]) => (!ENVELOPE_KEYS.has(key) || (key === "status" && typeof payload.status !== "string"))));
  return {
    timestamp, severity: severityName(payload.severity ?? applicationLevel ?? raw.severity),
    ...logIdentity(raw, envelope, payload), category: string(payload.category), status: string(payload.status),
    message: stripVTControlCharacters(string(raw.textPayload ?? raw.text_payload) ?? string(payload.message) ?? string(payload.msg) ?? "(structured event)")
      .replace(/^\d{4}-\d\d-\d\d[T ]\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)\s*/, ""),
    details, raw,
  };
}

export function matchesFleetLog(entry: FleetLogLine, filter: Pick<FleetLogsOptions, "level" | "levelExact" | "services" | "builders">): boolean {
  if (filter.levelExact && !filter.levelExact.includes(entry.severity)) return false;
  const rank = entry.severity === "DEFAULT" ? LEVELS.indexOf("INFO") : LEVELS.indexOf(entry.severity);
  if (filter.level && rank < LEVELS.indexOf(filter.level)) return false;
  if (filter.services && !filter.services.includes(entry.service)) return false;
  return !filter.builders || (entry.builderSlug !== undefined && filter.builders.includes(entry.builderSlug));
}

function oneLine(value: string): string { return stripVTControlCharacters(value).replace(/[\r\n\t]/g, c => ({ "\r": "\\r", "\n": "\\n", "\t": "\\t" })[c]!); }

function sourceColorIndex(source: string): number {
  let hash = 2_166_136_261;
  for (let i = 0; i < source.length; i++) hash = Math.imul(hash ^ source.charCodeAt(i), 16_777_619);
  return (hash >>> 0) % 6;
}

function logInstance(entry: FleetLogLine): string {
  if (!entry.gatewayId) return entry.instance;
  const instance = object(entry.raw.resource).type === "k8s_container" ? entry.instance.split("-").at(-1) : entry.instance.replace(/^octogee-/, "");
  return `${entry.gatewayId}/${instance}`;
}

function severityColor(colors: ReturnType<typeof pc.createColors>, severity: string) {
  if (LEVELS.indexOf(severity) >= 5) return colors.red;
  return severity === "WARNING" ? colors.yellow : colors.dim;
}

function logDetails(entry: FleetLogLine): string[] {
  const parts: string[] = [];
  const requestSummary = typeof entry.details.method === "string" && typeof entry.details.path === "string" && typeof entry.details.status === "number"
    && entry.message.startsWith(`${entry.details.method} ${entry.details.path} ${entry.details.status}`);
  for (const [key, value] of Object.entries(entry.details)) {
    if (requestSummary && ["method", "path", "status", "durationMs"].includes(key)) continue;
    if (value !== undefined) parts.push(`${key}=${typeof value === "string" && !/\s/.test(value) ? value : JSON.stringify(value)}`);
  }
  return parts;
}

export function renderFleetLogLine(entry: FleetLogLine, options: { color: boolean; timestamps?: "short" | "full" }): string {
  const colors = pc.createColors(options.color);
  const sourceColor = [colors.cyan, colors.magenta, colors.blue, colors.green, colors.yellow, colors.red][sourceColorIndex(entry.instance)];
  const severity = severityColor(colors, entry.severity);
  const icons: Record<string, string> = { running: "🟡", pending: "🟡", done: "🟢", succeeded: "🟢", failed: "🔴", ERROR: "🔴", WARNING: "⚠" };
  const icon = icons[entry.status ?? ""] ?? icons[entry.severity] ?? "·";
  const instance = logInstance(entry);
  const parts = [colors.dim(options.timestamps === "full" ? entry.timestamp : entry.timestamp.slice(11)), severity(entry.severity), colors.cyan(entry.service), sourceColor(instance)];
  if (entry.builderSlug) parts.push(colors.green(`builder=${entry.builderSlug}`));
  if (entry.category) parts.push(`[${entry.category}]`);
  parts.push(icon, entry.message);
  parts.push(...logDetails(entry));
  return parts.map(part => options.color ? part.replace(/[\r\n\t]/g, c => ({ "\r": "\\r", "\n": "\\n", "\t": "\\t" })[c]!) : oneLine(part)).join(" ");
}
