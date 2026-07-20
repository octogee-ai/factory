import { Router, type Request, type Response } from "express";

import { isValidGatewayId } from "@octogee/shared/types/glm";
import {
  AUTOMATION_OPENCLAW_CONNECT_TIMEOUT_MS,
  AUTOMATION_OPENCLAW_RPC_TIMEOUT_MS,
} from "@octogee/shared/types/automations";
import { acquireSystemConfigMutationLease } from "@octogee/core/system-config-mutation-lease";

import { attachUpstreamRpcClient } from "../chat-proxy/openclaw/bridge-upstream-rpc.js";
import { openAuthenticatedUpstream } from "../chat-proxy/openclaw/authenticated-upstream.js";
import {
  authorizeAutomationOwner,
  type AutomationAuthorizationOutcome,
} from "../lib/automation-authorization-broker.js";
import { db } from "../lib/db.js";
import type { ResolvedGateway } from "../lib/user-gateway.js";

const MAX_CRON_NAME_LENGTH = 160;
const MAX_CRON_PROMPT_LENGTH = 20_000;
const MAX_CRON_INTERVAL_MS = 365 * 24 * 60 * 60 * 1_000;

const HEARTBEAT_FIELDS = new Set([
  "every",
  "activeHours",
  "model",
  "session",
  "target",
  "to",
  "accountId",
  "prompt",
  "ackMaxChars",
  "suppressToolErrorWarnings",
  "timeoutSeconds",
  "lightContext",
  "isolatedSession",
  "skipWhenBusy",
  "includeReasoning",
]);

const HEARTBEAT_STRING_FIELDS = new Set([
  "every",
  "model",
  "session",
  "target",
  "to",
  "accountId",
  "prompt",
]);

const HEARTBEAT_BOOLEAN_FIELDS = new Set([
  "suppressToolErrorWarnings",
  "lightContext",
  "isolatedSession",
  "skipWhenBusy",
  "includeReasoning",
]);

const HEARTBEAT_NUMBER_FIELDS = new Set(["ackMaxChars", "timeoutSeconds"]);

export interface AutomationHeartbeat {
  every: string;
  activeHours?: { start?: string; end?: string; timezone?: string };
  model?: string;
  session?: string;
  target?: string;
  to?: string;
  accountId?: string;
  prompt?: string;
  ackMaxChars?: number;
  suppressToolErrorWarnings?: boolean;
  timeoutSeconds?: number;
  lightContext?: boolean;
  isolatedSession?: boolean;
  skipWhenBusy?: boolean;
  includeReasoning?: boolean;
}

