import { Router, type Request, type Response } from "express";

import { isValidGatewayId } from "@octogee/shared/types/glm";
import { generateIdentity, type DeviceIdentity } from "@octogee/shared/types/device-identity";

import { attachUpstreamRpcClient } from "../chat-proxy/openclaw/bridge-upstream-rpc.js";
import { fetchGatewayAuth, persistGatewayDeviceToken } from "../chat-proxy/openclaw/gateway-token.js";
import { openUpstream } from "../chat-proxy/openclaw/upstream.js";
import { resolveUserGateway, type ResolvedGateway } from "../lib/user-gateway.js";

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
  resolveUserGateway(uid: string): Promise<ResolvedGateway | null>;
  localGatewayId(): string | null;
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
    if (!HEARTBEAT_FIELDS.has(key)) return null;
    if (HEARTBEAT_STRING_FIELDS.has(key) && typeof entry !== "string") return null;
    if (HEARTBEAT_BOOLEAN_FIELDS.has(key) && typeof entry !== "boolean") return null;
    if (
      HEARTBEAT_NUMBER_FIELDS.has(key) &&
      (typeof entry !== "number" || !Number.isInteger(entry) || entry < 0)
    ) return null;
    if (key === "activeHours" && !validActiveHours(entry)) return null;
  }
  return heartbeat as unknown as AutomationHeartbeat;
}

function coachAgentId(slug: string): string {
  return `octogee-${slug}-coach`;
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}

function cronSchedule(value: unknown): Record<string, unknown> | null {
  const schedule = record(value);
  if (!schedule || typeof schedule.kind !== "string") return null;
  if (schedule.kind === "every") {
    if (!hasOnlyKeys(schedule, ["kind", "everyMs"])) return null;
    const everyMs = schedule.everyMs;
    if (
      typeof everyMs !== "number" ||
      !Number.isInteger(everyMs) ||
      everyMs < 60_000 ||
      everyMs > MAX_CRON_INTERVAL_MS
    ) return null;
    return { kind: "every", everyMs };
  }
  if (schedule.kind === "cron") {
    if (!hasOnlyKeys(schedule, ["kind", "expr", "tz"])) return null;
    const expr = nonEmptyString(schedule.expr);
    if (!expr || expr.length > 200) return null;
    if (schedule.tz !== undefined && (typeof schedule.tz !== "string" || schedule.tz.length > 100)) return null;
    return { kind: "cron", expr, ...(schedule.tz ? { tz: schedule.tz } : {}) };
  }
  if (schedule.kind === "at") {
    if (!hasOnlyKeys(schedule, ["kind", "at"])) return null;
    const at = nonEmptyString(schedule.at);
    if (!at || Number.isNaN(Date.parse(at))) return null;
    return { kind: "at", at };
  }
  return null;
}

function cronPayload(value: unknown): Record<string, unknown> | null {
  const payload = record(value);
  if (!payload || !hasOnlyKeys(payload, ["kind", "message"])) return null;
  const message = nonEmptyString(payload.message);
  if (payload.kind !== "agentTurn" || !message || message.length > MAX_CRON_PROMPT_LENGTH) return null;
  return { kind: "agentTurn", message };
}

function cronDelivery(value: unknown): Record<string, unknown> | null {
  if (value === undefined) return { mode: "none" };
  const delivery = record(value);
  if (!delivery || typeof delivery.mode !== "string") return null;
  if (delivery.mode === "none" && hasOnlyKeys(delivery, ["mode"])) return { mode: "none" };
  if (delivery.mode === "announce" && hasOnlyKeys(delivery, ["mode", "channel", "to"])) {
    return { mode: "announce", channel: "mattermost", to: "channel:coach" };
  }
  return null;
}

