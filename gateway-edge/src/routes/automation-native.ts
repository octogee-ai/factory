import { createHash } from "node:crypto";
import { parseMattermostSessionRoute } from "@octogee/shared/types/mattermost-session-route";
import type { HostedAutomationsContext, HostedAutomationJobCapabilities } from "@octogee/shared/types/automations";

export type AutomationRecord = Record<string, unknown>;
export type AutomationInvoke = (method: string, params: AutomationRecord) => Promise<unknown>;
export interface AutomationScope { slug: string; coachChannelId: string }
export class AutomationBrokerError extends Error {
  constructor(readonly status: number, readonly code: string, readonly details?: AutomationRecord) { super(code); }
}
const PAGE_SIZE = 200;
const MAX_INVENTORY = 2_000;
const MAX_RUN_ENTRIES = 2_000;
export function automationRecord(value: unknown): AutomationRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as AutomationRecord : null;
}
function fail(status: number, code: string): never { throw new AutomationBrokerError(status, code); }
function keys(value: AutomationRecord, allowed: readonly string[]): boolean { return Object.keys(value).every((key) => allowed.includes(key)); }
function string(value: unknown): value is string { return typeof value === "string" && value.length > 0 && value.trim() === value; }
function integer(value: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max; }
function agentId(scope: AutomationScope): string { return `octogee-${scope.slug}-coach`; }
function accountId(scope: AutomationScope): string { return `${scope.slug}-coach`; }
function sessionAgent(value: unknown): string | null { return typeof value === "string" ? /^agent:([^:]+):.+$/.exec(value)?.[1] ?? null : null; }

function projectedJob(job: AutomationRecord, scope: AutomationScope): boolean {
  const agent = agentId(scope), payload = automationRecord(job.payload);
  if (job.effectiveAgentId !== agent || (job.agentId !== undefined && job.agentId !== agent)) return false;
  if (job.declarationKey === `heartbeat:${agent}`) return payload?.kind === "heartbeat";
  if (job.declarationKey === `skill-collection-review:${agent}`) return payload?.kind === "agentTurn";
  return job.declarationKey === "memory-core:memory-dreaming-promotion" && payload?.kind === "agentTurn" && payload.message === "__openclaw_memory_core_short_term_promotion_dream__" && payload.lightContext === true;
}
function protectedPayload(job: AutomationRecord): boolean {
  const payload = automationRecord(job.payload), schedule = automationRecord(job.schedule);
  return payload?.kind === "command" || payload?.kind === "script" || schedule?.kind === "on-exit" || schedule?.kind === "stream";
}
function scopedPolicy(job: AutomationRecord, owner: AutomationRecord, scope: AutomationScope): boolean {
  if (job.scheduledToolPolicy === undefined) return true;
  const policy = automationRecord(job.scheduledToolPolicy);
  return policy?.version === 1 && policy.mode === "account" &&
    policy.ownerAccountId === accountId(scope) && policy.ownerSessionKey === owner.sessionKey &&
    sessionAgent(policy.ownerSessionKey) === agentId(scope);
}
function ownsJob(job: AutomationRecord, scope: AutomationScope): boolean {
  if (protectedPayload(job)) return false;
  if (job.owner === undefined) {
    const policy = automationRecord(job.scheduledToolPolicy);
    return (job.scheduledToolPolicy === undefined || (policy?.version === 1 && policy.mode === "trusted")) && projectedJob(job, scope);
  }
  const owner = automationRecord(job.owner);
  if (!owner || owner.agentId !== agentId(scope) || owner.accountId !== accountId(scope) ||
    parseMattermostSessionRoute(owner.sessionKey)?.agentId !== agentId(scope)) return false;
  return scopedPolicy(job, owner, scope);
}

