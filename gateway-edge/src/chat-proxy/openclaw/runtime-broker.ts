import { internalFetch } from "../../lib/internal-fetch.js";
import type { AgentIdentity, ChannelPair } from "./activity-bridge.js";
import type {
  ApprovalRecord,
  ApprovalRegistry,
  MarkDispatchedResult,
} from "./approval-registry.js";
import type { RunLiveDoc } from "./run-live-doc.js";

export interface RedeemedOpenClawWs {
  uid: string;
  gatewayId: string;
  gatewayUrl: string;
  expectedAgentId: string;
}

export interface OpenClawRuntimeBroker {
  redeemOpenClawWs(ticketId: string): Promise<RedeemedOpenClawWs | null>;
  getUserGatewayId(uid: string): Promise<string | null>;
  resolveAgentIdentity(agentId: string): Promise<AgentIdentity | null>;
  resolveChannelPair(primaryChannelId: string): Promise<ChannelPair | null>;
  writeRunLiveDoc(path: string, doc: RunLiveDoc): Promise<void>;
  deleteRunLiveDoc(path: string): Promise<void>;
  resolveChannelOwnerUid(channelId: string): Promise<string | null>;
  resolveOctogeeUidByMmUser(mmUserId: string): Promise<string | null>;
  approvalRegistry: ApprovalRegistry;
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
): string | null {
  const explicit = nonBlank(env.OPENCLAW_RUNTIME_BROKER_URL);
  if (explicit) return explicit;
  return null;
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

  const approvalRegistry: ApprovalRegistry = {
    async register(record: ApprovalRecord): Promise<void> {
      await post("/internal/openclaw/activity/approval/register", { record }, new Set([204]));
    },
    async lookup(approvalId: string): Promise<ApprovalRecord | null> {
      const body = await postJson(
        "/internal/openclaw/activity/approval/lookup",
        { approvalId },
        new Set([200, 404]),
      );
      return (body?.record as ApprovalRecord | undefined) ?? null;
    },
    async attachPostId(approvalId: string, postId: string): Promise<void> {
      await post(
        "/internal/openclaw/activity/approval/attach-post",
        { approvalId, postId },
        new Set([204]),
      );
    },
    async markDispatched(approvalId: string): Promise<MarkDispatchedResult> {
      const body = await postJson(
        "/internal/openclaw/activity/approval/mark-dispatched",
        { approvalId },
        new Set([200]),
      );
      const outcome = body?.outcome;
      if (
        outcome === "dispatched" ||
        outcome === "already-dispatched" ||
        outcome === "not-found"
      ) {
        return { outcome };
      }
      throw new OpenClawRuntimeBrokerError(502, "malformed approval dispatch response");
    },
    async resetDispatched(approvalId: string): Promise<void> {
      await post(
        "/internal/openclaw/activity/approval/reset-dispatched",
        { approvalId },
        new Set([204]),
      );
    },
  };

  return {
    async redeemOpenClawWs(ticketId: string): Promise<RedeemedOpenClawWs | null> {
      const res = await post(
        "/internal/openclaw/ws/redeem",
        { ticketId },
        new Set([200, 401, 403, 404]),
      );
      if (res.status !== 200) return null;
      const body = await readJsonOrNull(res);
      if (!body) return null;
      const uid = stringField(body, "uid");
      const redeemedGatewayId = stringField(body, "gatewayId");
      const gatewayUrl = stringField(body, "gatewayUrl");
      const expectedAgentId = stringField(body, "expectedAgentId");
      if (!uid || !redeemedGatewayId || !gatewayUrl || !expectedAgentId) {
        throw new OpenClawRuntimeBrokerError(502, "malformed redeem response");
      }
      return { uid, gatewayId: redeemedGatewayId, gatewayUrl, expectedAgentId };
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
    approvalRegistry,
  };
}

export function createOpenClawRuntimeBrokerFromEnv(
  env: Record<string, string | undefined> = process.env,
): OpenClawRuntimeBroker | null {
  const baseUrl = runtimeBrokerBaseUrlFromEnv(env);
  const gatewayId = nonBlank(env.GATEWAY_ID);
  // Temporary rollout bridge: returning null sends callers to the legacy direct
  // Firestore path. Remove this once TEST and PROD run the brokered bundle.
  if (!baseUrl || !gatewayId) return null;
  return createOpenClawRuntimeBroker({ baseUrl, gatewayId });
}
