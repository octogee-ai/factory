import { internalFetch } from "../../lib/internal-fetch.js";
import { sidecarBrokerHeaders } from "@octogee/core/internal-fetch";
import type { AgentIdentity, ChannelPair } from "./activity-bridge.js";
import type { ConversationRunLiveDocV3, RunLiveDoc } from "./run-live-doc.js";
import {
  ActivityReceiptConflictError,
  ActivityReceiptLeaseError,
  ActivityReceiptUnavailableError,
  type ActivityAttachmentReceiptV1,
  type ActivityReceiptClaim,
  type ActivityReceiptClaimInput,
  type ActivityWriteReceiptStore,
  type ActivityWriteReceiptV1,
} from "./activity-write-receipts.js";
import {
  BrokeredActivityWriteReceiptStore,
  type ActivityWriteReceiptBrokerPort,
} from "./activity-write-receipt-broker.js";
import {
  createAgentControlRegistryClient,
  type AgentControlRegistryClient,
} from "./agent-control-registry-client.js";
import type { BrokeredShellDeletion } from "../../lib/shell-deletion-reconciler.js";

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
  authorizePreviewAccess(uid: string, workspaceSlug: string, projectSlug: string | null): Promise<boolean>;
  getUserGatewayId(uid: string): Promise<string | null>;
  resolveAgentIdentity(agentId: string): Promise<AgentIdentity | null>;
  resolveChannelPair(primaryChannelId: string): Promise<ChannelPair | null>;
  requestBuilderRunActivation(input: {
    agentId: string;
    runId: string;
  }): Promise<Record<string, unknown>>;
  writeRunLiveDoc(path: string, doc: RunLiveDoc | ConversationRunLiveDocV3): Promise<void>;
  deleteRunLiveDoc(path: string): Promise<void>;
  listDeletingShells(limit: number): Promise<BrokeredShellDeletion[]>;
  completeDeletingShell(input: {
    shellId: string;
    workspaceSlug: string;
    deletionId: string;
  }): Promise<boolean>;
  activityWriteReceiptsFor(channelDocPath: string): ActivityWriteReceiptStore;
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