function nativeJob(value: unknown): AutomationRecord {
  const job = automationRecord(value);
  if (!job || !string(job.id) || !string(job.name) || typeof job.enabled !== "boolean" || !string(job.configRevision) || !automationRecord(job.payload) || !automationRecord(job.schedule) || !automationRecord(job.state)) fail(502, "invalid_native_automation_inventory");
  return job;
}
interface NativePage { rows: AutomationRecord[]; revision: string; total: number; next: number | null }
interface PageMetadata { total: number; offset: number; limit: number; hasMore: boolean; nextOffset: unknown }
function pageMetadata(value: unknown, offset: number, error: string): AutomationRecord & PageMetadata {
  const page = automationRecord(value);
  if (!page || !integer(page.total) || !integer(page.limit, 1, PAGE_SIZE) || page.offset !== offset || typeof page.hasMore !== "boolean") fail(502, error);
  return page as AutomationRecord & PageMetadata;
}
function validateCursor(page: PageMetadata, count: number, error: string): number | null {
  const next = page.offset + count;
  if (count > page.limit || next > page.total) fail(502, error);
  if (page.hasMore) {
    if (page.nextOffset !== next || next <= page.offset || next >= page.total) fail(502, error);
    return next;
  }
  if (page.nextOffset !== null || next !== page.total) fail(502, error);
  return null;
}
function readPage(value: unknown, offset: number): NativePage {
  const page = pageMetadata(value, offset, "invalid_native_automation_inventory");
  if (!Array.isArray(page.jobs) || !string(page.snapshotRevision)) fail(502, "invalid_native_automation_inventory");
  if (page.total > MAX_INVENTORY) fail(503, "automation_inventory_limit");
  const rows = page.jobs.map(nativeJob);
  const next = validateCursor(page, rows.length, "invalid_native_automation_inventory");
  return { rows, total: page.total, revision: page.snapshotRevision, next };
}
interface Inventory { jobs: AutomationRecord[]; revision: string }
async function scanInventory(invoke: AutomationInvoke, scope: AutomationScope, base: AutomationRecord): Promise<Inventory | null> {
  const jobs: AutomationRecord[] = [], ids = new Set<unknown>();
  let offset: number | null = 0, revision = "", total = -1;
  while (offset !== null) {
    const page = readPage(await invoke("cron.list", { ...base, offset }), offset);
    if (revision && (page.revision !== revision || page.total !== total)) return null;
    revision = page.revision;
    total = page.total;
    for (const job of page.rows) {
      if (ids.has(job.id)) fail(502, "invalid_native_automation_inventory");
      ids.add(job.id);
      if (ownsJob(job, scope)) jobs.push(job);
    }
    offset = page.next;
  }
  const check = readPage(await invoke("cron.list", { ...base, offset: 0 }), 0);
  return check.revision === revision && check.total === total ? { jobs, revision } : null;
}
async function inventory(invoke: AutomationInvoke, scope: AutomationScope, filters: AutomationRecord = {}): Promise<Inventory> {
  const base = { includeDisabled: true, includeDeliveryPreviews: false, ...filters, limit: PAGE_SIZE };
  for (let attempt = 0; attempt < 2; attempt++) {
    const snapshot = await scanInventory(invoke, scope, base);
    if (snapshot) return snapshot;
  }
  return fail(409, "automation_inventory_changed");
}
function revisionFor(jobs: AutomationRecord[]): string { return createHash("sha256").update(JSON.stringify(jobs)).digest("hex"); }
function pageParams(params: AutomationRecord): { offset: number; limit: number } {
  const offset = params.offset ?? 0, limit = params.limit ?? 50;
  if (!integer(offset) || !integer(limit, 1, PAGE_SIZE)) fail(400, "invalid_automation_pagination");
  return { offset, limit };
}
function scopedPage(rows: AutomationRecord[], params: AutomationRecord): AutomationRecord {
  const { offset, limit } = pageParams(params), total = rows.length;
  if (offset > total) fail(409, "automation_inventory_changed");
  const selected = rows.slice(offset, offset + limit), next = offset + selected.length;
  return { total, offset, limit, hasMore: next < total, nextOffset: next < total ? next : null, rows: selected };
}
function executionScoped(job: AutomationRecord, scope: AutomationScope): boolean {
  if (job.effectiveAgentId !== agentId(scope)) return false;
  if (job.sessionKey !== undefined && sessionAgent(job.sessionKey) !== agentId(scope)) return false;
  return job.sessionTarget === "isolated" || job.sessionTarget === "main";
}
function jobCapabilities(job: AutomationRecord, scope: AutomationScope): HostedAutomationJobCapabilities {
  return { history: executionScoped(job, scope) };
}
function context(scope: AutomationScope): HostedAutomationsContext {
  return { agentId: agentId(scope), canManage: false, readOnlyReason: "Manage automations through your agent.", capabilities: { runTranscripts: false, scratch: false } };
}
const LIST_FIELDS = ["agentId", "includeDisabled", "includeDeliveryPreviews", "limit", "offset", "query", "enabled", "scheduleKind", "lastRunStatus", "trigger", "sortBy", "sortDir"];
function listFilters(params: AutomationRecord, scope: AutomationScope): AutomationRecord {
  if (!keys(params, LIST_FIELDS) || (params.agentId !== undefined && params.agentId !== agentId(scope))) fail(400, "invalid_automation_scope");
  pageParams(params);
  if (params.includeDeliveryPreviews === true) fail(400, "automation_delivery_previews_unavailable");
  const filters = { ...params };
  for (const key of ["agentId", "offset", "limit", "includeDeliveryPreviews"]) delete filters[key];
  return filters;
}
async function list(invoke: AutomationInvoke, scope: AutomationScope, params: AutomationRecord): Promise<unknown> {
  const { jobs } = await inventory(invoke, scope, listFilters(params, scope));
  const page = scopedPage(jobs, params), selected = page.rows as AutomationRecord[];
  delete page.rows;
  return { ...page, jobs: selected, snapshotRevision: revisionFor(jobs), hostedCapabilities: Object.fromEntries(selected.map((job) => [String(job.id), jobCapabilities(job, scope)])) };
}
async function status(invoke: AutomationInvoke, scope: AutomationScope, params: AutomationRecord): Promise<unknown> {
  if (!keys(params, [])) fail(400, "invalid_automation_request");
  const { jobs } = await inventory(invoke, scope);
  const native = automationRecord(await invoke("cron.status", {}));
  if (!native || typeof native.enabled !== "boolean" || typeof native.triggersEnabled !== "boolean") fail(502, "invalid_native_automation_status");
  const next = jobs.filter((job) => job.enabled).map((job) => automationRecord(job.state)?.nextRunAtMs).filter((value): value is number => integer(value));
  return { enabled: native.enabled, triggersEnabled: native.triggersEnabled, jobs: jobs.length, nextWakeAtMs: next.length ? Math.min(...next) : null };
}
async function ownedJob(invoke: AutomationInvoke, scope: AutomationScope, id: unknown): Promise<AutomationRecord> {
  if (!string(id) || id.length > 200) fail(400, "invalid_automation_id");
  const { jobs } = await inventory(invoke, scope);
  return jobs.find((job) => job.id === id) ?? fail(404, "not_found");
}
async function get(invoke: AutomationInvoke, scope: AutomationScope, params: AutomationRecord): Promise<unknown> {
  if (!keys(params, ["id"])) fail(400, "invalid_automation_request");
  const current = await ownedJob(invoke, scope, params.id);
  const native = nativeJob(await invoke("cron.get", { id: current.id }));
  const bound = { ...native, effectiveAgentId: current.effectiveAgentId };
  if (native.configRevision !== current.configRevision || !ownsJob(bound, scope)) fail(409, "automation_inventory_changed");
  return native;
}
const RUN_FIELDS = ["id", "agentId", "scope", "runId", "limit", "offset", "statuses", "status", "deliveryStatuses", "deliveryStatus", "query", "sortDir"];
function runJobs(params: AutomationRecord, snapshot: Inventory, scope: AutomationScope): AutomationRecord[] {
  const selectedId = params.id;
  const single = params.scope === "job" || selectedId !== undefined;
  if (single && (!string(selectedId) || !snapshot.jobs.some((job) => job.id === selectedId))) fail(404, "not_found");
  const selected = single ? snapshot.jobs.filter((job) => job.id === selectedId) : snapshot.jobs;
  if (single && selected.some((job) => !executionScoped(job, scope))) fail(403, "automation_history_scope_unavailable");
  const jobs = selected.filter((job) => executionScoped(job, scope));
  return jobs;
}
async function runs(invoke: AutomationInvoke, scope: AutomationScope, params: AutomationRecord): Promise<unknown> {
  if (!keys(params, RUN_FIELDS) || (params.agentId !== undefined && params.agentId !== agentId(scope)) || (params.scope !== undefined && params.scope !== "all" && params.scope !== "job")) fail(400, "invalid_automation_scope");
  pageParams(params);
  const snapshot = await inventory(invoke, scope);
  const jobs = runJobs(params, snapshot, scope);
  const filters = { ...params };
  for (const key of ["id", "scope", "agentId", "offset", "limit"]) delete filters[key];
  const entries: AutomationRecord[] = [];
  const allowedJobIds = new Set(jobs.map((job) => String(job.id)));
  await readScopedRuns(invoke, scope, allowedJobIds, filters, entries);
  const check = await inventory(invoke, scope);
  if (check.revision !== snapshot.revision) fail(409, "automation_inventory_changed");
  const page = scopedPage(entries, params), rows = page.rows as AutomationRecord[];
  delete page.rows;
  return { ...page, entries: rows, hostedCapabilities: Object.fromEntries(rows.map((entry) => [String(entry.jobId), { history: true }])) };
}
function runEntry(value: unknown, scope: AutomationScope): AutomationRecord {
  const entry = automationRecord(value);
  if (!entry || !string(entry.jobId) || !integer(entry.ts) || (entry.sessionKey !== undefined && sessionAgent(entry.sessionKey) !== agentId(scope))) fail(502, "invalid_native_automation_history");
  return entry;
}
interface NativeRunsPage { entries: AutomationRecord[]; total: number; next: number | null; fingerprint: string }
function readRunsPage(value: unknown, offset: number, expectedTotal?: number): NativeRunsPage {
  const raw = automationRecord(value);
  if (expectedTotal !== undefined && integer(raw?.total) && raw.total !== expectedTotal) fail(409, "automation_history_changed");
  const page = pageMetadata(value, offset, "invalid_native_automation_history");
  if (!Array.isArray(page.entries) || page.limit !== PAGE_SIZE) fail(502, "invalid_native_automation_history");
  if (page.total > MAX_RUN_ENTRIES) fail(503, "automation_history_limit");
  if (page.entries.length !== Math.min(PAGE_SIZE, page.total - offset)) fail(502, "invalid_native_automation_history");
  const next = validateCursor(page, page.entries.length, "invalid_native_automation_history");
  const entries = page.entries.map((value) => {
    const entry = automationRecord(value);
    if (!entry || !string(entry.jobId) || !integer(entry.ts)) fail(502, "invalid_native_automation_history");
    return entry;
  });
  return { entries, total: page.total, next, fingerprint: revisionFor(entries) };
}
async function readScopedRuns(invoke: AutomationInvoke, scope: AutomationScope, allowedJobIds: Set<string>, filters: AutomationRecord, entries: AutomationRecord[]): Promise<void> {
  const base = { ...filters, scope: "all", agentId: agentId(scope), limit: PAGE_SIZE };
  const pages: { offset: number; fingerprint: string }[] = [];
  let offset: number | null = 0, total: number | undefined;
  while (offset !== null) {
    const page = readRunsPage(await invoke("cron.runs", { ...base, offset }), offset, total);
    total = page.total;
    pages.push({ offset, fingerprint: page.fingerprint });
    for (const entry of page.entries) {
      if (allowedJobIds.has(String(entry.jobId))) entries.push(runEntry(entry, scope));
    }
    offset = page.next;
  }
  if (pages.length === 1) return;
  for (const snapshot of pages) {
    const page = readRunsPage(await invoke("cron.runs", { ...base, offset: snapshot.offset }), snapshot.offset, total);
    if (page.fingerprint !== snapshot.fingerprint) fail(409, "automation_history_changed");
  }
}
const METHODS = new Set(["automations.context", "cron.list", "cron.status", "cron.get", "cron.add", "cron.update", "cron.run", "cron.remove", "cron.runs"]);
export async function executeAutomation(invoke: AutomationInvoke, scope: AutomationScope, body: AutomationRecord): Promise<unknown> {
  const method = body.method, params = body.params === undefined ? {} : automationRecord(body.params);
  if (typeof method !== "string" || !METHODS.has(method)) fail(400, "unsupported_automation_operation");
  if (!keys(body, ["method", "params"]) || !params) fail(400, "invalid_automation_request");
  if (method === "automations.context") {
    if (!keys(params, [])) fail(400, "invalid_automation_request");
    return context(scope);
  }
  if (method === "cron.list") return list(invoke, scope, params);
  if (method === "cron.status") return status(invoke, scope, params);
  if (["cron.add", "cron.update", "cron.run", "cron.remove"].includes(method)) fail(403, "automation_read_only");
  if (method === "cron.runs") return runs(invoke, scope, params);
  return get(invoke, scope, params);
}
