import { internalFetch } from "../../lib/internal-fetch.js";
import type { AgentIdentity, ChannelPair } from "./activity-bridge.js";
import type { RunLiveDoc } from "./run-live-doc.js";
import {
  createAgentControlRegistryClient,
  type AgentControlRegistryClient,
} from "./agent-control-registry-client.js";

export interface RedeemedOpenClawWs {
  uid: string;
  gatewayId: string;
  gatewayUrl: string;
  expectedAgentId: string;
}

// Redeem is a three-way outcome, not a nullable success. `revision-unavailable`
// is the octogee-api 502 (gateway-url-unresolved / dead-revision): an EXPECTED,
// distinguishable, retryable signal — the serving revision is not resolvable yet
// (mid-roll or just-retired), so the client must retry after the roll settles,
// NOT see an opaque 500. `unauthorized` folds 401/403/404 (bad/expired ticket,
// wrong gateway) into the 401 the upgrade surface already returns.
export type RedeemOpenClawWsOutcome =
  | { kind: "redeemed"; redeemed: RedeemedOpenClawWs }
  | { kind: "unauthorized" }
  | { kind: "revision-unavailable"; reason: string };

export interface OpenClawRuntimeBroker {
  redeemOpenClawWs(ticketId: string): Promise<RedeemOpenClawWsOutcome>;
  getUserGatewayId(uid: string): Promise<string | null>;
  resolveAgentIdentity(agentId: string): Promise<AgentIdentity | null>;
  resolveChannelPair(primaryChannelId: string): Promise<ChannelPair | null>;
  writeRunLiveDoc(path: string, doc: RunLiveDoc): Promise<void>;
  deleteRunLiveDoc(path: string): Promise<void>;
  resolveChannelOwnerUid(channelId: string): Promise<string | null>;
  resolveOctogeeUidByMmUser(mmUserId: string): Promise<string | null>;
  agentControlRegistry: AgentControlRegistryClient;
}