function workspaceSlugFromRunLivePath(path: string): string {
  const parts = path.split("/");
  if (parts[0] !== "workspaces" || !parts[1] || !parts.includes("liveRuns")) {
    throw new OpenClawRuntimeBrokerError(400, "malformed run-live path");
  }
  return parts[1];
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

function objectField(body: Record<string, unknown> | null, name: string): Record<string, unknown> | null {
  const value = body?.[name];
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function shellDeletions(body: Record<string, unknown> | null): BrokeredShellDeletion[] {
  const records = body?.deletions;
  if (!Array.isArray(records)) {
    throw new OpenClawRuntimeBrokerError(502, "malformed shell deletion list");
  }
  return records.map((record) => {
    if (!record || typeof record !== "object" || Array.isArray(record)) {
      throw new OpenClawRuntimeBrokerError(502, "malformed shell deletion");
    }
    const value = record as Record<string, unknown>;
    if (
      typeof value.shellId !== "string" ||
      !(typeof value.workspaceSlug === "string" || value.workspaceSlug === null) ||
      !(typeof value.deletionId === "string" || value.deletionId === null)
    ) {
      throw new OpenClawRuntimeBrokerError(502, "malformed shell deletion");
    }
    return {
      shellId: value.shellId,
      workspaceSlug: value.workspaceSlug,
      deletionId: value.deletionId,
    };
  });
}

function readReceipt(body: Record<string, unknown> | null): ActivityWriteReceiptV1 {
  const receipt = objectField(body, "receipt");
  if (!receipt) throw new OpenClawRuntimeBrokerError(502, "malformed receipt response");
  return receipt as unknown as ActivityWriteReceiptV1;
}

function readReceiptClaim(body: Record<string, unknown> | null): ActivityReceiptClaim {
  const outcome = stringField(body, "outcome");
  const receipt = readReceipt(body);
  if (outcome === "duplicate") return { outcome, receipt };
  if (outcome === "claimed" && typeof body?.recovered === "boolean") {
    return { outcome, receipt, recovered: body.recovered };
  }
  throw new OpenClawRuntimeBrokerError(502, "malformed receipt claim response");
}

function receiptBrokerError(error: string | null): Error {
  if (error === "receipt_conflict") {
    return new ActivityReceiptConflictError("event-key payload digest conflict");
  }
  if (error === "receipt_leased") {
    return new ActivityReceiptLeaseError("Activity receipt is leased by another writer");
  }
  return new ActivityReceiptUnavailableError("Activity receipt broker request failed");
}

type BrokerPost = (
  path: string,
  body: Record<string, unknown>,
  expected: ReadonlySet<number>,
) => Promise<Response>;

function createActivityWriteReceiptBrokerPort(post: BrokerPost): ActivityWriteReceiptBrokerPort {
  const receiptRequest = async (
    path: string,
    body: Record<string, unknown>,
    success: ReadonlySet<number>,
  ): Promise<Response> => {
    const res = await post(
      path,
      body,
      new Set([...success, 400, 403, 404, 409, 422]),
    );
    if (success.has(res.status)) return res;
    throw receiptBrokerError(stringField(await readJsonOrNull(res), "error"));
  };

  return {
    async claimActivityWriteReceipt(
      channelDocPath: string,
      input: ActivityReceiptClaimInput,
    ): Promise<ActivityReceiptClaim> {
      const body = await readJsonOrNull(await receiptRequest(
        "/internal/openclaw/activity/write-receipts/claim",
        { channelDocPath, input },
        new Set([200]),
      ));
      return readReceiptClaim(body);
    },
    async readActivityWriteReceipt(
      channelDocPath: string,
      eventKey: string,
    ): Promise<ActivityWriteReceiptV1 | null> {
      const res = await receiptRequest(
        "/internal/openclaw/activity/write-receipts/read",
        { channelDocPath, eventKey },
        new Set([200, 404]),
      );
      if (res.status === 404) return null;
      return readReceipt(await readJsonOrNull(res));
    },
    async markActivityWriteReceiptPosted(
      channelDocPath: string,
      eventKey: string,
      leaseToken: string,
      postId: string,
      now: number,
    ): Promise<void> {
      await receiptRequest(
        "/internal/openclaw/activity/write-receipts/mark-posted",
        { channelDocPath, eventKey, leaseToken, postId, now },
        new Set([204]),
      );
    },
    async updateActivityWriteReceiptAttachment(
      channelDocPath: string,
      eventKey: string,
      leaseToken: string,
      attachment: ActivityAttachmentReceiptV1,
      now: number,
    ): Promise<void> {
      await receiptRequest(
        "/internal/openclaw/activity/write-receipts/attachment",
        { channelDocPath, eventKey, leaseToken, attachment, now },
        new Set([204]),
      );
    },
    async commitActivityWriteReceipt(
      channelDocPath: string,
      eventKey: string,
      leaseToken: string,
      now: number,
    ): Promise<void> {
      await receiptRequest(
        "/internal/openclaw/activity/write-receipts/commit",
        { channelDocPath, eventKey, leaseToken, now },
        new Set([204]),
      );
    },
  };
}

export function createOpenClawRuntimeBroker(opts: {
  baseUrl: string;
  gatewayId: string;
  fetchImpl?: typeof fetch;
  sidecarBrokerHeaders?: () => Promise<Record<string, string>>;
}): OpenClawRuntimeBroker {
  const baseUrl = trimBaseUrl(opts.baseUrl);
  const gatewayId = opts.gatewayId;
  const credentialHeaders = opts.sidecarBrokerHeaders ?? sidecarBrokerHeaders;

  const post = async (
    path: string,
    body: Record<string, unknown>,
    expected: ReadonlySet<number>,
  ): Promise<Response> => {
    const credentialCapability = path === "/internal/openclaw/activity/agent-identity"
      ? await credentialHeaders()
      : {};
    const res = await internalFetch(
      `${baseUrl}${path}`,
      {
        method: "POST",
        headers: { "content-type": "application/json", ...credentialCapability },
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

  const receiptPort = createActivityWriteReceiptBrokerPort(post);

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
    async authorizePreviewAccess(
      uid: string,
      workspaceSlug: string,
      projectSlug: string | null,
    ): Promise<boolean> {
      const res = await post(
        "/internal/openclaw/previews/authorize",
        { uid, workspaceSlug, projectSlug },
        new Set([200, 403]),
      );
      if (res.status === 403) return false;
      const body = await readJsonOrNull(res);
      if (typeof body?.authorized !== "boolean") {
        throw new OpenClawRuntimeBrokerError(502, "malformed preview authorization response");
      }
      return body.authorized;
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
    async requestBuilderRunActivation(input): Promise<Record<string, unknown>> {
      const body = await postJson(
        "/internal/fleet/activity/run-start",
        input,
        new Set([200, 202]),
      );
      if (!body) {
        throw new OpenClawRuntimeBrokerError(502, "malformed run activation response");
      }
      return body;
    },
    async writeRunLiveDoc(
      path: string,
      doc: RunLiveDoc | ConversationRunLiveDocV3,
    ): Promise<void> {
      await post(
        "/internal/openclaw/activity/run-live",
        { workspaceSlug: workspaceSlugFromRunLivePath(path), path, doc },
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
    async listDeletingShells(limit: number): Promise<BrokeredShellDeletion[]> {
      const body = await postJson(
        "/internal/openclaw/shells/deleting/list",
        { limit },
        new Set([200]),
      );
      return shellDeletions(body);
    },
    async completeDeletingShell(input): Promise<boolean> {
      const body = await postJson(
        "/internal/openclaw/shells/deleting/complete",
        input,
        new Set([200]),
      );
      if (typeof body?.completed !== "boolean") {
        throw new OpenClawRuntimeBrokerError(502, "malformed shell deletion completion");
      }
      return body.completed;
    },
    activityWriteReceiptsFor(channelDocPath: string): ActivityWriteReceiptStore {
      return new BrokeredActivityWriteReceiptStore(receiptPort, channelDocPath);
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
