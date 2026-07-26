import { isIP } from "node:net";
import { Router, type Request, type Response } from "express";
import { FieldValue, type Firestore } from "firebase-admin/firestore";

import { logger } from "../../../gateway-edge/src/middleware/logging.js";
import { isValidUsername } from "@octogee/shared/types/identity";
import { pickPlanInputs } from "@octogee/shared/types/billing";
import {
  createCachedFreeTierModelResolver,
  type FreeTierModelResolver,
} from "../lib/platform-model-config.js";
import type {
  FleetBrokerBlobSignedUrl,
  FleetBrokerAssignmentRosterEntry,
  FleetBrokerChannelBinding,
  FleetBrokerConfiguredBuilderBootstrap,
  FleetBrokerGreetingResult,
  FleetBrokerMattermostUpdate,
  FleetBrokerPreStopFlushEvent,
  FleetBrokerPreStopFlushStep,
  FleetBrokerProjectRestore,
  FleetBrokerProvisioningStatus,
  FleetBrokerUsageData,
  FleetBrokerUserSnapshot,
} from "@octogee/shared/types/fleet-broker";
import {
  byotSnapshotProjectionFromSystemConfig,
  collectProjectAgentStates,
  mapProjectChannelDoc,
  mapWorkspaceChannelDoc,
} from "@octogee/core/customer-snapshot-mapping";
import {
  hasRunningInboundMigrationForUid,
  slugFromAssignedUser,
} from "@octogee/core/assigned-roster";
import {
  parseAssignmentDoc,
} from "@octogee/core/assignment-doc";
import {
  requestBuilderActivationLease,
  type BuilderRuntimeDemandRequest,
} from "@octogee/core/builder-activation-lease";
import {
  GATEWAYS_COLLECTION,
  OPENCLAW_DASHBOARD_BRIDGE_PROTOCOL,
  OPENCLAW_DASHBOARD_BRIDGE_PROTOCOL_VERSION,
} from "@octogee/shared/types/fleet-controller";
import {
  GATEWAY_ASSIGNMENTS_SUBCOLLECTION,
  isAssignmentState,
  projectGatewayDesiredRootForGateway,
  type GatewayDoc,
} from "@octogee/shared/types/gateway-releases";
import {
  configuredBuilderCredentialBootstrapAllowed,
  projectGatewayMutableConfigForGateway,
  podBelongsToGateway,
  type GatewayMutableConfig,
} from "@octogee/core/gateway-live-release";
import { createCachedOwnerModelBrokerGrantResolver } from "../lib/model-broker-limits.js";
import { createFirestoreModelBrokerUsageStore } from "../lib/model-broker-usage.js";
import {
  WebResearchError,
  createWebResearchService,
  type WebResearchExtractInput,
  type WebResearchSearchInput,
} from "../lib/web-research-service.js";
import { createBraveSearchClient, createTavilyClient } from "../lib/web-provider-clients.js";
import { isPublicIp } from "../lib/link-unfurl.js";
import { recordRevisionSystemConfigStatus } from "../lib/revision-system-config-status.js";
import { revisionIdFromGatewayPodName } from "../lib/gateway-pod-revision.js";

type GatewayBinding = Extract<Express.Request["boundTenant"], { kind: "gateway" }>;

const FORBIDDEN = { error: "forbidden" } as const;
const OPENCLAW_GATEWAY_ID_FIELD = "provisioning.openclaw.gatewayId";

type RecordUsageEvent = (input: {
  db: Firestore;
  uid: string;
  agentId: string;
  usage: FleetBrokerUsageData;
  gatewayId: string;
}) => Promise<void>;

type CreateBlobSignedUrl = (input: {
  gcsPath: string;
  action: "read" | "write";
  contentType?: string;
}) => Promise<FleetBrokerBlobSignedUrl>;

type RenderAvatar = (bytes: Buffer) => Promise<Buffer>;

type ApplyCoachIdentity = (input: {
  uid: string;
  slug: string;
  name?: string;
  persona?: string;
  avatarPng?: Buffer;
}) => Promise<string[]>;

// Chat broker: the gateway skill is a thin client; PAT resolution + MM reads run
// HERE so no chat PAT ever reaches the injection-reachable agent runtime. The
// identity's PAT is the capability boundary (workspace agent → Builder PAT,
// project agent → its bot's project-scoped PAT).
interface ChatBrokerIdentity {
  pat: string;
  coachMmUserId: string;
  /** Agent bot's own credential — used only for the `unread` read cursor. */
  unread: { pat: string; mmUserId: string };
  slug: string;
  siteUrl: string;
  canReadChannel?: (channelId: string) => Promise<boolean>;
  includeArchivedProjectHistory?: true;
}

type ExecuteChatSearch = (
  identity: ChatBrokerIdentity,
  params: {
    query: string;
    scope?: "current_channel" | "all_visible";
    limit?: number;
    currentChannelId?: string;
  },
) => Promise<Record<string, unknown>>;

type ExecuteChatHistory = (
  identity: ChatBrokerIdentity,
  params: {
    channel?: string;
    direction?: string;
    cursor?: string;
    limit?: number;
    fromUsername?: string;
    currentChannelId?: string;
  },
) => Promise<Record<string, unknown>>;

type ResolveChatIdentity = (
  db: Firestore,
  input: { uid: string; slug: string; agentId: string },
) => Promise<{
  lane: "workspace" | "project";
  pat: string;
  coachMmUserId: string;
  unread: { pat: string; mmUserId: string };
  canReadChannel?: (channelId: string) => Promise<boolean>;
  includeArchivedProjectHistory?: true;
}>;

interface FleetBrokerRouteDeps {
  provisionMattermost?: (input: {
    uid: string;
    userData: Record<string, unknown>;
  }) => Promise<FleetBrokerMattermostUpdate>;
  markProvisioningComplete?: (input: {
    uid: string;
    userData: Record<string, unknown>;
    mmUpdate: FleetBrokerMattermostUpdate;
  }) => Promise<void>;
  ensureCommunityMembership?: (input: { mmUserId: string }) => Promise<void>;
  notifyOpsOfSignup?: (input: {
    uid: string;
    userData: Record<string, unknown>;
  }) => Promise<void>;
  recordUsageEvent?: RecordUsageEvent;
  renderAvatar?: RenderAvatar;
  applyCoachIdentity?: ApplyCoachIdentity;
  createBlobSignedUrl?: CreateBlobSignedUrl;
  executeChatSearch?: ExecuteChatSearch;
  executeChatHistory?: ExecuteChatHistory;
  resolveChatIdentity?: ResolveChatIdentity;
  webResearch?: Pick<ReturnType<typeof createWebResearchService>, "search" | "extract">;
  requestBuilderActivation?: (
    input: BuilderRuntimeDemandRequest,
  ) => ReturnType<typeof requestBuilderActivationLease>;
  now?: () => number;
}

const BLOB_SIGNED_URL_TTL_MS = 10 * 60 * 1000;
const BLOB_SYNC_MAX_SIZE = 100 * 1024 * 1024;

async function defaultProvisionMattermost(input: {
  uid: string;
  userData: Record<string, unknown>;
}): Promise<FleetBrokerMattermostUpdate> {
  const { buildProvisioningContext, provisionMattermost } = await import(
    "@octogee/core/provisionSteps"
  );
  return provisionMattermost(buildProvisioningContext(input.uid, input.userData));
}

async function defaultEnsureCommunityMembership(input: { mmUserId: string }): Promise<void> {
  const { joinCommunityMembership } = await import("@octogee/core/mattermost");
  await joinCommunityMembership(input.mmUserId);
}

async function defaultMarkProvisioningComplete(input: {
  uid: string;
  userData: Record<string, unknown>;
  mmUpdate: FleetBrokerMattermostUpdate;
}): Promise<void> {
  const { buildProvisioningContext, markProvisioningComplete } = await import(
    "@octogee/core/provisionSteps"
  );
  const ctx = buildProvisioningContext(input.uid, input.userData);
  await markProvisioningComplete(ctx, input.mmUpdate, [`octogee-${ctx.slug}-coach`]);
}

async function defaultNotifyOpsOfSignup(input: {
  uid: string;
  userData: Record<string, unknown>;
}): Promise<void> {
  const { buildProvisioningContext, notifyOpsOfSignup } = await import(
    "@octogee/core/provisionSteps"
  );
  await notifyOpsOfSignup(buildProvisioningContext(input.uid, input.userData));
}

const defaultRenderAvatar: RenderAvatar = async (bytes) => {
  const { renderAvatarPng } = await import("../lib/avatar-render.js");
  return renderAvatarPng(bytes);
};

const defaultApplyCoachIdentity: ApplyCoachIdentity = async (input) => {
  const { syncCoachIdentity } = await import(
    "../../../gateway-edge/src/lib/coach-identity.js"
  );
  return syncCoachIdentity(
    input.uid,
    { name: input.name, persona: input.persona, avatarPng: input.avatarPng },
    { slug: input.slug },
  );
};

const defaultExecuteChatSearch: ExecuteChatSearch = async (identity, params) => {
  const { executeChatSearch } = await import(
    "../../../gateway-edge/src/lib/chat-broker/execute.js"
  );
  return executeChatSearch(identity, params);
};

const defaultExecuteChatHistory: ExecuteChatHistory = async (identity, params) => {
  const { executeChatHistory } = await import(
    "../../../gateway-edge/src/lib/chat-broker/execute.js"
  );
  return executeChatHistory(identity, params);
};

const defaultResolveChatIdentity: ResolveChatIdentity = async (db, input) => {
  const { resolveChatIdentity } = await import(
    "../../../gateway-edge/src/lib/chat-broker/resolve-pat.js"
  );
  return resolveChatIdentity(db, input);
};