function cronDefinition(value: unknown, agentId: string): Record<string, unknown> | null {
  const definition = record(value);
  if (!definition) return null;
  const name = nonEmptyString(definition.name);
  const schedule = cronSchedule(definition.schedule);
  const payload = cronPayload(definition.payload);
  const delivery = cronDelivery(definition.delivery);
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

function cronPatch(value: unknown): Record<string, unknown> | null {
  const patch = record(value);
  if (!patch || !hasOnlyKeys(patch, ["name", "description", "enabled", "schedule", "payload", "delivery"])) return null;
  const next: Record<string, unknown> = {};
  if (Object.hasOwn(patch, "name")) {
    const name = nonEmptyString(patch.name);
    if (!name || name.length > MAX_CRON_NAME_LENGTH) return null;
    next.name = name;
  }
  if (Object.hasOwn(patch, "description")) {
    if (patch.description !== null && (typeof patch.description !== "string" || patch.description.length > MAX_CRON_PROMPT_LENGTH)) return null;
    next.description = patch.description;
  }
  if (Object.hasOwn(patch, "enabled")) {
    if (typeof patch.enabled !== "boolean") return null;
    next.enabled = patch.enabled;
  }
  if (Object.hasOwn(patch, "schedule")) {
    const schedule = cronSchedule(patch.schedule);
    if (!schedule) return null;
    next.schedule = schedule;
  }
  if (Object.hasOwn(patch, "payload")) {
    const payload = cronPayload(patch.payload);
    if (!payload) return null;
    next.payload = payload;
  }
  if (Object.hasOwn(patch, "delivery")) {
    const delivery = cronDelivery(patch.delivery);
    if (!delivery) return null;
    next.delivery = delivery;
  }
  return Object.keys(next).length > 0 ? next : null;
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
): Promise<{ result: unknown; job: Record<string, unknown> } | null> {
  const result = await deps.invoke("cron.get", { id });
  const job = jobFromResult(result);
  return job?.agentId === agentId && cronPayload(job.payload) ? { result, job } : null;
}

async function authorize(
  req: Request,
  res: Response,
  deps: Pick<AutomationsRouterDeps, "resolveUserGateway" | "localGatewayId">,
): Promise<ResolvedGateway | null> {
  const gatewayId = requestedGatewayId(req);
  if (!gatewayId || deps.localGatewayId() !== gatewayId) {
    res.status(404).json({ error: "not_found" });
    return null;
  }
  const resolved = await deps.resolveUserGateway(req.uid!);
  if (!resolved || resolved.gatewayId !== gatewayId) {
    res.status(404).json({ error: "not_found" });
    return null;
  }
  return resolved;
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
      const agentId = coachAgentId(resolved.slug);
      if (body.method === "cron.list") {
        res.json({
          result: await deps.invoke("cron.list", {
            agentId,
            includeDisabled: true,
            limit: 200,
            sortBy: "updatedAtMs",
            sortDir: "desc",
          }),
        });
        return;
      }
      const cronParams = record(body.params);
      if (body.method === "cron.add") {
        const definition = cronDefinition(cronParams, agentId);
        if (!definition) {
          res.status(400).json({ error: "invalid automation definition" });
          return;
        }
        res.json({ result: await deps.invoke("cron.add", definition) });
        return;
      }
      if (
        body.method === "cron.get" ||
        body.method === "cron.update" ||
        body.method === "cron.remove" ||
        body.method === "cron.run" ||
        body.method === "cron.runs"
      ) {
        const id = cronParams ? cronId(cronParams) : null;
        if (!cronParams || !id) {
          res.status(400).json({ error: "invalid automation id" });
          return;
        }
        const current = await callerJob(deps, id, agentId);
        if (!current) {
          res.status(404).json({ error: "not_found" });
          return;
        }
        if (body.method === "cron.get") {
          res.json({ result: current.result });
          return;
        }
        if (body.method === "cron.update") {
          const patch = cronPatch(cronParams.patch);
          if (!patch) {
            res.status(400).json({ error: "invalid automation update" });
            return;
          }
          res.json({ result: await deps.invoke("cron.update", { id, patch }) });
          return;
        }
        if (body.method === "cron.remove") {
          res.json({ result: await deps.invoke("cron.remove", { id }) });
          return;
        }
        if (body.method === "cron.run") {
          res.json({ result: await deps.invoke("cron.run", { id, mode: "force" }) });
          return;
        }
        res.json({
          result: await deps.invoke("cron.runs", { id, limit: 20, sortDir: "desc" }),
        });
        return;
      }
      if (body.method === "heartbeat.get") {
        const configResult = record(await deps.invoke("config.get", {}));
        const hash = nonEmptyString(configResult?.hash);
        if (!configResult || !hash) {
          throw new Error("config.get returned no config hash");
        }
        res.json({
          result: {
            hash,
            heartbeat: heartbeatFromConfig(configResult.config, agentId),
          },
        });
        return;
      }
      if (body.method === "heartbeat.update") {
        const baseHash = nonEmptyString(body.baseHash);
        const heartbeat = sanitizeHeartbeat(body.heartbeat);
        if (!baseHash || !heartbeat) {
          res.status(400).json({ error: "invalid heartbeat update" });
          return;
        }
        const patch = {
          agents: {
            list: [{ id: agentId, heartbeat }],
          },
        };
        res.json({
          result: await deps.invoke("config.patch", { raw: JSON.stringify(patch), baseHash }),
        });
        return;
      }
      res.status(400).json({ error: "unsupported automation operation" });
    } catch (error) {
      next(error);
    }
  });

  return router;
}

let upstreamIdentity: DeviceIdentity | null = null;

function identity(): DeviceIdentity {
  upstreamIdentity ??= generateIdentity();
  return upstreamIdentity;
}

async function invokeLocalOpenClaw(method: string, params: Record<string, unknown>): Promise<unknown> {
  const gatewayId = process.env.GATEWAY_ID ?? "";
  if (!isValidGatewayId(gatewayId)) throw new Error("GATEWAY_ID is required for automation broker");
  const auth = await fetchGatewayAuth({ gatewayId, allowLegacyFallback: true });
  const ws = await openUpstream({
    url: process.env.OPENCLAW_GATEWAY_URL ?? "http://127.0.0.1:18789",
    token: auth.token,
    deviceToken: auth.deviceToken,
    identity: identity(),
    onDeviceToken: async (issued) => persistGatewayDeviceToken({ token: issued.deviceToken }),
  });
  const rpc = attachUpstreamRpcClient(ws, { timeoutMs: 30_000 });
  try {
    const result = await rpc.call(method, params);
    if (!result.ok) throw new Error(`automation broker ${method} failed: ${result.reason}`);
    return result.result;
  } finally {
    rpc.dispose();
    ws.close();
  }
}

const automationsRouter = createAutomationsRouter({
  resolveUserGateway,
  localGatewayId: () => process.env.GATEWAY_ID ?? null,
  invoke: invokeLocalOpenClaw,
});

export default automationsRouter;
