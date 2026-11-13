import { stripVTControlCharacters } from "node:util";

const NAME_PATTERN = /^[a-z0-9][a-z0-9-]*$/i;
const MIGRATION_ID_PATTERN = /^[a-z0-9][a-z0-9:_-]*$/i;
const SINCE_PATTERN = /^([1-9]\d*)([smhd])$/;
const UNIT_MS: Record<string, number> = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 };
const LEVELS = ["DEFAULT", "DEBUG", "INFO", "NOTICE", "WARNING", "ERROR", "CRITICAL", "ALERT", "EMERGENCY"];
const ALIASES: Record<string, string> = { WARN: "WARNING", FATAL: "CRITICAL", TRACE: "DEBUG" };
const SERVICE_NAMES: Record<string, string> = {
  "octogee-api": "api",
  "glm-controller": "cowboy",
  "octogee-gateway": "gateway",
  "octogee-gateway-edge": "gateway-edge",
  "octogee-gitea": "gitea",
};
const QUERY_PARAMETERS = new Set(["level", "service", "user", "migration", "gateway", "since", "follow"]);
const DEFAULT_SINCE_MS = 10 * 60_000;
const PAGE_SIZE = 1_000;
const FOLLOW_OVERLAP_MS = 10_000;
const FOLLOW_POLL_MS = 5_000;
const HISTORY_ENTRY_LIMIT = 1_000;
const HISTORY_PAGE_LIMIT = 20;

export class FleetLogsQueryError extends Error {}

export interface FleetLogsQuery {
  readonly level: string;
  readonly services?: string[];
  readonly users?: string[];
  readonly gatewayId?: string;
  readonly migrationId?: string;
  readonly sinceMs: number;
  readonly follow: boolean;
}

export interface FleetLogEntry {
  readonly timestamp: string;
  readonly severity: string;
  readonly service: string;
  readonly instance: string;
  readonly gatewayId?: string;
  readonly user?: string;
  readonly category?: string;
  readonly status?: string;
  readonly message: string;
  readonly details: Record<string, unknown>;
}

export interface LogEntriesRequest {
  readonly filter: string;
  readonly orderBy: "timestamp asc" | "timestamp desc";
  readonly pageSize: number;
  readonly pageToken?: string;
}

export interface LogEntriesPage {
  readonly entries: readonly unknown[];
  readonly nextPageToken?: string;
}

export interface LogEntriesSource {
  list(request: LogEntriesRequest, signal: AbortSignal): Promise<LogEntriesPage>;
}

function severityName(raw: unknown): string {
  const name = String(raw ?? "DEFAULT").toUpperCase();
  return ALIASES[name] ?? (/^\d+$/.test(name) ? LEVELS[Number(name) / 100] : name) ?? "DEFAULT";
}