export class OpenClawRuntimeBrokerError extends Error {
  override readonly name = "OpenClawRuntimeBrokerError";

  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function trimBaseUrl(baseUrl: string): string {
  let base = baseUrl.trim();
  while (base.endsWith("/")) base = base.slice(0, -1);
  return base;
}

function nonBlank(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

export function runtimeBrokerBaseUrlFromEnv(
  env: Record<string, string | undefined> = process.env,
): string {
  const explicit = nonBlank(env.OPENCLAW_RUNTIME_BROKER_URL);
  if (explicit) return explicit;
  throw new Error("OPENCLAW_RUNTIME_BROKER_URL is required");
}

async function readJsonOrNull(res: Response): Promise<Record<string, unknown> | null> {
  try {
    const body = (await res.json()) as unknown;
    return body && typeof body === "object" ? (body as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function stringField(body: Record<string, unknown> | null, name: string): string | null {
  const value = body?.[name];
  return typeof value === "string" && value.length > 0 ? value : null;
}

export function createOpenClawRuntimeBroker(opts: {
  baseUrl: string;
  gatewayId: string;
  fetchImpl?: typeof fetch;
}): OpenClawRuntimeBroker {
  const baseUrl = trimBaseUrl(opts.baseUrl);
  const gatewayId = opts.gatewayId;

  const post = async (
    path: string,
    body: Record<string, unknown>,
    expected: ReadonlySet<number>,
  ): Promise<Response> => {
    const res = await internalFetch(
      `${baseUrl}${path}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ gatewayId, ...body }),
      },
      { fetchImpl: opts.fetchImpl },
    );
    if (!expected.has(res.status)) {
      const details = await readJsonOrNull(res);
      const message = stringField(details, "error") ?? `broker HTTP ${res.status}`;
      throw new OpenClawRuntimeBrokerError(res.status, message);
    }
    return res;
  };

  const postJson = async (
    path: string,
    body: Record<string, unknown>,
    expected: ReadonlySet<number>,
  ): Promise<Record<string, unknown> | null> => {
    const res = await post(path, body, expected);
    if (res.status === 204 || res.status === 404) return null;
    return readJsonOrNull(res);
  };

  const agentControlRegistry = createAgentControlRegistryClient({
    baseUrl,
    gatewayId,
    fetchImpl: opts.fetchImpl,
  });

  return {
    async redeemOpenClawWs(ticketId: string): Promise<RedeemOpenClawWsOutcome> {
      // 502 is EXPECTED (revision unresolvable / dead), not a thrown error — the
      // upgrade surface turns it into a retryable roll-in-progress signal.
      const res = await post(
        "/internal/openclaw/ws/redeem",
        { ticketId },
        new Set([200, 401, 403, 404, 502]),
      );
      if (res.status === 502) {
        const body = await readJsonOrNull(res);
        return {
          kind: "revision-unavailable",
          reason: stringField(body, "error") ?? "gateway-url-unresolved",
        };
      }
      if (res.status !== 200) return { kind: "unauthorized" };
      const body = await readJsonOrNull(res);
      const uid = stringField(body, "uid");
      const redeemedGatewayId = stringField(body, "gatewayId");
      const gatewayUrl = stringField(body, "gatewayUrl");
      const expectedAgentId = stringField(body, "expectedAgentId");
      if (!uid || !redeemedGatewayId || !gatewayUrl || !expectedAgentId) {
        throw new OpenClawRuntimeBrokerError(502, "malformed redeem response");
      }
      return {
        kind: "redeemed",
        redeemed: { uid, gatewayId: redeemedGatewayId, gatewayUrl, expectedAgentId },
      };
    },
    async getUserGatewayId(uid: string): Promise<string | null> {
      const body = await postJson(
        "/internal/openclaw/users/gateway-id",
        { uid },
        new Set([200, 404]),
      );
      return stringField(body, "gatewayId");
    },
    async resolveAgentIdentity(agentId: string): Promise<AgentIdentity | null> {
      const body = await postJson(
        "/internal/openclaw/activity/agent-identity",
        { agentId },
        new Set([200, 404]),
      );
      return (body?.identity as AgentIdentity | undefined) ?? null;
    },
    async resolveChannelPair(primaryChannelId: string): Promise<ChannelPair | null> {
      const body = await postJson(
        "/internal/openclaw/activity/channel-pair",
        { primaryChannelId },
        new Set([200, 404]),
      );
      return (body?.pair as ChannelPair | undefined) ?? null;
    },
    async writeRunLiveDoc(path: string, doc: RunLiveDoc): Promise<void> {
      await post(
        "/internal/openclaw/activity/run-live",
        { workspaceSlug: doc.workspaceId, path, doc },
        new Set([204]),
      );
    },
    async deleteRunLiveDoc(path: string): Promise<void> {
      await post(
        "/internal/openclaw/activity/run-live/delete",
        { path },
        new Set([204]),
      );
    },
    async resolveChannelOwnerUid(channelId: string): Promise<string | null> {
      const body = await postJson(
        "/internal/openclaw/activity/channel-owner",
        { channelId },
        new Set([200, 404]),
      );
      return stringField(body, "ownerUid");
    },
    async resolveOctogeeUidByMmUser(mmUserId: string): Promise<string | null> {
      const body = await postJson(
        "/internal/openclaw/activity/user-by-mm",
        { mmUserId },
        new Set([200, 404]),
      );
      return stringField(body, "uid");
    },
    agentControlRegistry,
  };
}

export function createOpenClawRuntimeBrokerFromEnv(
  env: Record<string, string | undefined> = process.env,
): OpenClawRuntimeBroker {
  const baseUrl = runtimeBrokerBaseUrlFromEnv(env);
  const gatewayId = nonBlank(env.GATEWAY_ID);
  if (!gatewayId) throw new Error("GATEWAY_ID is required for OpenClaw runtime broker");
  return createOpenClawRuntimeBroker({ baseUrl, gatewayId });
}