export interface AutomationsRouterDeps {
  authorizeOwner(input: {
    gatewayId: string;
    authorization?: string;
    uid: string;
  }): Promise<AutomationAuthorizationOutcome>;
  localGatewayId(): string | null;
  openclawDir(): string;
  resolveCoachChannelId(slug: string): Promise<string>;
  invoke(method: string, params: Record<string, unknown>): Promise<unknown>;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function requestedGatewayId(req: Request): string | null {
  const gatewayId = (req.params as { gatewayId?: unknown }).gatewayId;
  return isValidGatewayId(gatewayId) ? gatewayId : null;
}

function heartbeatFromConfig(config: unknown, agentId: string): AutomationHeartbeat | null {
  const agents = record(config)?.agents;
  const list = record(agents)?.list;
  if (!Array.isArray(list)) return null;
  const agent = list.find((candidate) => record(candidate)?.id === agentId);
  const heartbeat = record(record(agent)?.heartbeat);
  if (!heartbeat) return null;
  return sanitizeHeartbeat(Object.fromEntries(
    Object.entries(heartbeat).filter(([key]) => HEARTBEAT_FIELDS.has(key)),
  ));
}

function validActiveHours(value: unknown): value is NonNullable<AutomationHeartbeat["activeHours"]> {
  const activeHours = record(value);
  if (!activeHours) return false;
  const allowed = new Set(["start", "end", "timezone"]);
  return Object.entries(activeHours).every(
    ([key, entry]) => allowed.has(key) && typeof entry === "string",
  );
}

export function sanitizeHeartbeat(value: unknown): AutomationHeartbeat | null {
  const heartbeat = record(value);
  if (!heartbeat || typeof heartbeat.every !== "string" || !heartbeat.every.trim()) return null;
  for (const [key, entry] of Object.entries(heartbeat)) {
    if (!validHeartbeatField(key, entry)) return null;
  }
  return heartbeat as unknown as AutomationHeartbeat;
}

function validHeartbeatField(key: string, value: unknown): boolean {
  if (!HEARTBEAT_FIELDS.has(key)) return false;
  if (HEARTBEAT_STRING_FIELDS.has(key)) return typeof value === "string";
  if (HEARTBEAT_BOOLEAN_FIELDS.has(key)) return typeof value === "boolean";
  if (HEARTBEAT_NUMBER_FIELDS.has(key)) return typeof value === "number" && Number.isInteger(value) && value >= 0;
  return key !== "activeHours" || validActiveHours(value);
}

function coachAgentId(slug: string): string {
  return `octogee-${slug}-coach`;
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}

function everyCronSchedule(schedule: Record<string, unknown>): Record<string, unknown> | null {
  const everyMs = schedule.everyMs;
  if (!hasOnlyKeys(schedule, ["kind", "everyMs"]) || typeof everyMs !== "number" || !Number.isInteger(everyMs)) return null;
  return everyMs >= 60_000 && everyMs <= MAX_CRON_INTERVAL_MS ? { kind: "every", everyMs } : null;
}

function expressionCronSchedule(schedule: Record<string, unknown>): Record<string, unknown> | null {
  const expr = nonEmptyString(schedule.expr);
  if (!hasOnlyKeys(schedule, ["kind", "expr", "tz"]) || !expr || expr.length > 200) return null;
  if (schedule.tz !== undefined && (typeof schedule.tz !== "string" || schedule.tz.length > 100)) return null;
  return { kind: "cron", expr, ...(schedule.tz ? { tz: schedule.tz } : {}) };
}

function atCronSchedule(schedule: Record<string, unknown>): Record<string, unknown> | null {
  const at = nonEmptyString(schedule.at);
  if (!hasOnlyKeys(schedule, ["kind", "at"]) || !at || Number.isNaN(Date.parse(at))) return null;
  return { kind: "at", at };
}

const CRON_SCHEDULES: Record<string, (schedule: Record<string, unknown>) => Record<string, unknown> | null> = {
  every: everyCronSchedule,
  cron: expressionCronSchedule,
  at: atCronSchedule,
};

function cronSchedule(value: unknown): Record<string, unknown> | null {
  const schedule = record(value);
  if (!schedule || typeof schedule.kind !== "string") return null;
  return CRON_SCHEDULES[schedule.kind]?.(schedule) ?? null;
}

function cronPayload(value: unknown): Record<string, unknown> | null {
  const payload = record(value);
  if (!payload || !hasOnlyKeys(payload, ["kind", "message"])) return null;
  const message = nonEmptyString(payload.message);
  if (payload.kind !== "agentTurn" || !message || message.length > MAX_CRON_PROMPT_LENGTH) return null;
  return { kind: "agentTurn", message };
}

interface CoachDeliveryTarget {
  accountId: string;
  to: string;
}

function cronDelivery(
  value: unknown,
  coachTarget?: CoachDeliveryTarget,
): Record<string, unknown> | null {
  if (value === undefined) return { mode: "none" };
  const delivery = record(value);
  if (!delivery || typeof delivery.mode !== "string") return null;
  if (delivery.mode === "none" && hasOnlyKeys(delivery, ["mode"])) return { mode: "none" };
  if (delivery.mode === "announce" && hasOnlyKeys(delivery, ["mode", "channel", "to", "accountId"])) {
    return {
      mode: "announce",
      channel: "mattermost",
      ...(coachTarget ?? { to: "channel:coach" }),
    };
  }
  return null;
}

function cronState(value: unknown): Record<string, unknown> | null {
  const state = record(value);
  if (!state) return null;
  const next: Record<string, unknown> = {};
  if (typeof state.nextRunAtMs === "number") next.nextRunAtMs = state.nextRunAtMs;
  if (state.lastRunStatus === "ok" || state.lastRunStatus === "error" || state.lastRunStatus === "skipped") {
    next.lastRunStatus = state.lastRunStatus;
  }
  if (typeof state.lastError === "string") next.lastError = state.lastError;
  return Object.keys(next).length > 0 ? next : null;
}

function automationJob(value: unknown, agentId: string): Record<string, unknown> | null {
  const job = record(value);
  const id = nonEmptyString(job?.id);
  const name = nonEmptyString(job?.name);
  const schedule = cronSchedule(job?.schedule);
  const payload = cronPayload(job?.payload);
  if (!job || job.agentId !== agentId || !id || !name || typeof job.enabled !== "boolean" || !schedule || !payload) {
    return null;
  }
  const state = cronState(job.state);
  return {
    id,
    name,
    ...(typeof job.description === "string" ? { description: job.description } : {}),
    enabled: job.enabled,
    schedule,
    sessionTarget: "isolated",
    wakeMode: "now",
    payload,
    delivery: cronDelivery(job.delivery) ?? { mode: "none" },
    ...(state ? { state } : {}),
  };
}

function cronDefinition(
  value: unknown,
  agentId: string,
  coachTarget?: CoachDeliveryTarget,
): Record<string, unknown> | null {
  const definition = record(value);
  if (!definition) return null;
  const name = nonEmptyString(definition.name);
  const schedule = cronSchedule(definition.schedule);
  const payload = cronPayload(definition.payload);
  const delivery = cronDelivery(definition.delivery, coachTarget);
  if (!name || name.length > MAX_CRON_NAME_LENGTH || typeof definition.enabled !== "boolean" || !schedule || !payload || !delivery) {
    return null;
  }
  const description = definition.description;
  if (description !== undefined && (typeof description !== "string" || description.length > MAX_CRON_PROMPT_LENGTH)) return null;
  return {
    agentId,
    name,
    ...(description ? { description } : {}),
    enabled: definition.enabled,
    schedule,
    sessionTarget: "isolated",
    wakeMode: "now",
    payload,
    delivery,
  };
}

type CronPatchWriter = (patch: Record<string, unknown>, next: Record<string, unknown>) => boolean;

function writeNamePatch(patch: Record<string, unknown>, next: Record<string, unknown>): boolean {
  if (!Object.hasOwn(patch, "name")) return true;
  const name = nonEmptyString(patch.name);
  if (!name || name.length > MAX_CRON_NAME_LENGTH) return false;
  next.name = name;
  return true;
}

function writeDescriptionPatch(patch: Record<string, unknown>, next: Record<string, unknown>): boolean {
  if (!Object.hasOwn(patch, "description")) return true;
  if (patch.description !== null && (typeof patch.description !== "string" || patch.description.length > MAX_CRON_PROMPT_LENGTH)) return false;
  next.description = patch.description;
  return true;
}

function writeEnabledPatch(patch: Record<string, unknown>, next: Record<string, unknown>): boolean {
  if (!Object.hasOwn(patch, "enabled")) return true;
  if (typeof patch.enabled !== "boolean") return false;
  next.enabled = patch.enabled;
  return true;
}

function writeSchedulePatch(patch: Record<string, unknown>, next: Record<string, unknown>): boolean {
  if (!Object.hasOwn(patch, "schedule")) return true;
  const schedule = cronSchedule(patch.schedule);
  if (!schedule) return false;
  next.schedule = schedule;
  return true;
}

function writePayloadPatch(patch: Record<string, unknown>, next: Record<string, unknown>): boolean {
  if (!Object.hasOwn(patch, "payload")) return true;
  const payload = cronPayload(patch.payload);
  if (!payload) return false;
  next.payload = payload;
  return true;
}

function writeDeliveryPatch(
  patch: Record<string, unknown>,
  next: Record<string, unknown>,
  coachTarget?: CoachDeliveryTarget,
): boolean {
  if (!Object.hasOwn(patch, "delivery")) return true;
  const delivery = cronDelivery(patch.delivery, coachTarget);
  if (!delivery) return false;
  next.delivery = delivery;
  return true;
}

const CRON_PATCH_WRITERS: CronPatchWriter[] = [
  writeNamePatch,
  writeDescriptionPatch,
  writeEnabledPatch,
  writeSchedulePatch,
  writePayloadPatch,
];

function cronPatch(value: unknown, coachTarget?: CoachDeliveryTarget): Record<string, unknown> | null {
  const patch = record(value);
  if (!patch || !hasOnlyKeys(patch, ["name", "description", "enabled", "schedule", "payload", "delivery"])) return null;
  const next: Record<string, unknown> = {};
  const valid = CRON_PATCH_WRITERS.every((writer) => writer(patch, next)) &&
    writeDeliveryPatch(patch, next, coachTarget);
  return valid && Object.keys(next).length > 0 ? next : null;
}

function cronId(params: Record<string, unknown>): string | null {
  const id = nonEmptyString(params.id);
  return id && id.length <= 200 ? id : null;
}

function jobFromResult(value: unknown): Record<string, unknown> | null {
  const result = record(value);
  if (!result) return null;
  return record(result.job) ?? result;
}

async function callerJob(
  deps: Pick<AutomationsRouterDeps, "invoke">,
  id: string,
  agentId: string,
): Promise<Record<string, unknown> | null> {
  const result = await deps.invoke("cron.get", { id });
  return automationJob(jobFromResult(result), agentId);
}

async function authorize(
  req: Request,
  res: Response,
  deps: Pick<AutomationsRouterDeps, "authorizeOwner" | "localGatewayId">,
): Promise<ResolvedGateway | null> {
  const gatewayId = requestedGatewayId(req);
  if (!gatewayId || deps.localGatewayId() !== gatewayId) {
    res.status(404).json({ error: "not_found" });
    return null;
  }
  const outcome = await deps.authorizeOwner({
    gatewayId,
    authorization: req.headers.authorization,
    uid: req.uid!,
  });
  if (outcome.kind === "unauthenticated") {
    res.status(401).json({ error: "Unauthenticated" });
    return null;
  }
  if (outcome.kind === "not_found") {
    res.status(404).json({ error: "not_found" });
    return null;
  }
  if (outcome.kind === "forbidden") {
    res.status(403).json({ error: "forbidden" });
    return null;
  }
  return { slug: outcome.slug, gatewayId: outcome.gatewayId };
}

interface BrokerResponse {
  status: number;
  body: Record<string, unknown>;
}

function brokerResult(result: unknown): BrokerResponse {
  return { status: 200, body: { result } };
}

function brokerError(status: number, error: string): BrokerResponse {
  return { status, body: { error } };
}

const AUTOMATION_METHODS = new Set([
  "cron.list",
  "cron.runs",
  "cron.add",
  "cron.update",
  "cron.run",
  "heartbeat.get",
  "heartbeat.update",
]);

function cronJobOperation(method: string): boolean {
  return ["cron.update", "cron.run", "cron.runs"].includes(method);
}

async function listCronJobs(deps: AutomationsRouterDeps, agentId: string): Promise<BrokerResponse> {
  const result = record(await deps.invoke("cron.list", {
    agentId,
    includeDisabled: true,
    limit: 200,
    sortBy: "updatedAtMs",
    sortDir: "desc",
  }));
  const jobs = (Array.isArray(result?.jobs) ? result.jobs : [])
    .map((job) => automationJob(job, agentId))
    .filter((job): job is Record<string, unknown> => job !== null);
  return brokerResult({ jobs });
}

async function addCronJob(
  deps: AutomationsRouterDeps,
  params: Record<string, unknown> | null,
  agentId: string,
  slug: string,
): Promise<BrokerResponse> {
  const coachTarget = await coachDeliveryTarget(deps, params?.delivery, slug);
  const definition = cronDefinition(params, agentId, coachTarget);
  return definition
    ? brokerResult(await deps.invoke("cron.add", definition))
    : brokerError(400, "invalid automation definition");
}

async function coachDeliveryTarget(
  deps: AutomationsRouterDeps,
  delivery: unknown,
  slug: string,
): Promise<CoachDeliveryTarget | undefined> {
  if (cronDelivery(delivery)?.mode !== "announce") return undefined;
  const channelId = await deps.resolveCoachChannelId(slug);
  return { accountId: `${slug}-coach`, to: `channel:${channelId}` };
}

async function existingCronJobOperation(
  deps: AutomationsRouterDeps,
  method: string,
  params: Record<string, unknown> | null,
  agentId: string,
  slug: string,
): Promise<BrokerResponse> {
  const id = params ? cronId(params) : null;
  if (!params || !id) return brokerError(400, "invalid automation id");
  const current = await callerJob(deps, id, agentId);
  if (!current) return brokerError(404, "not_found");
  if (method === "cron.update") return updateCronJob(deps, id, params, slug);
  if (method === "cron.run") return brokerResult(await deps.invoke("cron.run", { id, mode: "force" }));
  return brokerResult(await deps.invoke("cron.runs", { id, limit: 20, sortDir: "desc" }));
}

async function updateCronJob(
  deps: AutomationsRouterDeps,
  id: string,
  params: Record<string, unknown>,
  slug: string,
): Promise<BrokerResponse> {
  const patchValue = record(params.patch);
  const coachTarget = await coachDeliveryTarget(deps, patchValue?.delivery, slug);
  const patch = cronPatch(params.patch, coachTarget);
  return patch
    ? brokerResult(await deps.invoke("cron.update", { id, patch }))
    : brokerError(400, "invalid automation update");
}

async function heartbeatGet(deps: AutomationsRouterDeps, agentId: string): Promise<BrokerResponse> {
  const configResult = record(await deps.invoke("config.get", {}));
  const hash = nonEmptyString(configResult?.hash);
  if (!configResult || !hash) throw new Error("config.get returned no config hash");
  return brokerResult({ hash, heartbeat: heartbeatFromConfig(configResult.config, agentId) });
}

async function heartbeatUpdate(
  deps: AutomationsRouterDeps,
  body: Record<string, unknown>,
  agentId: string,
): Promise<BrokerResponse> {
  const baseHash = nonEmptyString(body.baseHash);
  const heartbeat = sanitizeHeartbeat(body.heartbeat);
  if (!baseHash || !heartbeat) return brokerError(400, "invalid heartbeat update");
  const patch = { agents: { list: [{ id: agentId, heartbeat }] } };
  const acquired = await acquireSystemConfigMutationLease({ openclawDir: deps.openclawDir() });
  if (!acquired.ok) {
    throw new Error("system config writer lock is busy");
  }
  try {
    return brokerResult(await deps.invoke("config.patch", { raw: JSON.stringify(patch), baseHash }));
  } finally {
    await acquired.lease.release();
  }
}

async function automationResponse(
  body: Record<string, unknown>,
  resolved: ResolvedGateway,
  deps: AutomationsRouterDeps,
): Promise<BrokerResponse> {
  const method = typeof body.method === "string" ? body.method : "";
  if (!AUTOMATION_METHODS.has(method)) return brokerError(400, "unsupported automation operation");
  const agentId = coachAgentId(resolved.slug);
  if (method === "cron.list") return listCronJobs(deps, agentId);
  const params = record(body.params);
  if (method === "cron.add") return addCronJob(deps, params, agentId, resolved.slug);
  if (cronJobOperation(method)) return existingCronJobOperation(deps, method, params, agentId, resolved.slug);
  if (method === "heartbeat.get") return heartbeatGet(deps, agentId);
  if (method === "heartbeat.update") return heartbeatUpdate(deps, body, agentId);
  return brokerError(400, "unsupported automation operation");
}

export function createAutomationsRouter(deps: AutomationsRouterDeps): Router {
  const router = Router({ mergeParams: true });

  router.post("/rpc", async (req, res, next) => {
    try {
      const resolved = await authorize(req, res, deps);
      if (!resolved) return;
      const body = record(req.body);
      if (!body) {
        res.status(400).json({ error: "invalid automation request" });
        return;
      }
      const response = await automationResponse(body, resolved, deps);
      res.status(response.status).json(response.body);
    } catch (error) {
      next(error);
    }
  });

  return router;
}

export interface LocalAutomationOpenClawDeps {
  gatewayId(): string;
  gatewayUrl(): string;
  openAuthenticatedUpstream: typeof openAuthenticatedUpstream;
  attachRpcClient: typeof attachUpstreamRpcClient;
}

const localAutomationOpenClawDeps: LocalAutomationOpenClawDeps = {
  gatewayId: () => process.env.GATEWAY_ID ?? "",
  gatewayUrl: () => process.env.OPENCLAW_GATEWAY_URL ?? "http://127.0.0.1:18789",
  openAuthenticatedUpstream,
  attachRpcClient: attachUpstreamRpcClient,
};

export async function invokeLocalOpenClaw(
  method: string,
  params: Record<string, unknown>,
  deps: LocalAutomationOpenClawDeps = localAutomationOpenClawDeps,
): Promise<unknown> {
  const gatewayId = deps.gatewayId();
  if (!isValidGatewayId(gatewayId)) throw new Error("GATEWAY_ID is required for automation broker");
  const ws = await deps.openAuthenticatedUpstream({
    gatewayId,
    url: deps.gatewayUrl(),
    timeoutMs: AUTOMATION_OPENCLAW_CONNECT_TIMEOUT_MS,
  });
  const rpc = deps.attachRpcClient(ws, { timeoutMs: AUTOMATION_OPENCLAW_RPC_TIMEOUT_MS });
  try {
    const result = await rpc.call(method, params);
    if (!result.ok) throw new Error(`automation broker ${method} failed: ${result.reason}`);
    return result.result;
  } finally {
    rpc.dispose();
    ws.close();
  }
}

async function resolveStoredCoachChannelId(slug: string): Promise<string> {
  const snapshot = await db.doc(`workspaces/${slug}/channels/coach-dm`).get();
  const channelId = nonEmptyString(record(snapshot.data()?.mattermost)?.channelId);
  if (!channelId) throw new Error(`coach Mattermost channel is not provisioned for ${slug}`);
  return channelId;
}

const automationsRouter = createAutomationsRouter({
  authorizeOwner: authorizeAutomationOwner,
  localGatewayId: () => process.env.GATEWAY_ID ?? null,
  openclawDir: () => process.env.OPENCLAW_DIR ?? "/home/node/.openclaw",
  resolveCoachChannelId: resolveStoredCoachChannelId,
  invoke: invokeLocalOpenClaw,
});

export default automationsRouter;