function single(query: Record<string, unknown>, key: string): string | undefined {
  const value = query[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new FleetLogsQueryError(`${key} must be given once`);
  return value;
}

function checkedName(value: string, what: string): string {
  if (!NAME_PATTERN.test(value)) throw new FleetLogsQueryError(`invalid ${what} '${value}'; use letters, digits and hyphens`);
  return value;
}

function names(value: string | undefined, what: string): string[] | undefined {
  return value === undefined ? undefined : value.split(",").map((part) => checkedName(part.trim(), what));
}

function level(value = "info"): string {
  const name = severityName(value);
  if (!LEVELS.includes(name)) {
    throw new FleetLogsQueryError(`invalid log level '${value}'; use debug, info, notice, warn, error, critical, alert, emergency or default`);
  }
  return name;
}

function followFlag(value: string | undefined): boolean {
  if (value === undefined || value === "true") return true;
  if (value === "false") return false;
  throw new FleetLogsQueryError("follow must be true or false");
}

function since(value: string | undefined, following: boolean): number {
  if (value === undefined) return DEFAULT_SINCE_MS;
  if (following) throw new FleetLogsQueryError("since applies only when follow is false");
  const match = SINCE_PATTERN.exec(value);
  if (!match) throw new FleetLogsQueryError("since must be a positive duration such as 30m or 2h");
  return Number(match[1]) * UNIT_MS[match[2]];
}

export function parseFleetLogsQuery(query: Record<string, unknown>): FleetLogsQuery {
  const unknown = Object.keys(query).filter((key) => !QUERY_PARAMETERS.has(key));
  if (unknown.length > 0) throw new FleetLogsQueryError(`unknown log parameter: ${unknown.join(", ")}`);
  const following = followFlag(single(query, "follow"));
  const migrationId = single(query, "migration");
  if (migrationId !== undefined && !MIGRATION_ID_PATTERN.test(migrationId)) {
    throw new FleetLogsQueryError(`invalid migration id '${migrationId}'`);
  }
  const gatewayId = single(query, "gateway");
  return {
    level: level(single(query, "level")),
    ...(query.service === undefined ? {} : { services: names(single(query, "service"), "service")!.map((name) => SERVICE_NAMES[name] ?? name) }),
    ...(query.user === undefined ? {} : { users: names(single(query, "user"), "user") }),
    ...(gatewayId === undefined ? {} : { gatewayId: checkedName(gatewayId, "gateway") }),
    ...(migrationId === undefined ? {} : { migrationId }),
    sinceMs: since(single(query, "since"), following),
    follow: following,
  };
}

export function buildFleetLogsFilter(input: { namespace: string; gatewayId?: string; migrationId?: string }): string {
  const namespace = checkedName(input.namespace, "namespace");
  const vm = (label: string) => `jsonPayload.container.metadata."ai.octogee.${label}"`;
  const clauses = [
    `((resource.type="k8s_container" AND resource.labels.namespace_name="${namespace}") OR (resource.type="gce_instance" AND ${vm("namespace")}="${namespace}"))`,
  ];
  if (input.gatewayId) {
    const id = checkedName(input.gatewayId, "gateway");
    clauses.push(`(jsonPayload.gatewayId="${id}" OR resource.labels.pod_name=~"^octogee-gateway-${id}(-r[0-9]+)?-[a-z0-9]+-[a-z0-9]+$" OR ${vm("gateway-id")}="${id}")`);
  }
  if (input.migrationId) clauses.push(`"${input.migrationId}"`);
  return clauses.join(" AND ");
}

type Obj = Record<string, unknown>;
function object(value: unknown): Obj {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Obj : {};
}
function text(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

const ENVELOPE_KEYS = new Set([
  "timestamp", "time", "severity", "level", "message", "msg", "service", "instance", "container",
  "gatewayId", "builderSlug", "category", "status", "pid", "hostname",
]);
const APPLICATION_LEVELS: Record<number, string> = { 10: "DEBUG", 20: "DEBUG", 30: "INFO", 40: "WARNING", 50: "ERROR", 60: "CRITICAL" };

function applicationPayload(raw: Obj, envelope: Obj): Obj {
  if (text(envelope.message)?.trimStart().startsWith("{") && object(raw.resource).type === "gce_instance") {
    let decoded: unknown;
    try {
      decoded = JSON.parse(envelope.message as string);
    } catch {
      decoded = undefined;
    }
    if (text(object(decoded).message) || text(object(decoded).msg)) return object(decoded);
  }
  return envelope;
}

function entrySource(labels: Obj, metadata: Obj, container: Obj): string {
  return text(labels.container_name) ?? text(metadata["ai.octogee.container"]) ?? text(container.name)?.replace(/^\//, "") ?? "unknown";
}

function entrySeverity(raw: Obj, payload: Obj): string {
  const applicationLevel = typeof payload.level === "number" ? APPLICATION_LEVELS[payload.level] : payload.level;
  return severityName(payload.severity ?? applicationLevel ?? raw.severity);
}

function entryDetails(payload: Obj): Obj {
  return Object.fromEntries(Object.entries(payload).filter(([key]) =>
    !ENVELOPE_KEYS.has(key) || (key === "status" && typeof payload.status !== "string")));
}

function entryMessage(raw: Obj, payload: Obj): string {
  return stripVTControlCharacters(text(raw.textPayload) ?? text(payload.message) ?? text(payload.msg) ?? "(structured event)")
    .replace(/^\d{4}-\d\d-\d\d[T ]\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)\s*/, "");
}

export function normalizeFleetLog(value: unknown): FleetLogEntry {
  const raw = object(value);
  if (!text(raw.timestamp)) throw new Error("log entry is missing its timestamp");
  const envelope = object(raw.jsonPayload);
  const payload = applicationPayload(raw, envelope);
  const container = object(envelope.container);
  const labels = object(object(raw.resource).labels);
  const metadata = object(container.metadata);
  const source = entrySource(labels, metadata, container);
  return {
    timestamp: new Date(raw.timestamp as string).toISOString(),
    severity: entrySeverity(raw, payload),
    service: text(payload.service) ?? SERVICE_NAMES[source] ?? source,
    instance: text(labels.pod_name) ?? text(object(envelope.instance).name) ?? text(labels.instance_id) ?? "unknown",
    gatewayId: text(payload.gatewayId) ?? text(metadata["ai.octogee.gateway-id"]),
    user: text(payload.builderSlug) ?? text(metadata["ai.octogee.builder-slug"]),
    category: text(payload.category),
    status: text(payload.status),
    message: entryMessage(raw, payload),
    details: entryDetails(payload),
  };
}

function matches(entry: FleetLogEntry, query: FleetLogsQuery): boolean {
  const rank = entry.severity === "DEFAULT" ? LEVELS.indexOf("INFO") : LEVELS.indexOf(entry.severity);
  if (rank < LEVELS.indexOf(query.level)) return false;
  if (query.services && !query.services.includes(entry.service)) return false;
  return !query.users || (entry.user !== undefined && query.users.includes(entry.user));
}

export interface StreamFleetLogsInput {
  readonly source: LogEntriesSource;
  readonly namespace: string;
  readonly query: FleetLogsQuery;
  readonly signal: AbortSignal;
  readonly now: () => number;
  readonly sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  readonly onStart: () => void;
  readonly write: (entry: FleetLogEntry) => Promise<void>;
}

async function readHistory(input: StreamFleetLogsInput, filter: string): Promise<{ entries: FleetLogEntry[]; truncated: boolean }> {
  const entries: FleetLogEntry[] = [];
  let pageToken: string | undefined;
  for (let pages = 0; pages < HISTORY_PAGE_LIMIT; pages += 1) {
    const page = await input.source.list({
      filter,
      orderBy: "timestamp desc",
      pageSize: PAGE_SIZE,
      ...(pageToken === undefined ? {} : { pageToken }),
    }, input.signal);
    for (const value of page.entries) {
      const entry = normalizeFleetLog(value);
      if (!matches(entry, input.query)) continue;
      entries.push(entry);
      if (entries.length === HISTORY_ENTRY_LIMIT) return { entries, truncated: true };
    }
    pageToken = page.nextPageToken;
    if (pageToken === undefined) return { entries, truncated: false };
  }
  return { entries, truncated: true };
}

function truncationNotice(now: number): FleetLogEntry {
  return {
    timestamp: new Date(now).toISOString(),
    severity: "WARNING",
    service: "fleet",
    instance: "admin-api",
    message: "Older entries in this window were not read. Shorten since or add a filter.",
    details: { truncated: true },
  };
}

async function writeHistory(input: StreamFleetLogsInput, scope: string): Promise<void> {
  const from = new Date(input.now() - input.query.sinceMs).toISOString();
  const { entries, truncated } = await readHistory(input, `${scope} AND timestamp>="${from}"`);
  input.onStart();
  for (const entry of entries.reverse()) await input.write(entry);
  if (truncated) await input.write(truncationNotice(input.now()));
}

function entryKey(raw: Obj): string {
  return text(raw.insertId) ?? JSON.stringify([raw.logName, raw.timestamp, raw.textPayload ?? raw.jsonPayload]);
}

interface FollowPosition {
  readonly seen: Map<string, number>;
  cursor: number;
}

async function writeUnseen(input: StreamFleetLogsInput, position: FollowPosition, entries: readonly unknown[]): Promise<void> {
  for (const value of entries) {
    const raw = object(value);
    const key = entryKey(raw);
    if (position.seen.has(key)) continue;
    const received = Date.parse(text(raw.receiveTimestamp) ?? "");
    const known = Number.isFinite(received);
    position.seen.set(key, known ? received : position.cursor);
    if (known) position.cursor = Math.max(position.cursor, received);
    const entry = normalizeFleetLog(raw);
    if (matches(entry, input.query)) await input.write(entry);
  }
}

function forgetPassedEntries(position: FollowPosition): void {
  for (const [key, received] of position.seen) {
    if (received < position.cursor - FOLLOW_OVERLAP_MS) position.seen.delete(key);
  }
}

async function followNewEntries(input: StreamFleetLogsInput, scope: string): Promise<void> {
  const position: FollowPosition = { seen: new Map(), cursor: input.now() };
  let started = false;
  while (!input.signal.aborted) {
    const filter = `${scope} AND receiveTimestamp>="${new Date(position.cursor - FOLLOW_OVERLAP_MS).toISOString()}"`;
    let pageToken: string | undefined;
    do {
      const page = await input.source.list({
        filter,
        orderBy: "timestamp asc",
        pageSize: PAGE_SIZE,
        ...(pageToken === undefined ? {} : { pageToken }),
      }, input.signal);
      if (!started) input.onStart();
      started = true;
      await writeUnseen(input, position, page.entries);
      pageToken = page.nextPageToken;
    } while (pageToken !== undefined && !input.signal.aborted);
    forgetPassedEntries(position);
    await input.sleep(FOLLOW_POLL_MS, input.signal);
  }
}

export async function streamFleetLogs(input: StreamFleetLogsInput): Promise<void> {
  const scope = buildFleetLogsFilter({
    namespace: input.namespace,
    ...(input.query.gatewayId === undefined ? {} : { gatewayId: input.query.gatewayId }),
    ...(input.query.migrationId === undefined ? {} : { migrationId: input.query.migrationId }),
  });
  if (input.query.follow) await followNewEntries(input, scope);
  else await writeHistory(input, scope);
}