function positiveConfigNumber(raw: string | undefined, fallback: number, name: string): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive number`);
  }
  return value;
}

function createDefaultWebResearch(db: Firestore) {
  const braveKey = process.env.BRAVE_API_KEY?.trim();
  const tavilyKey = process.env.TAVILY_API_KEY?.trim();
  const brave = braveKey ? createBraveSearchClient({ apiKey: braveKey }) : null;
  const tavily = tavilyKey ? createTavilyClient({ apiKey: tavilyKey }) : null;
  return createWebResearchService({
    usageStore: createFirestoreModelBrokerUsageStore(db),
    resolveGrant: createCachedOwnerModelBrokerGrantResolver({
      db,
      log: (message, fields) => logger.info(message, fields),
    }),
    braveSearch: brave?.search,
    tavilySearch: tavily?.search,
    tavilyExtract: tavily?.extract,
    braveCostPerRequestUsd: positiveConfigNumber(
      process.env.BRAVE_SEARCH_COST_PER_REQUEST_USD,
      0.005,
      "BRAVE_SEARCH_COST_PER_REQUEST_USD",
    ),
    tavilyCostPerCreditUsd: positiveConfigNumber(
      process.env.TAVILY_COST_PER_CREDIT_USD,
      0.008,
      "TAVILY_COST_PER_CREDIT_USD",
    ),
    markupMultiplier: positiveConfigNumber(
      process.env.PLATFORM_WEB_MARKUP_MULTIPLIER,
      1.25,
      "PLATFORM_WEB_MARKUP_MULTIPLIER",
    ),
    onError: (error) => logger.error("web research usage recording failed", { error }),
  });
}

const defaultRecordUsageEvent: RecordUsageEvent = async (input) => {
  const { extractRole, reportUsageForUid } = await import(
    "@octogee/core/usage-tracking"
  );
  await reportUsageForUid({
    db: input.db,
    uid: input.uid,
    agentId: input.agentId,
    role: extractRole(input.agentId),
    usage: input.usage,
    gatewayId: input.gatewayId,
    log: (msg) => logger.info(`[usage-broker] ${msg}`),
  });
};

const defaultCreateBlobSignedUrl: CreateBlobSignedUrl = async (input) => {
  const { getStorage } = await import("firebase-admin/storage");
  const expires = Date.now() + BLOB_SIGNED_URL_TTL_MS;
  const [url] = await getStorage()
    .bucket()
    .file(input.gcsPath)
    .getSignedUrl({
      version: "v4",
      action: input.action,
      expires,
      ...(input.action === "write" ? { contentType: input.contentType } : {}),
    });
  return {
    url,
    method: input.action === "read" ? "GET" : "PUT",
    gcsPath: input.gcsPath,
    expiresAt: new Date(expires).toISOString(),
  };
};

function boundGateway(req: Request, res: Response): GatewayBinding | null {
  const bound = req.boundTenant;
  if (!bound || bound.kind !== "gateway") {
    res.status(403).json(FORBIDDEN);
    return null;
  }
  const claimed = typeof req.body?.gatewayId === "string" ? req.body.gatewayId : "";
  if (claimed && claimed !== bound.gatewayId) {
    res.status(403).json(FORBIDDEN);
    return null;
  }
  return bound;
}

function readPath(obj: Record<string, unknown> | undefined, dotted: string): unknown {
  let cur: unknown = obj;
  for (const part of dotted.split(".")) {
    if (!cur || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

function stringAt(obj: Record<string, unknown> | undefined, dotted: string): string {
  const value = readPath(obj, dotted);
  return typeof value === "string" ? value : "";
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

function objectBody(req: Request): Record<string, unknown> {
  return req.body && typeof req.body === "object"
    ? (req.body as Record<string, unknown>)
    : {};
}

const SYSTEM_CONFIG_STATES = new Set(["clean", "dirty", "syncing", "error", "unavailable"]);
const SYSTEM_CONFIG_ENUMS: Record<string, ReadonlySet<string>> = {
  doctorResult: new Set(["ok", "error"]),
  bootRecovery: new Set(["none", "recovered", "unavailable"]),
  watcherState: new Set(["running", "stopped"]),
};
const DASHBOARD_CONTROL_STATES = new Set(["ready", "missing", "stale", "invalid"]);

function isDashboardControlProtocol(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const protocol = value as Record<string, unknown>;
  return protocol.protocol === OPENCLAW_DASHBOARD_BRIDGE_PROTOCOL &&
    protocol.version === OPENCLAW_DASHBOARD_BRIDGE_PROTOCOL_VERSION;
}

function isBoundedTimestamp(value: unknown): value is string {
  return typeof value === "string" && value.length <= 40 && !Number.isNaN(Date.parse(value));
}

function copyOptionalFields(
  input: Record<string, unknown>,
  out: Record<string, unknown>,
  keys: string[],
  isValid: (value: unknown) => boolean,
  nullable = false,
): boolean {
  for (const key of keys) {
    const field = input[key];
    if (field === undefined) continue;
    if (field === null && nullable) {
      out[key] = null;
      continue;
    }
    if (!isValid(field)) return false;
    out[key] = field;
  }
  return true;
}

function copyEnumFields(
  input: Record<string, unknown>,
  out: Record<string, unknown>,
): boolean {
  for (const [key, allowed] of Object.entries(SYSTEM_CONFIG_ENUMS)) {
    const field = input[key];
    if (field === undefined) continue;
    if (typeof field !== "string" || !allowed.has(field)) return false;
    out[key] = field;
  }
  return true;
}

function copySystemConfigStatusFields(
  input: Record<string, unknown>,
  out: Record<string, unknown>,
): boolean {
  return copyOptionalFields(input, out, ["acceptedCommit", "restoredCommit"],
    (field) => typeof field === "string" && /^[0-9a-f]{7,64}$/.test(field)) &&
    copyOptionalFields(input, out, ["configHash"],
      (field) => typeof field === "string" && /^(?:sha256:)?[0-9a-f]{64}$/.test(field)) &&
    copyOptionalFields(input, out,
      ["dirtySince", "lastSyncedAt", "lastErrorAt", "runtimeHealthCheckedAt", "updatedAt"],
      isBoundedTimestamp, true) &&
    copyOptionalFields(input, out, ["lastErrorCode"],
      (field) => typeof field === "string" && /^[a-z0-9][a-z0-9-]{0,79}$/.test(field), true) &&
    copyEnumFields(input, out) &&
    copyOptionalFields(input, out, ["runtimeReady"], (field) => typeof field === "boolean") &&
    copyOptionalFields(input, out, ["runtimeHealth"],
      (field) => field === "repair" || field === "healthy" || field === "unhealthy") &&
    copyOptionalFields(input, out, ["schemaVersion", "rejectedCount", "recoveryCount"],
      (field) => typeof field === "number" && Number.isSafeInteger(field) && field >= 0) &&
    copyOptionalFields(input, out, ["openclawVersion"],
      (field) => typeof field === "string" && /^[A-Za-z0-9._+-]{1,80}$/.test(field)) &&
    copyOptionalFields(input, out, ["openclawForkSha"],
      (field) => typeof field === "string" &&
        (field === "unknown" || /^[0-9a-f]{7,64}$/.test(field)));
}

function parseDashboardControlStatus(
  input: Record<string, unknown>,
): Record<string, unknown> | null {
  const state = input.dashboardControlState;
  const protocolValue = input.dashboardControlProtocol;
  const observedAt = input.dashboardControlObservedAt;
  if (state === undefined) {
    if (protocolValue === undefined && observedAt === undefined) return {};
    return null;
  }
  if (typeof state !== "string" || !DASHBOARD_CONTROL_STATES.has(state)) return null;
  if (state !== "ready") {
    if (protocolValue === undefined && observedAt === undefined) {
      return { dashboardControlState: state };
    }
    return null;
  }
  if (
    !isDashboardControlProtocol(protocolValue) ||
    !isBoundedTimestamp(observedAt)
  ) return null;
  return {
    dashboardControlState: state,
    dashboardControlProtocol: {
      protocol: OPENCLAW_DASHBOARD_BRIDGE_PROTOCOL,
      version: OPENCLAW_DASHBOARD_BRIDGE_PROTOCOL_VERSION,
    },
    dashboardControlObservedAt: observedAt,
  };
}

export function parseSystemConfigObservedStatus(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  if (typeof input.state !== "string" || !SYSTEM_CONFIG_STATES.has(input.state)) return null;
  const out: Record<string, unknown> = { state: input.state };
  if (!copySystemConfigStatusFields(input, out)) return null;
  const dashboardControl = parseDashboardControlStatus(input);
  if (!dashboardControl) return null;
  Object.assign(out, dashboardControl);
  return out;
}

function recordBodyValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function validPreStopFlushEvent(
  value: Record<string, unknown>,
): FleetBrokerPreStopFlushEvent | null {
  const phase = value.phase;
  if (phase !== "started" && phase !== "completed") return null;
  if (value.reason !== "prestop") return null;
  const gatewayClass = typeof value.gatewayClass === "string" ? value.gatewayClass : "";
  if (!gatewayClass) return null;
  const resultValue = recordBodyValue(value.result);
  if (phase === "started") {
    return { gatewayClass, phase, reason: "prestop" };
  }
  if (!resultValue) return null;
  const ok = resultValue.ok;
  const durationMs = resultValue.durationMs;
  const steps = resultValue.steps;
  if (typeof ok !== "boolean" || typeof durationMs !== "number" || !Array.isArray(steps)) {
    return null;
  }
  const validSteps = steps
    .filter((step): step is Record<string, unknown> => recordBodyValue(step) !== null)
    .map((step): FleetBrokerPreStopFlushStep => {
      const status: FleetBrokerPreStopFlushStep["status"] =
        step.status === "done" || step.status === "failed" || step.status === "skipped"
          ? step.status
          : "failed";
      return {
        name: typeof step.name === "string" ? step.name : "unknown",
        status,
        ...(typeof step.error === "string" ? { error: step.error.slice(0, 1000) } : {}),
        durationMs: typeof step.durationMs === "number" ? step.durationMs : 0,
      };
    });
  return {
    gatewayClass,
    phase,
    reason: "prestop",
    result: {
      ok,
      durationMs,
      steps: validSteps,
    },
  };
}

function isDurableGatewayRoot(
  data: unknown,
  gatewayId: string,
): data is GatewayDoc & GatewayMutableConfig {
  return (
    projectGatewayDesiredRootForGateway(data, gatewayId) !== null
  );
}

function warmTargetGatewayId(data: GatewayMutableConfig): string | null {
  const warmTargetGatewayId = data.preemption?.warmTargetGatewayId;
  return typeof warmTargetGatewayId === "string" && warmTargetGatewayId.length > 0
    ? warmTargetGatewayId
    : null;
}

function isProvisioningStatus(value: unknown): value is Exclude<FleetBrokerProvisioningStatus, ""> {
  return value === "provisioning" || value === "complete";
}

function isGreetingResult(value: unknown): value is FleetBrokerGreetingResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  if (v.ok === true) return typeof v.jobId === "string" && v.jobId.length > 0;
  if (v.ok === false) return typeof v.error === "string" && v.error.length > 0;
  return false;
}

function validAgentIds(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const ids = value.filter((v): v is string => typeof v === "string" && v.length > 0);
  return ids.length === value.length ? ids : null;
}

function validAgentId(value: unknown): string {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > 160) return "";
  return /^[A-Za-z0-9._:-]+$/.test(trimmed) ? trimmed : "";
}

function finiteNonNegative(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

const USAGE_NUMBER_FIELDS = [
  "input",
  "output",
  "cacheRead",
  "cacheWrite",
  "totalTokens",
  "costUsd",
] as const;
const USAGE_COST_FIELDS = ["input", "output", "cacheRead", "cacheWrite"] as const;

function finiteNonNegativeFields<T extends string>(
  data: Record<string, unknown>,
  fields: readonly T[],
): Record<T, number> | null {
  const out = {} as Record<T, number>;
  for (const field of fields) {
    const value = finiteNonNegative(data[field]);
    if (value === null) return null;
    out[field] = value;
  }
  return out;
}

function validUsageModel(value: unknown): string {
  const model = typeof value === "string" ? value.trim() : "";
  return model.length > 0 && model.length <= 200 ? model : "";
}

export function validFleetBrokerUsageData(value: unknown): FleetBrokerUsageData | null {
  const data = recordBodyValue(value);
  if (!data) return null;
  const usageNumbers = finiteNonNegativeFields(data, USAGE_NUMBER_FIELDS);
  const costBreakdown = finiteNonNegativeFields(
    recordBodyValue(data.costBreakdown) ?? {},
    USAGE_COST_FIELDS,
  );
  const model = validUsageModel(data.model);
  if (!usageNumbers || !costBreakdown || !model) return null;
  return {
    ...usageNumbers,
    model,
    costBreakdown,
  };
}

function validBlobRelativePath(value: unknown): string {
  if (typeof value !== "string") return "";
  const p = value.trim();
  if (p.length === 0 || p.length > 1024) return "";
  if (p.startsWith("/") || p.includes("\\") || p.includes("\0")) return "";
  const parts = p.split("/");
  if (parts.some((part) => part.length === 0 || part === "." || part === ".." || part.startsWith("."))) {
    return "";
  }
  return p;
}

function validContentType(value: unknown): string {
  if (typeof value !== "string") return "application/octet-stream";
  const p = value.trim();
  if (p.length === 0 || p.length > 200 || /[\r\n]/.test(p)) {
    return "application/octet-stream";
  }
  return p;
}

function gcsPathForBlob(slug: string, relativePath: string): string {
  return `customers/${slug}/${relativePath}`;
}

function agentBelongsToAssignedWorkspace(
  data: Record<string, unknown>,
  agentId: string,
): boolean {
  const legacyAgentId = stringAt(data, "provisioning.openclaw.agentId");
  if (legacyAgentId === agentId) return true;
  const agentIds = stringArray(readPath(data, "provisioning.openclaw.agentIds"));
  return agentIds.includes(agentId);
}

export async function findAssignedUserByAgentId(
  db: Firestore,
  gatewayId: string,
  agentId: string,
): Promise<{ uid: string; data: Record<string, unknown> } | null> {
  const snap = await db
    .collection("users")
    .where(OPENCLAW_GATEWAY_ID_FIELD, "==", gatewayId)
    .get();
  for (const doc of snap.docs) {
    const data = doc.data() as Record<string, unknown> | undefined;
    if (!data) continue;
    if (agentBelongsToAssignedWorkspace(data, agentId)) {
      return { uid: doc.id, data };
    }
  }
  return null;
}

type LateDuplicateAllocation = {
  ownerUid: string;
  leaseId: unknown;
  generation: unknown;
};

function lateDuplicateAllocation(
  gatewayData: Record<string, unknown> | undefined,
): LateDuplicateAllocation | null {
  const allocated = recordBodyValue(gatewayData?.allocation);
  if (!allocated) return null;
  const ownerUid = typeof allocated.claimedByUid === "string"
    ? allocated.claimedByUid
    : "";
  if (
    allocated.kind !== "disposable-builder" ||
    !ownerUid ||
    gatewayData?.ownerUid !== ownerUid
  ) {
    return null;
  }
  return {
    ownerUid,
    leaseId: allocated.leaseId,
    generation: allocated.generation,
  };
}

function parkedRunDuplicate(
  leaseValue: unknown,
  allocation: LateDuplicateAllocation,
  eventKey: string,
): Record<string, unknown> | null {
  const parked = recordBodyValue(leaseValue);
  if (
    !parked ||
    parked.status !== "parked" ||
    parked.leaseId !== allocation.leaseId ||
    parked.generation !== allocation.generation ||
    (parked.eventKey !== eventKey && parked.lastEventKey !== eventKey) ||
    typeof parked.leaseId !== "string" ||
    !Number.isSafeInteger(parked.generation)
  ) {
    return null;
  }
  return {
    status: "parked",
    leaseId: parked.leaseId,
    generation: parked.generation,
    duplicate: true,
  };
}

async function findLateParkedRunDuplicate(
  db: Firestore,
  gatewayId: string,
  agentId: string,
  eventKey: string,
): Promise<Record<string, unknown> | null> {
  const gateway = await db.collection(GATEWAYS_COLLECTION).doc(gatewayId).get();
  if (!gateway.exists) return null;
  const gatewayData = gateway.data() as Record<string, unknown> | undefined;
  const allocation = lateDuplicateAllocation(gatewayData);
  if (!allocation) return null;
  const user = await db.collection("users").doc(allocation.ownerUid).get();
  const userData = user.exists
    ? user.data() as Record<string, unknown> | undefined
    : undefined;
  if (!userData || !agentBelongsToAssignedWorkspace(userData, agentId)) {
    return null;
  }
  return parkedRunDuplicate(
    readPath(userData, "provisioning.openclaw.activationLease"),
    allocation,
    eventKey,
  );
}

async function findUsersByAgentId(
  db: Firestore,
  agentId: string,
): Promise<Array<{ uid: string; data: Record<string, unknown> }>> {
  const matches: Array<{ uid: string; data: Record<string, unknown> }> = [];
  const seen = new Set<string>();
  for (const query of [
    db.collection("users").where("provisioning.openclaw.agentId", "==", agentId).limit(10),
    db
      .collection("users")
      .where("provisioning.openclaw.agentIds", "array-contains", agentId)
      .limit(10),
  ]) {
    const snap = await query.get();
    for (const doc of snap.docs) {
      if (seen.has(doc.id)) continue;
      const data = doc.data() as Record<string, unknown> | undefined;
      if (!data || !agentBelongsToAssignedWorkspace(data, agentId)) {
        continue;
      }
      seen.add(doc.id);
      matches.push({ uid: doc.id, data });
    }
  }
  return matches;
}

export async function findAssignedOrInboundMigratingUserByAgentId(
  db: Firestore,
  gatewayId: string,
  agentId: string,
): Promise<{ uid: string; data: Record<string, unknown> } | null> {
  const assigned = await findAssignedUserByAgentId(db, gatewayId, agentId);
  if (assigned) return assigned;

  const candidates = await findUsersByAgentId(db, agentId);
  for (const candidate of candidates) {
    if (await hasRunningInboundMigrationForUid(db, gatewayId, candidate.uid)) {
      return candidate;
    }
  }
  return null;
}

export async function findAssignedOrInboundMigratingOrConfiguredUserByAgentId(
  db: Firestore,
  gatewayId: string,
  podName: string | undefined,
  agentId: string,
): Promise<{ uid: string; data: Record<string, unknown> } | null> {
  const admitted = await findAssignedOrInboundMigratingUserByAgentId(db, gatewayId, agentId);
  if (admitted) return admitted;

  const gatewaySnap = await db.collection(GATEWAYS_COLLECTION).doc(gatewayId).get();
  const gateway = gatewaySnap.data();
  const candidates = await findUsersByAgentId(db, agentId);
  for (const candidate of candidates) {
    const slug = slugFromAssignedUser(candidate.data);
    if (
      slug &&
      configuredBuilderCredentialBootstrapAllowed(gateway, {
        gatewayId,
        podName,
        slug,
        uid: candidate.uid,
      })
    ) {
      return candidate;
    }
  }
  return null;
}

export async function configuredBuilderSlugCredentialBootstrapAllowed(
  db: Firestore,
  gatewayId: string,
  podName: string | undefined,
  slug: string,
): Promise<boolean> {
  const gatewaySnap = await db.collection(GATEWAYS_COLLECTION).doc(gatewayId).get();
  const gateway = gatewaySnap.data();
  const config = projectGatewayMutableConfigForGateway(gateway, gatewayId);
  if (!config) return false;
  return typeof config.ownerUid === "string" &&
    configuredBuilderCredentialBootstrapAllowed(gateway, {
      gatewayId,
      podName,
      slug,
      uid: config.ownerUid,
    });
}

async function requireAssignedUser(
  db: Firestore,
  req: Request,
  res: Response,
): Promise<{ bound: GatewayBinding; uid: string; data: Record<string, unknown> } | null> {
  const bound = boundGateway(req, res);
  if (!bound) return null;
  const uid = typeof req.body?.uid === "string" ? req.body.uid : "";
  if (!uid) {
    res.status(400).json({ error: "uid_required" });
    return null;
  }
  const data = await isAssignedToGateway(db, bound.gatewayId, uid);
  if (!data) {
    res.status(403).json(FORBIDDEN);
    return null;
  }
  return { bound, uid, data };
}

async function requireAssignedSlug(
  db: Firestore,
  req: Request,
  res: Response,
): Promise<{ bound: GatewayBinding; uid: string; slug: string } | null> {
  const bound = boundGateway(req, res);
  if (!bound) return null;
  const slug = typeof req.body?.slug === "string" ? req.body.slug : "";
  if (!isValidUsername(slug)) {
    res.status(400).json({ error: "invalid_slug" });
    return null;
  }
  const uid = await findAssignedUidBySlug(db, bound.gatewayId, slug);
  if (!uid) {
    res.status(403).json(FORBIDDEN);
    return null;
  }
  return { bound, uid, slug };
}

async function requireAssignedAgentWorkspace(
  db: Firestore,
  req: Request,
  res: Response,
): Promise<{
  uid: string;
  slug: string;
  data: Record<string, unknown>;
} | null> {
  const bound = boundGateway(req, res);
  if (!bound) return null;
  const body = objectBody(req);
  const slug = typeof body.workspaceSlug === "string" ? body.workspaceSlug : "";
  if (!isValidUsername(slug)) {
    res.status(400).json({ error: "invalid_workspace_slug" });
    return null;
  }
  const agentId = validAgentId(body.agentId);
  if (!agentId) {
    res.status(400).json({ error: "invalid_agent_id" });
    return null;
  }
  const uid = await findAssignedUidBySlug(db, bound.gatewayId, slug);
  if (!uid) {
    res.status(403).json(FORBIDDEN);
    return null;
  }
  const data = await isAssignedToGateway(db, bound.gatewayId, uid);
  if (!data || !agentBelongsToAssignedWorkspace(data, agentId)) {
    res.status(403).json(FORBIDDEN);
    return null;
  }
  return { uid, slug, data };
}

async function runBrokered(
  res: Response,
  fn: () => Promise<void>,
): Promise<void> {
  try {
    await fn();
  } catch (err) {
    res.status(502).json({ error: err instanceof Error ? err.message : String(err) });
  }
}

async function collectChannelBindings(
  db: Firestore,
  slug: string,
): Promise<FleetBrokerChannelBinding[]> {
  const workspaceRef = db.collection("workspaces").doc(slug);
  const [wsChannels, projects] = await Promise.all([
    workspaceRef.collection("channels").get(),
    workspaceRef.collection("projects").get(),
  ]);

  const bindings: FleetBrokerChannelBinding[] = [];
  for (const ch of wsChannels.docs) {
    const b = mapWorkspaceChannelDoc(ch.data());
    if (b) bindings.push(b);
  }
  for (const p of projects.docs) {
    const projChannels = await p.ref.collection("channels").get();
    for (const ch of projChannels.docs) {
      const b = mapProjectChannelDoc(p.id, ch.data());
      if (b) bindings.push(b);
    }
  }
  return bindings;
}

async function collectProjects(
  db: Firestore,
  slug: string,
): Promise<FleetBrokerProjectRestore[]> {
  const snap = await db.collection("workspaces").doc(slug).collection("projects").get();
  return snap.docs.map((doc) => {
    const data = doc.data() as Record<string, unknown>;
    const out: FleetBrokerProjectRestore = {
      projectSlug: doc.id,
      giteaRepoName: typeof data.giteaRepoName === "string" ? data.giteaRepoName : null,
    };
    if (typeof data.provisioningState === "string") {
      out.provisioningState = data.provisioningState;
    }
    return out;
  });
}

async function isAssignedToGateway(
  db: Firestore,
  gatewayId: string,
  uid: string,
  data?: Record<string, unknown>,
): Promise<Record<string, unknown> | null> {
  const userData =
    data ??
    ((await db.collection("users").doc(uid).get()).data() as Record<string, unknown> | undefined);
  if (!userData) return null;
  return stringAt(userData, OPENCLAW_GATEWAY_ID_FIELD) === gatewayId ? userData : null;
}

// Defense-in-depth against pod identity spoofing: the KSA binds the BARE
// gateway; the pod self-reports its instance id, which under the simple-roll
// model must be the bare gateway id (legacy pods report nothing).
export function isRequestedRevisionAllowed(
  gatewayId: string,
  revisionId: string,
): boolean {
  if (!revisionId) return true; // legacy pod: no filtering
  return revisionId === gatewayId;
}

export async function resolveAssignedUsersRevisionGate(
  db: Firestore,
  gatewayId: string,
  podRevisionId: string,
  options: { requireDurableRoot?: boolean } = {},
): Promise<{ allowed: false } | { allowed: true }> {
  const gatewaySnap = await db.collection(GATEWAYS_COLLECTION).doc(gatewayId).get();
  const gatewayData = gatewaySnap.data();
  if (
    (options.requireDurableRoot && (!gatewaySnap.exists || !podRevisionId)) ||
    (gatewaySnap.exists && !isDurableGatewayRoot(gatewayData, gatewayId))
  ) {
    return { allowed: false };
  }
  if (!isRequestedRevisionAllowed(gatewayId, podRevisionId)) return { allowed: false };
  return { allowed: true };
}

function respondInvalidRevision(res: Response, gatewayId: string, revisionId: string): void {
  res.status(400).json({ error: "invalid_revision", gatewayId, revisionId });
}

async function readAssignmentRosterForGateway(
  db: Firestore,
  gatewayId: string,
): Promise<FleetBrokerAssignmentRosterEntry[] | null> {
  const snap = await db
    .collection(GATEWAYS_COLLECTION)
    .doc(gatewayId)
    .collection(GATEWAY_ASSIGNMENTS_SUBCOLLECTION)
    .get();
  const assignments: FleetBrokerAssignmentRosterEntry[] = [];
  for (const doc of snap.docs) {
    const raw = doc.data() as Record<string, unknown>;
    const assignment = parseAssignmentDoc(doc.id, raw);
    if (
      !assignment ||
      assignment.gatewayId !== gatewayId ||
      (raw.state !== undefined && !isAssignmentState(raw.state)) ||
      (raw.epoch !== undefined &&
        (typeof raw.epoch !== "number" ||
          !Number.isSafeInteger(raw.epoch) ||
          raw.epoch < 0))
    ) {
      return null;
    }
    assignments.push({
      uid: assignment.uid,
      state: assignment.state,
      epoch: assignment.epoch,
    });
  }
  return assignments;
}

function snapshotProvisioningStatus(data: Record<string, unknown>): FleetBrokerProvisioningStatus {
  const status = stringAt(data, "provisioning.openclaw.status");
  return status === "provisioning" || status === "complete" ? status : "";
}

function snapshotOnboardingVibe(data: Record<string, unknown>): string | null {
  const value = readPath(data, "onboarding.vibe");
  return typeof value === "string" ? value : null;
}

function snapshotGreetingPosted(data: Record<string, unknown>): boolean {
  const greeting = readPath(data, "provisioning.openclaw.greeting");
  return Boolean((greeting as { ok?: unknown } | undefined)?.ok);
}

function snapshotBaseFields(
  data: Record<string, unknown>,
  slug: string,
): Omit<
  FleetBrokerUserSnapshot,
  "uid" | "slug" | "channels" | "projects" | "coachToken" | "coachMmUserId" | "coachIdentity"
> {
  const mattermostUserId = stringAt(data, "mattermost.userId") || null;
  return {
    tier: stringAt(data, "tier") || stringAt(data, "subscription.tier") || "trial",
    gatewayId: stringAt(data, OPENCLAW_GATEWAY_ID_FIELD),
    status: snapshotProvisioningStatus(data),
    agentIds: stringArray(readPath(data, "provisioning.openclaw.agentIds")),
    repoUrl: stringAt(data, "provisioning.git.repoUrl"),
    mattermostUserId,
    customerMmUserId: mattermostUserId,
    ...pickPlanInputs(data),
    greetingPosted: snapshotGreetingPosted(data),
    ownerName: stringAt(data, "displayName") || stringAt(data, "username") || slug,
    email: stringAt(data, "email"),
    displayName: stringAt(data, "displayName"),
    lastName: stringAt(data, "lastName"),
    photoURL: stringAt(data, "photoURL"),
    onboardingVibe: snapshotOnboardingVibe(data),
    byotActive: data.byotActive === true,
  };
}

function snapshotCoachFields(
  coachData: Record<string, unknown> | undefined,
): Pick<FleetBrokerUserSnapshot, "coachToken" | "coachMmUserId"> {
  return {
    coachToken: typeof coachData?.personalToken === "string" ? coachData.personalToken : null,
    coachMmUserId:
      typeof coachData?.coachMmUserId === "string" ? coachData.coachMmUserId : null,
  };
}

function snapshotCoachIdentity(
  agentData: Record<string, unknown> | undefined,
): Pick<FleetBrokerUserSnapshot, "coachIdentity"> | Record<string, never> {
  const name = typeof agentData?.name === "string" ? agentData.name : "";
  const emoji = typeof agentData?.avatarEmoji === "string" ? agentData.avatarEmoji : "";
  return name || emoji ? { coachIdentity: { name, emoji } } : {};
}

async function loadSnapshot(
  db: Firestore,
  uid: string,
  data: Record<string, unknown>,
  freeTierModelRef: string,
): Promise<FleetBrokerUserSnapshot | null> {
  const slug = slugFromAssignedUser(data);
  if (!slug || !isValidUsername(slug)) return null;
  const [channels, projects, projectAgents, coachSecret, agentSnap, sysConfig] = await Promise.all([
    collectChannelBindings(db, slug),
    collectProjects(db, slug),
    collectProjectAgentStates(db, uid, slug),
    db.collection("users").doc(uid).collection("secrets").doc("coachMattermost").get(),
    db.collection("agents").doc(uid).get(),
    db.collection("users").doc(uid).collection("system").doc("config").get(),
  ]);
  const coachData = coachSecret.data() as Record<string, unknown> | undefined;
  const agentData = agentSnap.data() as Record<string, unknown> | undefined;
  const credentialProjection = byotSnapshotProjectionFromSystemConfig(
    sysConfig.data() as Record<string, unknown> | undefined,
  );
  const baseFields = snapshotBaseFields(data, slug);
  return {
    uid,
    slug,
    ...baseFields,
    byotActive: credentialProjection.byotActive ?? baseFields.byotActive,
    freeTierModelRef,
    channels,
    projects,
    ...(projectAgents.length > 0 ? { projectAgents } : {}),
    ...snapshotCoachFields(coachData),
    ...snapshotCoachIdentity(agentData),
    ...(credentialProjection.systemConfig ? { systemConfig: credentialProjection.systemConfig } : {}),
  };
}

async function findAssignedUidBySlug(
  db: Firestore,
  gatewayId: string,
  slug: string,
): Promise<string | null> {
  const snap = await db
    .collection("users")
    .where(OPENCLAW_GATEWAY_ID_FIELD, "==", gatewayId)
    .get();
  for (const doc of snap.docs) {
    const data = doc.data() as Record<string, unknown> | undefined;
    if (!data) continue;
    if (slugFromAssignedUser(data) === slug) return doc.id;
  }
  return null;
}

type ResolvedFleetBrokerRouteDeps = {
  db: Firestore;
  resolveFreeTierModel: FreeTierModelResolver;
  provisionMattermost: NonNullable<FleetBrokerRouteDeps["provisionMattermost"]>;
  markProvisioningComplete: NonNullable<FleetBrokerRouteDeps["markProvisioningComplete"]>;
  ensureCommunityMembership: NonNullable<FleetBrokerRouteDeps["ensureCommunityMembership"]>;
  notifyOpsOfSignup: NonNullable<FleetBrokerRouteDeps["notifyOpsOfSignup"]>;
  recordUsageEvent: RecordUsageEvent;
  renderAvatar: RenderAvatar;
  applyCoachIdentity: ApplyCoachIdentity;
  createBlobSignedUrl: CreateBlobSignedUrl;
  executeChatSearch: ExecuteChatSearch;
  executeChatHistory: ExecuteChatHistory;
  resolveChatIdentity: ResolveChatIdentity;
  webResearch: Pick<ReturnType<typeof createWebResearchService>, "search" | "extract">;
  requestBuilderActivation: (
    input: BuilderRuntimeDemandRequest,
  ) => ReturnType<typeof requestBuilderActivationLease>;
  now: () => number;
};

function resolveFleetBrokerRouteDeps(
  opts: { db: Firestore } & FleetBrokerRouteDeps,
): ResolvedFleetBrokerRouteDeps {
  return {
    db: opts.db,
    resolveFreeTierModel: createCachedFreeTierModelResolver({
      db: opts.db,
      onError: (err) => logger.error("fleet-broker free-tier dial resolution failed", { err }),
    }),
    provisionMattermost: opts.provisionMattermost ?? defaultProvisionMattermost,
    markProvisioningComplete:
      opts.markProvisioningComplete ?? defaultMarkProvisioningComplete,
    ensureCommunityMembership:
      opts.ensureCommunityMembership ?? defaultEnsureCommunityMembership,
    notifyOpsOfSignup: opts.notifyOpsOfSignup ?? defaultNotifyOpsOfSignup,
    recordUsageEvent: opts.recordUsageEvent ?? defaultRecordUsageEvent,
    renderAvatar: opts.renderAvatar ?? defaultRenderAvatar,
    applyCoachIdentity: opts.applyCoachIdentity ?? defaultApplyCoachIdentity,
    createBlobSignedUrl: opts.createBlobSignedUrl ?? defaultCreateBlobSignedUrl,
    executeChatSearch: opts.executeChatSearch ?? defaultExecuteChatSearch,
    executeChatHistory: opts.executeChatHistory ?? defaultExecuteChatHistory,
    resolveChatIdentity: opts.resolveChatIdentity ?? defaultResolveChatIdentity,
    webResearch: opts.webResearch ?? createDefaultWebResearch(opts.db),
    requestBuilderActivation:
      opts.requestBuilderActivation ?? requestBuilderActivationLease,
    now: opts.now ?? Date.now,
  };
}

function installSnapshotRoutes(
  router: Router,
  deps: ResolvedFleetBrokerRouteDeps,
): void {
  const { db } = deps;

  router.post("/assignment-roster", async (req, res) => {
    const bound = boundGateway(req, res);
    if (!bound) return;
    const podRevisionId = typeof req.body?.revisionId === "string" ? req.body.revisionId : "";
    const authenticatedRevisionId = revisionIdFromGatewayPodName(
      bound.gatewayId,
      bound.podName,
    );
    if (!authenticatedRevisionId || authenticatedRevisionId !== podRevisionId) {
      respondInvalidRevision(res, bound.gatewayId, podRevisionId);
      return;
    }
    const gate = await resolveAssignedUsersRevisionGate(
      db,
      bound.gatewayId,
      podRevisionId,
      { requireDurableRoot: true },
    );
    if (!gate.allowed) {
      respondInvalidRevision(res, bound.gatewayId, podRevisionId);
      return;
    }
    const assignments = await readAssignmentRosterForGateway(db, bound.gatewayId);
    if (!assignments) {
      logger.error("fleet broker rejected invalid assignment roster", {
        gatewayId: bound.gatewayId,
      });
      res.status(502).json({ error: "invalid_assignment_roster", gatewayId: bound.gatewayId });
      return;
    }
    res.json({ assignments });
  });

  router.post("/assigned-users", async (req, res) => {
    const bound = boundGateway(req, res);
    if (!bound) return;
    const completeOnly = req.body?.completeOnly === true;
    // The pod self-reports its revision ({gw}-r{n}). It's scoped to the bound
    // (bare) tenant by the KSA, but we still validate the requested revision
    // belongs to this gateway and is an active revision (defense-in-depth against
    // same-gateway revision spoofing). Empty is legal only on a pre-backfill pod.
    const podRevisionId = typeof req.body?.revisionId === "string" ? req.body.revisionId : "";
    const gate = await resolveAssignedUsersRevisionGate(db, bound.gatewayId, podRevisionId);
    if (!gate.allowed) {
      respondInvalidRevision(res, bound.gatewayId, podRevisionId);
      return;
    }
    const snap = await db
      .collection("users")
      .where(OPENCLAW_GATEWAY_ID_FIELD, "==", bound.gatewayId)
      .get();
    const freeTierModelRef = (await deps.resolveFreeTierModel()).ref;
    const users: FleetBrokerUserSnapshot[] = [];
    for (const doc of snap.docs) {
      const data = await isAssignedToGateway(db, bound.gatewayId, doc.id, doc.data() as Record<string, unknown>);
      if (!data) continue;
      if (completeOnly && stringAt(data, "provisioning.openclaw.status") !== "complete") {
        continue;
      }
      const snapshot = await loadSnapshot(db, doc.id, data, freeTierModelRef);
      if (snapshot) users.push(snapshot);
    }
    res.json({ users });
  });

  router.post("/uid-for-slug", async (req, res) => {
    const bound = boundGateway(req, res);
    if (!bound) return;
    const slug = typeof req.body?.slug === "string" ? req.body.slug : "";
    if (!isValidUsername(slug)) {
      res.status(400).json({ error: "invalid_slug" });
      return;
    }
    const uid = await findAssignedUidBySlug(db, bound.gatewayId, slug);
    if (!uid) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    res.json({ uid });
  });

  router.post("/configured-builder-bootstrap", async (req, res) => {
    await handleConfiguredBuilderBootstrap(db, req, res);
  });

  router.post("/user-snapshot", async (req, res) => {
    const bound = boundGateway(req, res);
    if (!bound) return;
    const uid = typeof req.body?.uid === "string" ? req.body.uid : "";
    if (!uid) {
      res.status(400).json({ error: "uid_required" });
      return;
    }
    const data = await isAssignedToGateway(db, bound.gatewayId, uid);
    if (!data) {
      res.status(403).json(FORBIDDEN);
      return;
    }
    const snapshot = await loadSnapshot(db, uid, data, (await deps.resolveFreeTierModel()).ref);
    if (!snapshot) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    res.json({ user: snapshot });
  });
}

function configuredBuilderBootstrapRequest(
  gatewayId: string,
  podName: string | undefined,
  body: unknown,
): { slug: string } | null {
  const record = body && typeof body === "object" ? body as Record<string, unknown> : {};
  const requestedRevisionId = typeof record.revisionId === "string" ? record.revisionId : "";
  const slug = typeof record.slug === "string" ? record.slug : "";
  if (!isValidUsername(slug)) return null;
  if (!podBelongsToGateway(gatewayId, podName)) return null;
  if (requestedRevisionId && requestedRevisionId !== gatewayId) return null;
  return { slug };
}

function configuredBuilderBootstrapPayload(input: {
  uid: string;
  slug: string;
  user: Record<string, unknown> | undefined;
  coach: Record<string, unknown> | undefined;
}): FleetBrokerConfiguredBuilderBootstrap | null {
  const { uid, slug, user, coach } = input;
  const agentId = `octogee-${slug}-coach`;
  if (!user || slugFromAssignedUser(user) !== slug) return null;
  if (!agentBelongsToAssignedWorkspace(user, agentId)) return null;
  if (typeof coach?.personalToken !== "string" || coach.personalToken.length === 0) return null;
  return {
    uid,
    slug,
    agentId,
    accountId: `${slug}-coach`,
    coachToken: coach.personalToken,
  };
}

async function handleConfiguredBuilderBootstrap(
  db: Firestore,
  req: Request,
  res: Response,
): Promise<void> {
  const bound = boundGateway(req, res);
  if (!bound) return;
  const request = configuredBuilderBootstrapRequest(bound.gatewayId, bound.podName, req.body);
  if (!request) {
    res.status(403).json(FORBIDDEN);
    return;
  }

  const gatewaySnap = await db.collection(GATEWAYS_COLLECTION).doc(bound.gatewayId).get();
  const gateway = gatewaySnap.data();
  const uid = projectGatewayMutableConfigForGateway(gateway, bound.gatewayId)?.ownerUid ?? null;
  if (
    typeof uid !== "string" ||
    !configuredBuilderCredentialBootstrapAllowed(gateway, {
      gatewayId: bound.gatewayId,
      podName: bound.podName,
      slug: request.slug,
      uid,
    })
  ) {
    res.status(403).json(FORBIDDEN);
    return;
  }

  const [userSnap, coachSnap] = await Promise.all([
    db.collection("users").doc(uid).get(),
    db.collection("users").doc(uid).collection("secrets").doc("coachMattermost").get(),
  ]);
  const bootstrap = configuredBuilderBootstrapPayload({
    uid,
    slug: request.slug,
    user: userSnap.data() as Record<string, unknown> | undefined,
    coach: coachSnap.data() as Record<string, unknown> | undefined,
  });
  if (!bootstrap) {
    res.status(404).json({ error: "configured_builder_bootstrap_unavailable" });
    return;
  }
  res.json({ bootstrap });
}

function installProvisioningRoutes(
  router: Router,
  deps: ResolvedFleetBrokerRouteDeps,
): void {
  const { db, provisionMattermost, markProvisioningComplete, notifyOpsOfSignup, ensureCommunityMembership } = deps;

  router.post("/set-provisioning-status", async (req, res) => {
    const assigned = await requireAssignedUser(db, req, res);
    if (!assigned) return;
    const status = objectBody(req).status;
    if (!isProvisioningStatus(status)) {
      res.status(400).json({ error: "invalid_status" });
      return;
    }
    await runBrokered(res, async () => {
      await db.collection("users").doc(assigned.uid).update({
        "provisioning.openclaw.status": status,
      });
      res.status(204).end();
    });
  });

  router.post("/set-repo-url", async (req, res) => {
    const assigned = await requireAssignedUser(db, req, res);
    if (!assigned) return;
    const repoUrl = objectBody(req).repoUrl;
    if (typeof repoUrl !== "string" || repoUrl.length === 0 || repoUrl.length > 2048) {
      res.status(400).json({ error: "invalid_repo_url" });
      return;
    }
    await runBrokered(res, async () => {
      await db.collection("users").doc(assigned.uid).update({
        "provisioning.git.repoUrl": repoUrl,
        "provisioning.git.createdAt": FieldValue.serverTimestamp(),
      });
      res.status(204).end();
    });
  });

  router.post("/provision-mattermost", async (req, res) => {
    const assigned = await requireAssignedUser(db, req, res);
    if (!assigned) return;
    await runBrokered(res, async () => {
      const mmUpdate = await provisionMattermost({
        uid: assigned.uid,
        userData: assigned.data,
      });
      res.json({ mmUpdate });
    });
  });

  router.post("/set-mattermost-fields", async (req, res) => {
    const assigned = await requireAssignedUser(db, req, res);
    if (!assigned) return;
    const mmUpdate = recordBodyValue(objectBody(req).mmUpdate);
    if (!mmUpdate) {
      res.status(400).json({ error: "invalid_mm_update" });
      return;
    }
    await runBrokered(res, async () => {
      await markProvisioningComplete({
        uid: assigned.uid,
        userData: assigned.data,
        mmUpdate,
      });
      res.status(204).end();
    });
  });

  router.post("/ensure-community-membership", async (req, res) => {
    const assigned = await requireAssignedUser(db, req, res);
    if (!assigned) return;
    const mmUserId = stringAt(assigned.data, "mattermost.userId");
    await runBrokered(res, async () => {
      if (mmUserId) {
        await ensureCommunityMembership({ mmUserId });
      }
      res.status(204).end();
    });
  });

  router.post("/set-greeting-result", async (req, res) => {
    const assigned = await requireAssignedUser(db, req, res);
    if (!assigned) return;
    const result = objectBody(req).result;
    if (!isGreetingResult(result)) {
      res.status(400).json({ error: "invalid_greeting_result" });
      return;
    }
    const greeting = result.ok
      ? { ok: true, jobId: result.jobId, at: FieldValue.serverTimestamp() }
      : { ok: false, error: result.error, at: FieldValue.serverTimestamp() };
    await runBrokered(res, async () => {
      await db.collection("users").doc(assigned.uid).update({
        "provisioning.openclaw.greeting": greeting,
      });
      res.status(204).end();
    });
  });

  router.post("/set-agent-ids", async (req, res) => {
    const assigned = await requireAssignedUser(db, req, res);
    if (!assigned) return;
    const agentIds = validAgentIds(objectBody(req).agentIds);
    if (!agentIds) {
      res.status(400).json({ error: "invalid_agent_ids" });
      return;
    }
    await runBrokered(res, async () => {
      await db.collection("users").doc(assigned.uid).update({
        "provisioning.openclaw.agentIds": agentIds,
      });
      res.status(204).end();
    });
  });

  router.post("/mounted", async (req, res) => {
    const assigned = await requireAssignedUser(db, req, res);
    if (!assigned) return;
    const mounted = objectBody(req).mounted;
    if (typeof mounted !== "boolean") {
      res.status(400).json({ error: "invalid_mounted" });
      return;
    }
    await runBrokered(res, async () => {
      await db.collection("users").doc(assigned.uid).update({
        "provisioning.openclaw.mounted": mounted,
      });
      res.status(204).end();
    });
  });

  router.post("/reconcile-error", async (req, res) => {
    const assigned = await requireAssignedSlug(db, req, res);
    if (!assigned) return;
    const message = objectBody(req).message;
    if (typeof message !== "string" || message.length === 0) {
      res.status(400).json({ error: "invalid_message" });
      return;
    }
    await runBrokered(res, async () => {
      await db.collection("gateways").doc(assigned.bound.gatewayId).set(
        {
          lastError: {
            slug: assigned.slug,
            message: message.slice(0, 2000),
            at: FieldValue.serverTimestamp(),
          },
        },
        { merge: true },
      );
      res.status(204).end();
    });
  });

  router.post("/clear-reconcile-error", async (req, res) => {
    const assigned = await requireAssignedSlug(db, req, res);
    if (!assigned) return;
    await runBrokered(res, async () => {
      const ref = db.collection("gateways").doc(assigned.bound.gatewayId);
      await db.runTransaction(async (txn) => {
        const snap = await txn.get(ref);
        const current = snap.data()?.lastError as { slug?: string } | null | undefined;
        if (current && current.slug === assigned.slug) {
          txn.set(ref, { lastError: null }, { merge: true });
        }
      });
      res.status(204).end();
    });
  });

  router.post("/notify-signup", async (req, res) => {
    const assigned = await requireAssignedUser(db, req, res);
    if (!assigned) return;
    await runBrokered(res, async () => {
      await notifyOpsOfSignup({ uid: assigned.uid, userData: assigned.data });
      res.status(204).end();
    });
  });
}

function installRunActivationRoute(
  router: Router,
  deps: ResolvedFleetBrokerRouteDeps,
): void {
  const { db, requestBuilderActivation, now } = deps;

  router.post("/activity/run-start", async (req, res) => {
    const bound = boundGateway(req, res);
    if (!bound) return;
    const body = objectBody(req);
    const allowed = new Set(["gatewayId", "agentId", "runId"]);
    if (Object.keys(body).some((key) => !allowed.has(key))) {
      res.status(400).json({ error: "invalid_run_activation" });
      return;
    }
    const agentId = validAgentId(body.agentId);
    const runId = validAgentId(body.runId);
    if (!agentId || !runId) {
      res.status(400).json({ error: "invalid_run_activation" });
      return;
    }
    const assigned = await findAssignedUserByAgentId(
      db,
      bound.gatewayId,
      agentId,
    );
    if (!assigned) {
      const duplicate = await findLateParkedRunDuplicate(
        db,
        bound.gatewayId,
        agentId,
        `run-start:${runId}`,
      );
      if (duplicate) {
        res.status(200).json(duplicate);
        return;
      }
      res.status(403).json(FORBIDDEN);
      return;
    }
    const assignmentSnapshot = await db.doc(
      `gateways/${bound.gatewayId}/assignments/${assigned.uid}`,
    ).get();
    const assignment = assignmentSnapshot.exists
      ? assignmentSnapshot.data() as Record<string, unknown>
      : undefined;
    const observedAt = now();
    await runBrokered(res, async () => {
      const result = await requestBuilderActivation({
        db,
        uid: assigned.uid,
        reportingGatewayId: bound.gatewayId,
        assignmentEpoch:
          typeof assignment?.epoch === "number" ? assignment.epoch : undefined,
        eventKey: `run-start:${runId}`,
        cause: "run-start",
        observedAt,
        createdBy: `openclaw-run:${bound.gatewayId}:${agentId}`,
        now: observedAt,
      });
      res.status(result.statusCode).json(result.body);
    });
  });
}

function installGatewayOpsRoutes(
  router: Router,
  deps: ResolvedFleetBrokerRouteDeps,
): void {
  const {
    db,
    recordUsageEvent,
    createBlobSignedUrl,
  } = deps;

  installRunActivationRoute(router, deps);

  router.post("/system-config-status", async (req, res) => {
    const bound = boundGateway(req, res);
    if (!bound) return;
    const revisionId = typeof req.body?.revisionId === "string" ? req.body.revisionId : "";
    const authenticatedRevisionId = revisionIdFromGatewayPodName(bound.gatewayId, bound.podName);
    if (!authenticatedRevisionId || authenticatedRevisionId !== revisionId) {
      respondInvalidRevision(res, bound.gatewayId, revisionId);
      return;
    }
    const status = parseSystemConfigObservedStatus(req.body?.status);
    if (!status) {
      res.status(400).json({ error: "invalid_system_config_status" });
      return;
    }
    await runBrokered(res, async () => {
      const accepted = await recordRevisionSystemConfigStatus(db, {
        gatewayId: bound.gatewayId,
        revisionId,
        status,
      });
      if (!accepted) {
        res.status(409).json({ error: "revision_not_serving_gateway" });
        return;
      }
      res.status(204).end();
    });
  });

  router.post("/prestop-flush", async (req, res) => {
    const bound = boundGateway(req, res);
    if (!bound) return;
    const event = validPreStopFlushEvent(objectBody(req));
    if (!event) {
      res.status(400).json({ error: "invalid_prestop_flush_event" });
      return;
    }
    await runBrokered(res, async () => {
      const gatewayRef = db.collection("gateways").doc(bound.gatewayId);
      const accepted = await db.runTransaction(async (txn) => {
        const gatewaySnap = await txn.get(gatewayRef);
        const gatewayData = gatewaySnap.exists ? gatewaySnap.data() : undefined;
        if (!isDurableGatewayRoot(gatewayData, bound.gatewayId)) return false;
        txn.set(
          gatewayRef,
          {
            lastPreStopFlush: {
              ...event,
              at: FieldValue.serverTimestamp(),
            },
          },
          { merge: true },
        );

        const gatewayClass = gatewayData.gatewayClass;
        const targetGatewayId = warmTargetGatewayId(gatewayData);
        if (
          event.phase === "started" &&
          (gatewayClass === "builder" || gatewayClass === "operator") &&
          targetGatewayId
        ) {
          txn.set(
            gatewayRef,
            {
              preemptionHandoff: {
                status: "requested",
                requestedAt: FieldValue.serverTimestamp(),
                sourceGatewayId: bound.gatewayId,
                targetGatewayId,
                reason: "spot-prestop",
                gatewayClass,
              },
            },
            { merge: true },
          );
        }
        const hasExistingHandoff =
          typeof gatewayData.preemptionHandoff?.status === "string";
        if (event.phase === "completed" && (targetGatewayId || hasExistingHandoff)) {
          txn.set(
            gatewayRef,
            {
              preemptionHandoff: {
                flushCompletedAt: FieldValue.serverTimestamp(),
                flushOk: event.result?.ok === true,
              },
            },
            { merge: true },
          );
        }
        return true;
      });
      if (!accepted) {
        res.status(409).json({ error: "gateway_config_missing", gatewayId: bound.gatewayId });
        return;
      }
      res.status(204).end();
    });
  });

  router.post("/usage-event", async (req, res) => {
    const bound = boundGateway(req, res);
    if (!bound) return;
    const body = objectBody(req);
    const agentId = validAgentId(body.agentId);
    if (!agentId) {
      res.status(400).json({ error: "invalid_agent_id" });
      return;
    }
    const usage = validFleetBrokerUsageData(body.usage);
    if (!usage) {
      res.status(400).json({ error: "invalid_usage" });
      return;
    }
    const assigned = await findAssignedUserByAgentId(db, bound.gatewayId, agentId);
    if (!assigned) {
      res.status(403).json(FORBIDDEN);
      return;
    }
    await runBrokered(res, async () => {
      await recordUsageEvent({
        db,
        uid: assigned.uid,
        agentId,
        usage,
        gatewayId: bound.gatewayId,
      });
      res.status(204).end();
    });
  });

  router.post("/blob/download-url", async (req, res) => {
    const assigned = await requireAssignedSlug(db, req, res);
    if (!assigned) return;
    const relativePath = validBlobRelativePath(objectBody(req).path);
    if (!relativePath) {
      res.status(400).json({ error: "invalid_path" });
      return;
    }
    await runBrokered(res, async () => {
      const signed = await createBlobSignedUrl({
        gcsPath: gcsPathForBlob(assigned.slug, relativePath),
        action: "read",
      });
      res.json(signed);
    });
  });

  router.post("/blob/upload-url", async (req, res) => {
    const assigned = await requireAssignedSlug(db, req, res);
    if (!assigned) return;
    const body = objectBody(req);
    const relativePath = validBlobRelativePath(body.path);
    if (!relativePath) {
      res.status(400).json({ error: "invalid_path" });
      return;
    }
    const size = finiteNonNegative(body.size);
    if (size === null || size > BLOB_SYNC_MAX_SIZE) {
      res.status(400).json({ error: "invalid_size" });
      return;
    }
    await runBrokered(res, async () => {
      const signed = await createBlobSignedUrl({
        gcsPath: gcsPathForBlob(assigned.slug, relativePath),
        action: "write",
        contentType: validContentType(body.mimeType),
      });
      res.json(signed);
    });
  });
}

// A chat-broker caller is validated in three layers, all lane-uniform:
// gateway binding (boundGateway) -> workspace assigned to that gateway ->
// agent id parses AND belongs to that workspace with a minted PAT
// (resolveChatIdentity — the secret's existence IS the capability, so a
// disabled project agent gets a refusal, never a broader token).
function validChatBrokerSiteUrl(value: unknown): string | null {
  return typeof value === "string" && /^https?:\/\//.test(value) ? value : null;
}

function forbiddenChatIdentityCode(code: unknown): boolean {
  return code === "foreign-agent" ||
    code === "no-builder-pat" ||
    code === "no-coach-identity" ||
    code === "no-project-pat" ||
    code === "project-archived";
}

function respondChatIdentityError(res: Response, error: unknown): boolean {
  const code = (error as { code?: unknown }).code;
  if (code === "invalid-agent") {
    res.status(400).json({ error: "invalid_agent_id", code });
    return true;
  }
  if (!forbiddenChatIdentityCode(code)) return false;
  res.status(403).json({ error: "forbidden", code });
  return true;
}

async function requireAssignedChatIdentity(
  deps: ResolvedFleetBrokerRouteDeps,
  req: Request,
  res: Response,
): Promise<{ identity: ChatBrokerIdentity; slug: string } | null> {
  const bound = boundGateway(req, res);
  if (!bound) return null;
  const body = objectBody(req);
  const slug = typeof body.workspaceSlug === "string" ? body.workspaceSlug : "";
  if (!isValidUsername(slug)) {
    res.status(400).json({ error: "invalid_workspace_slug" });
    return null;
  }
  const agentId = validAgentId(body.agentId);
  if (!agentId) {
    res.status(400).json({ error: "invalid_agent_id" });
    return null;
  }
  const siteUrl = validChatBrokerSiteUrl(body.siteUrl);
  if (!siteUrl) {
    res.status(400).json({ error: "invalid_site_url" });
    return null;
  }
  const uid = await findAssignedUidBySlug(deps.db, bound.gatewayId, slug);
  if (!uid) {
    res.status(403).json(FORBIDDEN);
    return null;
  }
  try {
    const resolved = await deps.resolveChatIdentity(deps.db, { uid, slug, agentId });
    return {
      slug,
      identity: {
        pat: resolved.pat,
        coachMmUserId: resolved.coachMmUserId,
        unread: resolved.unread,
        slug,
        siteUrl,
        ...(resolved.canReadChannel
          ? { canReadChannel: resolved.canReadChannel }
          : {}),
        ...(resolved.includeArchivedProjectHistory === true
          ? { includeArchivedProjectHistory: true as const }
          : {}),
      },
    };
  } catch (err) {
    if (respondChatIdentityError(res, err)) return null;
    throw err;
  }
}

async function respondChatBrokerError(res: Response, err: unknown): Promise<void> {
  const { chatBrokerErrorStatus } = await import(
    "../../../gateway-edge/src/lib/chat-broker/execute.js"
  );
  const { status, code } = chatBrokerErrorStatus(err);
  res.status(status).json({
    error: err instanceof Error ? err.message : String(err),
    code,
  });
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function optionalInt(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : undefined;
}

function boundedString(value: unknown, min: number, max: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length >= min && trimmed.length <= max ? trimmed : null;
}

function boundedInteger(value: unknown, min: number, max: number): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max
    ? value
    : undefined;
}

function enumValue<T extends string>(value: unknown, values: readonly T[]): T | undefined {
  return typeof value === "string" && values.includes(value as T) ? (value as T) : undefined;
}

function stringList(value: unknown, maxItems: number, maxLength: number): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > maxItems) return undefined;
  const items = value.map((item) => boundedString(item, 1, maxLength));
  return items.every((item): item is string => item !== null) ? items : undefined;
}

function publicHttpUrl(value: unknown): string | null {
  const raw = boundedString(value, 1, 4_096);
  if (!raw) return null;
  try {
    const parsed = new URL(raw);
    if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || parsed.username || parsed.password) {
      return null;
    }
    const host = parsed.hostname.replace(/^\[|\]$/g, "").toLowerCase();
    const internalName = host === "localhost" || host.endsWith(".localhost") || host.endsWith(".internal");
    const nonPublicIp = isIP(host) !== 0 && !isPublicIp(host);
    return internalName || nonPublicIp ? null : parsed.toString();
  } catch {
    return null;
  }
}

function httpUrls(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length < 1 || value.length > 20) return null;
  const urls = value.map(publicHttpUrl);
  return urls.every((url): url is string => url !== null) ? urls : null;
}

type WebAgentAttribution = {
  gatewayId: string;
  ownerUid: string;
  agentId: string;
  requestId: string;
};

type WebSearchInputResult =
  | { input: WebResearchSearchInput }
  | { error: "invalid_query" | "invalid_provider" | "invalid_search_options" };

function optionalField<K extends string, V>(
  key: K,
  value: V | null | undefined,
): Partial<Record<K, V>> {
  return value === null || value === undefined ? {} : { [key]: value } as Record<K, V>;
}

function braveWebSearchInput(
  body: Record<string, unknown>,
  assigned: WebAgentAttribution,
  query: string,
): WebSearchInputResult {
  const count = boundedInteger(body.count, 1, 10);
  const country = boundedString(body.country, 2, 2);
  const searchLang = boundedString(body.searchLang, 2, 10);
  const uiLang = boundedString(body.uiLang, 2, 10);
  const freshness = enumValue(body.freshness, ["day", "week", "month", "year"] as const);
  const invalid =
    (body.count !== undefined && count === undefined) ||
    (body.country !== undefined && country === null) ||
    (body.searchLang !== undefined && searchLang === null) ||
    (body.uiLang !== undefined && uiLang === null) ||
    (body.freshness !== undefined && freshness === undefined);
  if (invalid) return { error: "invalid_search_options" };
  return {
    input: {
      ...assigned,
      provider: "brave",
      query,
      ...optionalField("count", count),
      ...optionalField("country", country?.toUpperCase()),
      ...optionalField("searchLang", searchLang),
      ...optionalField("uiLang", uiLang),
      ...optionalField("freshness", freshness),
    },
  };
}

function tavilyWebSearchInput(
  body: Record<string, unknown>,
  assigned: WebAgentAttribution,
  query: string,
): WebSearchInputResult {
  const maxResults = boundedInteger(body.maxResults, 1, 20);
  const includeDomains = stringList(body.includeDomains, 20, 253);
  const excludeDomains = stringList(body.excludeDomains, 20, 253);
  const invalid =
    (body.maxResults !== undefined && maxResults === undefined) ||
    (body.includeDomains !== undefined && includeDomains === undefined) ||
    (body.excludeDomains !== undefined && excludeDomains === undefined);
  if (invalid) return { error: "invalid_search_options" };
  const searchDepth = enumValue(body.searchDepth, ["basic", "advanced"] as const);
  const topic = enumValue(body.topic, ["general", "news", "finance"] as const);
  const timeRange = enumValue(body.timeRange, ["day", "week", "month", "year"] as const);
  return {
    input: {
      ...assigned,
      provider: "tavily",
      query,
      ...optionalField("searchDepth", searchDepth),
      ...optionalField("topic", topic),
      ...optionalField("maxResults", maxResults),
      ...optionalField("timeRange", timeRange),
      ...optionalField("includeDomains", includeDomains),
      ...optionalField("excludeDomains", excludeDomains),
    },
  };
}

function webSearchInput(
  body: Record<string, unknown>,
  assigned: WebAgentAttribution,
): WebSearchInputResult {
  const query = boundedString(body.query, 2, 500);
  if (!query) return { error: "invalid_query" };
  const provider = enumValue(body.provider, ["brave", "tavily"] as const);
  if (!provider) return { error: "invalid_provider" };
  return provider === "brave"
    ? braveWebSearchInput(body, assigned, query)
    : tavilyWebSearchInput(body, assigned, query);
}

async function assignedWebAgent(
  db: Firestore,
  req: Request,
  res: Response,
): Promise<WebAgentAttribution | null> {
  const bound = boundGateway(req, res);
  if (!bound) return null;
  const body = objectBody(req);
  const agentId = validAgentId(body.agentId);
  const requestId = boundedString(body.requestId, 1, 200);
  if (!agentId) {
    res.status(400).json({ error: "invalid_agent_id" });
    return null;
  }
  if (!requestId) {
    res.status(400).json({ error: "invalid_request_id" });
    return null;
  }
  const assigned = await findAssignedUserByAgentId(db, bound.gatewayId, agentId);
  if (!assigned) {
    res.status(403).json(FORBIDDEN);
    return null;
  }
  return { gatewayId: bound.gatewayId, ownerUid: assigned.uid, agentId, requestId };
}

function respondWebResearchError(res: Response, error: unknown): void {
  if (error instanceof WebResearchError) {
    res.status(error.status).json({ error: error.message, code: error.code });
    return;
  }
  logger.error("web research broker failed", { error });
  res.status(502).json({ error: "Web research provider failed", code: "provider_error" });
}

function installAgentRoutes(router: Router, deps: ResolvedFleetBrokerRouteDeps): void {
  const { db, renderAvatar, applyCoachIdentity } = deps;

  router.post("/agent/chat-search", async (req, res) => {
    const assigned = await requireAssignedChatIdentity(deps, req, res);
    if (!assigned) return;
    const body = objectBody(req);
    const query = typeof body.query === "string" ? body.query.trim() : "";
    if (query.length < 2) {
      res.status(400).json({ error: "invalid_query" });
      return;
    }
    try {
      const payload = await deps.executeChatSearch(assigned.identity, {
        query,
        scope: body.scope === "current_channel" ? "current_channel" : "all_visible",
        limit: optionalInt(body.limit),
        currentChannelId: optionalString(body.currentChannelId),
      });
      res.json(payload);
    } catch (err) {
      await respondChatBrokerError(res, err);
    }
  });

  router.post("/agent/chat-history", async (req, res) => {
    const assigned = await requireAssignedChatIdentity(deps, req, res);
    if (!assigned) return;
    const body = objectBody(req);
    try {
      const payload = await deps.executeChatHistory(assigned.identity, {
        channel: optionalString(body.channel),
        direction: optionalString(body.direction),
        cursor: optionalString(body.cursor),
        limit: optionalInt(body.limit),
        fromUsername: optionalString(body.fromUsername),
        currentChannelId: optionalString(body.currentChannelId),
      });
      res.json(payload);
    } catch (err) {
      await respondChatBrokerError(res, err);
    }
  });

  router.post("/agent/web-search", async (req, res) => {
    const assigned = await assignedWebAgent(db, req, res);
    if (!assigned) return;
    const parsed = webSearchInput(objectBody(req), assigned);
    if ("error" in parsed) {
      res.status(400).json({ error: parsed.error });
      return;
    }
    try {
      res.json(await deps.webResearch.search(parsed.input));
    } catch (error) {
      respondWebResearchError(res, error);
    }
  });

  router.post("/agent/web-extract", async (req, res) => {
    const assigned = await assignedWebAgent(db, req, res);
    if (!assigned) return;
    const body = objectBody(req);
    const urls = httpUrls(body.urls);
    if (!urls) {
      res.status(400).json({ error: "invalid_urls" });
      return;
    }
    const query = body.query === undefined ? undefined : boundedString(body.query, 1, 500);
    if (body.query !== undefined && !query) {
      res.status(400).json({ error: "invalid_query" });
      return;
    }
    const extractDepth = enumValue(body.extractDepth, ["basic", "advanced"] as const);
    if (body.extractDepth !== undefined && !extractDepth) {
      res.status(400).json({ error: "invalid_extract_depth" });
      return;
    }
    const input: WebResearchExtractInput = {
      ...assigned,
      urls,
      ...(query ? { query } : {}),
      ...(extractDepth ? { extractDepth } : {}),
    };
    try {
      res.json(await deps.webResearch.extract(input));
    } catch (error) {
      respondWebResearchError(res, error);
    }
  });

  router.post("/agent/set-coach-identity", async (req, res) => {
    const assigned = await requireAssignedAgentWorkspace(db, req, res);
    if (!assigned) return;
    const body = objectBody(req);

    const patch: { name?: string; persona?: string; avatarPng?: Buffer } = {};
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (name) {
      if (name.length > 80) {
        res.status(400).json({ error: "invalid_name" });
        return;
      }
      patch.name = name;
    }
    const vibe = typeof body.vibe === "string" ? body.vibe : body.persona;
    if (typeof vibe === "string") {
      if (vibe.length > 2000) {
        res.status(400).json({ error: "invalid_persona" });
        return;
      }
      patch.persona = vibe;
    }
    if (typeof body.avatarBase64 === "string" && body.avatarBase64) {
      const raw = Buffer.from(body.avatarBase64, "base64");
      try {
        patch.avatarPng = await renderAvatar(raw);
      } catch {
        res.status(400).json({ error: "invalid_avatar" });
        return;
      }
    }
    if (
      patch.name === undefined &&
      patch.persona === undefined &&
      patch.avatarPng === undefined
    ) {
      res.status(400).json({ error: "empty_identity" });
      return;
    }

    await runBrokered(res, async () => {
      const updated = await applyCoachIdentity({
        uid: assigned.uid,
        slug: assigned.slug,
        name: patch.name,
        persona: patch.persona,
        avatarPng: patch.avatarPng,
      });
      res.json({ updated });
    });
  });
}

export function createFleetBrokerRoutes(opts: { db: Firestore } & FleetBrokerRouteDeps): Router {
  const router = Router();
  const deps = resolveFleetBrokerRouteDeps(opts);
  installSnapshotRoutes(router, deps);
  installProvisioningRoutes(router, deps);
  installGatewayOpsRoutes(router, deps);
  installAgentRoutes(router, deps);
  return router;
}
