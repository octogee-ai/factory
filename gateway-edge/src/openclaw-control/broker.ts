import { internalFetch } from "../lib/internal-fetch.js";

export interface OpenClawControlRedemptionResponse {
  uid: string;
  gatewayId: string;
  revisionId: string;
  expiresAt: number;
}

export type OpenClawControlAuditCategory =
  | "read"
  | "config_mutation"
  | "tools_invoke"
  | "forbidden_mutation"
  | "unknown";

export type OpenClawControlAuditReason =
  | "none"
  | "method_denied"
  | "rate_limited"
  | "upstream_unavailable"
  | "protocol_invalid";

function baseUrl(env: NodeJS.ProcessEnv): string {
  const value = env.OPENCLAW_CONTROL_BROKER_URL ?? env.OCTOGEE_API_URL;
  if (!value?.trim()) throw new Error("OPENCLAW_CONTROL_BROKER_URL or OCTOGEE_API_URL is required");
  return value.trim().replace(/\/$/u, "");
}

async function post(
  path: string,
  body: Record<string, unknown>,
  env: NodeJS.ProcessEnv,
  fetchImpl?: typeof fetch,
): Promise<Response> {
  return internalFetch(`${baseUrl(env)}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(5_000),
  }, { fetchImpl });
}

function boundedIdentifier(value: unknown, maxLength: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength;
}

function validRedemptionResponse(value: unknown): value is OpenClawControlRedemptionResponse {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  return boundedIdentifier(item.uid, 256) &&
    boundedIdentifier(item.gatewayId, 128) &&
    boundedIdentifier(item.revisionId, 128) &&
    typeof item.expiresAt === "number" &&
    Number.isFinite(item.expiresAt) &&
    item.expiresAt > 0;
}

export async function redeemOpenClawControlTicket(args: {
  ticket: string;
  sessionId: string;
  gatewayId: string;
  revisionId: string;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
}): Promise<OpenClawControlRedemptionResponse | null> {
  const res = await post("/internal/openclaw-control/redeem", {
    gatewayId: args.gatewayId,
    revisionId: args.revisionId,
    sessionId: args.sessionId,
    ticket: args.ticket,
  }, args.env ?? process.env, args.fetchImpl);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`OpenClaw Control ticket broker returned ${res.status}`);
  const body = await res.json() as unknown;
  if (!validRedemptionResponse(body)) {
    throw new Error("OpenClaw Control ticket broker returned invalid JSON");
  }
  return {
    uid: body.uid,
    gatewayId: body.gatewayId,
    revisionId: body.revisionId,
    expiresAt: body.expiresAt,
  };
}

export async function authorizeOpenClawControlSession(args: {
  gatewayId: string;
  revisionId: string;
  sessionId: string;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
}): Promise<boolean> {
  const res = await post("/internal/openclaw-control/authorize", {
    gatewayId: args.gatewayId,
    revisionId: args.revisionId,
    sessionId: args.sessionId,
  }, args.env ?? process.env, args.fetchImpl);
  if (res.status === 403 || res.status === 404 || res.status === 409) return false;
  if (res.status !== 204) throw new Error(`OpenClaw Control authorization broker returned ${res.status}`);
  return true;
}

export async function auditOpenClawControlRpc(args: {
  gatewayId: string;
  revisionId: string;
  sessionId: string;
  event: "rpc_allow" | "rpc_deny" | "rpc_result";
  category: OpenClawControlAuditCategory;
  outcome: "ok" | "denied" | "error";
  reason: OpenClawControlAuditReason;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
}): Promise<void> {
  const res = await post("/internal/openclaw-control/audit", {
    gatewayId: args.gatewayId,
    revisionId: args.revisionId,
    sessionId: args.sessionId,
    events: [{
      event: args.event,
      methodCategory: args.category,
      outcome: args.outcome,
      reason: args.reason,
    }],
  }, args.env ?? process.env, args.fetchImpl);
  if (res.status !== 204) throw new Error(`OpenClaw Control audit broker returned ${res.status}`);
}
