import { isIP } from "node:net";
import { Router, type Request, type Response } from "express";
import { FieldValue, type Firestore } from "firebase-admin/firestore";

import { logger } from "../../../gateway-edge/src/middleware/logging.js";
import {
  isValidProjectId,
  isValidUsername,
  projectAgentId,
} from "@octogee/shared/types/identity";
import { MANIFEST_OBJECT_SUFFIX } from "@octogee/core/workspace-manifest";
import { pickPlanInputs } from "@octogee/shared/types/billing";
import { projectAgentEnabled, projectRepoSourceFromDoc } from "@octogee/shared/types/project";
import {
  createCachedBuilderAgentDefaultResolver,
  createCachedFreeTierModelResolver,
  type BuilderAgentDefaultResolver,
  type FreeTierModelResolver,
} from "../lib/platform-model-config.js";
import type {
  BuilderRuntimeStateRecoveryTier,
  FleetBrokerBlobSignedUrl,
  FleetBrokerBuilderRuntimeStatePruneResult,
  FleetBrokerBuilderRuntimeStateSnapshotUrls,
  FleetBrokerAssignmentRosterEntry,
  FleetBrokerChannelBinding,
  FleetBrokerConfiguredBuilderBootstrap,
  FleetBrokerConfiguredBuilderProjectCredential,
  FleetBrokerGreetingResult,
  FleetBrokerMattermostUpdate,
  FleetBrokerPreStopFlushEvent,
  FleetBrokerPreStopFlushStep,
  FleetBrokerProjectCheckoutScope,
  FleetBrokerProjectAgent,
  FleetBrokerProjectRestore,
  FleetBrokerProvisioningStatus,
  FleetBrokerUsageData,
  FleetBrokerUserSnapshot,
} from "@octogee/shared/types/fleet-broker";
import { BUILDER_RUNTIME_STATE_RECOVERY_TIERS } from "@octogee/shared/types/fleet-broker";
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
import {
  createOwnerWorkspaceTurnVerifier,
  type OwnerWorkspaceTurnVerifier,
} from "../lib/openclaw-owner-turn.js";
import {
  reconcileCoachProjectMembership,
  type ProjectCoachMembershipInput,
} from "../lib/project-coach-membership.js";

type GatewayBinding = Extract<Express.Request["boundTenant"], { kind: "gateway" }>;

const FORBIDDEN = { error: "forbidden" } as const;
const OPENCLAW_GATEWAY_ID_FIELD = "provisioning.openclaw.gatewayId";
const RECONCILE_ERROR_REPORT_WINDOW_MS = 60_000;
const MATTERMOST_USER_ID_RE = /^[a-z0-9]{26}$/u;

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
  /** 0 means only-if-absent; any other generation makes the write a compare-and-set. */
  ifGenerationMatch?: number | string;
}) => Promise<FleetBrokerBlobSignedUrl>;

type PruneBuilderRuntimeState = (input: {
  canonicalPath: string;
  runtimeStatePrefix: string;
  now: number;
}) => Promise<number>;

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
  platformAdminMmUserId?: string;
  reconcileCoachProjectMembership?: (input: ProjectCoachMembershipInput) => Promise<void>;
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
  pruneBuilderRuntimeState?: PruneBuilderRuntimeState;
  executeChatSearch?: ExecuteChatSearch;
  executeChatHistory?: ExecuteChatHistory;
  resolveChatIdentity?: ResolveChatIdentity;
  verifyOwnerWorkspaceTurn?: OwnerWorkspaceTurnVerifier;
  webResearch?: Pick<ReturnType<typeof createWebResearchService>, "search" | "extract">;
  onSignupOfferBudgetInterruption?: (input: {
    uid: string;
    reason: "waiting_for_unlock" | "hard_cap_exhausted";
  }) => void | Promise<void>;
  now?: () => number;
}

const BLOB_SIGNED_URL_TTL_MS = 10 * 60 * 1000;
const BLOB_SYNC_MAX_SIZE = 100 * 1024 * 1024;
const BUILDER_RUNTIME_STATE_MAX_SIZE = 64 * 1024 * 1024;
const BUILDER_RUNTIME_STATE_CONTENT_TYPE = "application/vnd.sqlite3";
const BUILDER_RUNTIME_STATE_MINUTE_RETENTION_MS = 10 * 60_000;
const BUILDER_RUNTIME_STATE_HOUR_RETENTION_MS = 24 * 60 * 60_000;
const BUILDER_RUNTIME_STATE_DAY_RETENTION_MS = 30 * 24 * 60 * 60_000;

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

function createDefaultWebResearch(
  db: Firestore,
  onSignupOfferBudgetInterruption?: FleetBrokerRouteDeps["onSignupOfferBudgetInterruption"],
) {
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
    onSignupOfferBudgetInterruption,
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
      ...(input.ifGenerationMatch === undefined
        ? {}
        : { queryParams: { ifGenerationMatch: String(input.ifGenerationMatch) } }),
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
  if (parts[0] === "runtime-state") return "";
  return p;
}

/**
 * A manifest write is always conditional — an unconditional one would silently
 * drop the other writer's entries.
 */
function validGenerationPrecondition(value: unknown): string | null {
  if (typeof value !== "string" || !/^\d{1,20}$/u.test(value)) return null;
  return value;
}

function validContentType(value: unknown): string {
  if (typeof value !== "string") return "application/octet-stream";
  const p = value.trim();
  if (p.length === 0 || p.length > 200 || /[\r\n]/.test(p)) {
    return "application/octet-stream";
  }
  return p;
}

function validBuilderRuntimeStateRecoveryTiers(
  value: unknown,
): BuilderRuntimeStateRecoveryTier[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > BUILDER_RUNTIME_STATE_RECOVERY_TIERS.length) {
    return null;
  }
  if (!value.every((tier) => typeof tier === "string" && BUILDER_RUNTIME_STATE_RECOVERY_TIERS.includes(
    tier as BuilderRuntimeStateRecoveryTier,
  ))) return null;
  const tiers = value as BuilderRuntimeStateRecoveryTier[];
  if (!tiers.includes("minute") || new Set(tiers).size !== tiers.length) return null;
  return tiers;
}

function gcsPathForBlob(slug: string, relativePath: string): string {
  return `customers/${slug}/${relativePath}`;
}

/**
 * Derived from the assigned slug, never from the request: `validBlobRelativePath`
 * deliberately rejects dot-prefixed paths, so the manifest is unreachable through
 * the generic blob endpoints and only these routes can name it.
 */
function gcsPathForWorkspaceManifest(slug: string): string {
  return `customers/${slug}/${MANIFEST_OBJECT_SUFFIX}`;
}

function gcsPathForBuilderRuntimeStateRoot(slug: string): string {
  return `customers/${slug}/runtime-state`;
}

function gcsPathForBuilderRuntimeState(slug: string): string {
  return `${gcsPathForBuilderRuntimeStateRoot(slug)}/openclaw.sqlite`;
}

function padUtcPart(value: number): string {
  return String(value).padStart(2, "0");
}

function runtimeStateSnapshotDate(now: number): Date {
  const date = new Date(now);
  if (!Number.isFinite(date.getTime())) throw new Error("runtime-state snapshot time is invalid");
  return date;
}

function runtimeStateRecoveryTimestampValue(
  tier: BuilderRuntimeStateRecoveryTier,
  day: string,
  hour: string,
  minute: string,
): string {
  if (tier === "minute") return `${day}T${hour}${minute}Z`;
  if (tier === "hour") return `${day}T${hour}Z`;
  return day;
}

function runtimeStateRecoveryObjectPath(
  slug: string,
  tier: BuilderRuntimeStateRecoveryTier,
  now: number,
): string {
  const date = runtimeStateSnapshotDate(now);
  const day = `${date.getUTCFullYear()}${padUtcPart(date.getUTCMonth() + 1)}${padUtcPart(date.getUTCDate())}`;
  const timestamp = runtimeStateRecoveryTimestampValue(
    tier,
    day,
    padUtcPart(date.getUTCHours()),
    padUtcPart(date.getUTCMinutes()),
  );
  return `${gcsPathForBuilderRuntimeStateRoot(slug)}/recovery/${tier}/${timestamp}.sqlite`;
}

function runtimeStateRecoveryTimestampMatch(
  tier: BuilderRuntimeStateRecoveryTier,
  value: string,
): RegExpExecArray | null {
  if (tier === "minute") return /^(\d{8})T(\d{2})(\d{2})Z$/u.exec(value);
  if (tier === "hour") return /^(\d{8})T(\d{2})Z$/u.exec(value);
  return /^(\d{8})$/u.exec(value);
}

function runtimeStateRecoveryTimestamp(
  runtimeStatePrefix: string,
  gcsPath: string,
): { tier: BuilderRuntimeStateRecoveryTier; timestamp: number } | null {
  const relative = gcsPath.startsWith(`${runtimeStatePrefix}/`)
    ? gcsPath.slice(runtimeStatePrefix.length + 1)
    : "";
  const match = /^recovery\/(minute|hour|day)\/(.+)\.sqlite$/u.exec(relative);
  if (!match) return null;
  const tier = match[1] as BuilderRuntimeStateRecoveryTier;
  const timestampValue = match[2] ?? "";
  const timestampMatch = runtimeStateRecoveryTimestampMatch(tier, timestampValue);
  if (!timestampMatch) return null;
  const day = timestampMatch[1] ?? "";
  const hour = timestampMatch[2];
  const minute = timestampMatch[3];
  const year = Number(day.slice(0, 4));
  const month = Number(day.slice(4, 6));
  const date = Number(day.slice(6, 8));
  const parsedHour = hour === undefined ? 0 : Number(hour);
  const parsedMinute = minute === undefined ? 0 : Number(minute);
  const timestamp = Date.UTC(year, month - 1, date, parsedHour, parsedMinute);
  const parsed = new Date(timestamp);
  if (
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() + 1 !== month ||
    parsed.getUTCDate() !== date ||
    parsed.getUTCHours() !== parsedHour ||
    parsed.getUTCMinutes() !== parsedMinute
  ) return null;
  return { tier, timestamp };
}

function runtimeStateRetentionMs(tier: BuilderRuntimeStateRecoveryTier): number {
  if (tier === "minute") return BUILDER_RUNTIME_STATE_MINUTE_RETENTION_MS;
  if (tier === "hour") return BUILDER_RUNTIME_STATE_HOUR_RETENTION_MS;
  return BUILDER_RUNTIME_STATE_DAY_RETENTION_MS;
}

export interface BuilderRuntimeStateStoredGeneration {
  gcsPath: string;
  generation: string;
  timeCreated: string | null;
}

function expiredCanonicalRuntimeStateGeneration(input: {
  generation: BuilderRuntimeStateStoredGeneration;
  liveCanonicalGeneration: string | null;
  cutoff: number;
}): boolean {
  if (
    input.liveCanonicalGeneration === null ||
    input.generation.generation === input.liveCanonicalGeneration
  ) return false;
  const created = input.generation.timeCreated === null
    ? Number.NaN
    : Date.parse(input.generation.timeCreated);
  if (!Number.isFinite(created)) {
    throw new Error("runtime-state noncurrent canonical generation lacks a valid creation time");
  }
  if (created > input.cutoff) return false;
  if (!input.generation.generation) {
    throw new Error("runtime-state canonical generation is missing its generation identifier");
  }
  return true;
}

function expiredRecoveryRuntimeStateGeneration(input: {
  generation: BuilderRuntimeStateStoredGeneration;
  runtimeStatePrefix: string;
  now: number;
}): boolean {
  const recovery = runtimeStateRecoveryTimestamp(
    input.runtimeStatePrefix,
    input.generation.gcsPath,
  );
  if (!recovery || recovery.timestamp > input.now - runtimeStateRetentionMs(recovery.tier)) {
    return false;
  }
  if (!input.generation.generation) {
    throw new Error("runtime-state recovery generation is missing its generation identifier");
  }
  return true;
}

export function builderRuntimeStatePruneCandidates(input: {
  canonicalPath: string;
  runtimeStatePrefix: string;
  liveCanonicalGeneration: string | null;
  now: number;
  generations: readonly BuilderRuntimeStateStoredGeneration[];
}): BuilderRuntimeStateStoredGeneration[] {
  if (!Number.isFinite(input.now)) throw new Error("runtime-state prune time is invalid");
  const candidates: BuilderRuntimeStateStoredGeneration[] = [];
  for (const generation of input.generations) {
    if (generation.gcsPath === input.canonicalPath) {
      if (expiredCanonicalRuntimeStateGeneration({
        generation,
        liveCanonicalGeneration: input.liveCanonicalGeneration,
        cutoff: input.now - BUILDER_RUNTIME_STATE_MINUTE_RETENTION_MS,
      })) candidates.push(generation);
      continue;
    }
    if (expiredRecoveryRuntimeStateGeneration({
      generation,
      runtimeStatePrefix: input.runtimeStatePrefix,
      now: input.now,
    })) candidates.push(generation);
  }
  return candidates;
}

const defaultPruneBuilderRuntimeState: PruneBuilderRuntimeState = async (input) => {
  const { getStorage } = await import("firebase-admin/storage");
  const bucket = getStorage().bucket();
  const [liveMetadata] = await bucket.file(input.canonicalPath).getMetadata();
  const liveGenerationValue = liveMetadata.generation;
  if (typeof liveGenerationValue !== "string" && typeof liveGenerationValue !== "number") {
    throw new Error("runtime-state live canonical object lacks a generation identifier");
  }
  const liveCanonicalGeneration = String(liveGenerationValue);
  const [files] = await bucket.getFiles({
    prefix: `${input.runtimeStatePrefix}/`,
    versions: true,
  });
  const candidates = builderRuntimeStatePruneCandidates({
    ...input,
    liveCanonicalGeneration,
    generations: files.map((file) => {
      const generationValue = file.generation ?? file.metadata.generation;
      return {
        gcsPath: file.name,
        generation: typeof generationValue === "string" || typeof generationValue === "number"
          ? String(generationValue)
          : "",
        timeCreated: typeof file.metadata.timeCreated === "string" ? file.metadata.timeCreated : null,
      };
    }),
  });
  await Promise.all(candidates.map(async (candidate) => {
    await bucket.file(candidate.gcsPath, { generation: candidate.generation }).delete({
      ifGenerationMatch: candidate.generation,
    });
  }));
  return candidates.length;
};

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
  bound: GatewayBinding;
  agentId: string;
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
  return { bound, agentId, uid, slug, data };
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

export async function collectChannelBindings(
  db: Firestore,
  slug: string,
): Promise<{
  bindings: FleetBrokerChannelBinding[];
  projectMemberships: Array<{ projectId: string; channelIds: string[] }>;
}> {
  const workspaceRef = db.collection("workspaces").doc(slug);
  const [wsChannels, projects] = await Promise.all([
    workspaceRef.collection("channels").get(),
    workspaceRef.collection("projects").get(),
  ]);

  const bindings: FleetBrokerChannelBinding[] = [];
  const projectMemberships: Array<{ projectId: string; channelIds: string[] }> = [];
  for (const ch of wsChannels.docs) {
    const b = mapWorkspaceChannelDoc(ch.data());
    if (b) bindings.push(b);
  }
  for (const p of projects.docs) {
    const projChannels = await p.ref.collection("channels").get();
    const channelIds: string[] = [];
    for (const ch of projChannels.docs) {
      const data = ch.data();
      const b = mapProjectChannelDoc(p.id, data);
      if (b) bindings.push(b);
      const channelId = (data.mattermost as { channelId?: unknown } | undefined)?.channelId;
      if (typeof channelId === "string" && channelId) channelIds.push(channelId);
    }
    if (channelIds.length > 0) projectMemberships.push({ projectId: p.id, channelIds });
  }
  return { bindings, projectMemberships };
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
    if (data.checkoutEnabled === false) {
      out.checkoutEnabled = false;
    }
    if (typeof data.recipe === "string") {
      out.recipe = data.recipe;
    }
    const repoSource = projectRepoSourceFromDoc(data.repoSource);
    if (repoSource) {
      out.repoSource = repoSource;
    }
    return out;
  });
}

export function projectCheckoutScopeForGatewayRoot(
  gatewayData: unknown,
  gatewayId: string,
  uid: string,
  slug: string,
): FleetBrokerProjectCheckoutScope {
  const root = projectGatewayDesiredRootForGateway(gatewayData, gatewayId);
  if (!root) {
    return "workspace-only";
  }
  if (root.gatewayClass === "shared") return "workspace-and-projects";
  if (root.ownerUid !== uid || root.builderSlug !== slug) return "workspace-only";
  if (
    (root.gatewayClass === "builder" || root.gatewayClass === "operator") &&
    root.allocation?.kind === "disposable-builder" &&
    root.allocation.claimedByUid === uid
  ) {
    return "workspace-and-projects";
  }
  return "workspace-only";
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
  "uid" | "slug" | "channels" | "projectCheckoutScope" | "projects" | "coachToken" | "coachMmUserId" | "coachIdentity"
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

function trustedPlatformAdminMattermostUserId(value: unknown): string | null {
  return typeof value === "string" && MATTERMOST_USER_ID_RE.test(value) ? value : null;
}

interface SnapshotModelDials {
  freeTierModelRef: string;
  builderAgentDefault: FleetBrokerUserSnapshot["builderAgentDefault"];
}

interface LoadSnapshotOptions {
  modelDials: SnapshotModelDials;
  projectCheckoutScope: FleetBrokerProjectCheckoutScope;
  platformAdminMmUserId: string | null;
}

async function loadSnapshot(
  db: Firestore,
  uid: string,
  data: Record<string, unknown>,
  options: LoadSnapshotOptions,
): Promise<FleetBrokerUserSnapshot | null> {
  const { modelDials, projectCheckoutScope, platformAdminMmUserId } = options;
  const slug = slugFromAssignedUser(data);
  if (!slug || !isValidUsername(slug)) return null;
  const [collectedChannels, projects, projectAgents, coachSecret, agentSnap, sysConfig] = await Promise.all([
    collectChannelBindings(db, slug),
    projectCheckoutScope === "workspace-and-projects"
      ? collectProjects(db, slug)
      : Promise.resolve([]),
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
  const channels = collectedChannels.bindings;
  return {
    uid,
    slug,
    ...baseFields,
    byotActive: credentialProjection.byotActive ?? baseFields.byotActive,
    freeTierModelRef: modelDials.freeTierModelRef,
    builderAgentDefault: modelDials.builderAgentDefault,
    channels,
    projectCheckoutScope,
    projects,
    ...(projectAgents.length > 0 ? { projectAgents } : {}),
    ...snapshotCoachFields(coachData),
    ...snapshotCoachIdentity(agentData),
    ...(platformAdminMmUserId ? { platformAdminMmUserId } : {}),
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

async function findUidBySlug(
  db: Firestore,
  gatewayId: string,
  podName: string | undefined,
  slug: string,
): Promise<string | null> {
  const assignedUid = await findAssignedUidBySlug(db, gatewayId, slug);
  if (assignedUid) return assignedUid;

  const gateway = (
    await db.collection(GATEWAYS_COLLECTION).doc(gatewayId).get()
  ).data();
  const uid = projectGatewayMutableConfigForGateway(gateway, gatewayId)?.ownerUid ?? null;
  if (
    typeof uid !== "string" ||
    !configuredBuilderCredentialBootstrapAllowed(gateway, {
      gatewayId,
      podName,
      slug,
      uid,
    })
  ) return null;

  const user = (
    await db.collection("users").doc(uid).get()
  ).data() as Record<string, unknown> | undefined;
  return slugFromAssignedUser(user) === slug ? uid : null;
}

type ResolvedFleetBrokerRouteDeps = {
  db: Firestore;
  resolveFreeTierModel: FreeTierModelResolver;
  resolveBuilderAgentDefault: BuilderAgentDefaultResolver;
  provisionMattermost: NonNullable<FleetBrokerRouteDeps["provisionMattermost"]>;
  markProvisioningComplete: NonNullable<FleetBrokerRouteDeps["markProvisioningComplete"]>;
  ensureCommunityMembership: NonNullable<FleetBrokerRouteDeps["ensureCommunityMembership"]>;
  notifyOpsOfSignup: NonNullable<FleetBrokerRouteDeps["notifyOpsOfSignup"]>;
  recordUsageEvent: RecordUsageEvent;
  renderAvatar: RenderAvatar;
  applyCoachIdentity: ApplyCoachIdentity;
  createBlobSignedUrl: CreateBlobSignedUrl;
  pruneBuilderRuntimeState: PruneBuilderRuntimeState;
  executeChatSearch: ExecuteChatSearch;
  executeChatHistory: ExecuteChatHistory;
  resolveChatIdentity: ResolveChatIdentity;
  verifyOwnerWorkspaceTurn: OwnerWorkspaceTurnVerifier;
  webResearch: Pick<ReturnType<typeof createWebResearchService>, "search" | "extract">;
  now: () => number;
  reconcileCoachProjectMembership: (input: ProjectCoachMembershipInput) => Promise<void>;
};

function ownerWorkspaceTurnVerifier(
  opts: { db: Firestore } & FleetBrokerRouteDeps,
): OwnerWorkspaceTurnVerifier {
  return opts.verifyOwnerWorkspaceTurn ?? createOwnerWorkspaceTurnVerifier(opts.db);
}

function projectCoachMembershipReconciler(
  opts: FleetBrokerRouteDeps,
): (input: ProjectCoachMembershipInput) => Promise<void> {
  return opts.reconcileCoachProjectMembership ?? reconcileCoachProjectMembership;
}

async function verifyOwnerWorkspaceTurnFailClosed(
  verify: OwnerWorkspaceTurnVerifier,
  input: Parameters<OwnerWorkspaceTurnVerifier>[0],
  operation: string,
): Promise<boolean> {
  try {
    return await verify(input);
  } catch (error) {
    logger.error("[fleet-broker] owner turn verification failed", {
      operation,
      gatewayId: input.gatewayId,
      agentId: input.agentId,
      err: error,
    });
    return false;
  }
}

function resolveFleetBrokerRouteDeps(
  opts: { db: Firestore } & FleetBrokerRouteDeps,
): ResolvedFleetBrokerRouteDeps {
  return {
    db: opts.db,
    resolveFreeTierModel: createCachedFreeTierModelResolver({
      db: opts.db,
      onError: (err) => logger.error("fleet-broker free-tier dial resolution failed", { err }),
    }),
    resolveBuilderAgentDefault: createCachedBuilderAgentDefaultResolver({
      db: opts.db,
      onError: (err) =>
        logger.error("fleet-broker builder-agent dial resolution failed", { err }),
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
    pruneBuilderRuntimeState: opts.pruneBuilderRuntimeState ?? defaultPruneBuilderRuntimeState,
    executeChatSearch: opts.executeChatSearch ?? defaultExecuteChatSearch,
    executeChatHistory: opts.executeChatHistory ?? defaultExecuteChatHistory,
    resolveChatIdentity: opts.resolveChatIdentity ?? defaultResolveChatIdentity,
    verifyOwnerWorkspaceTurn: ownerWorkspaceTurnVerifier(opts),
    webResearch: opts.webResearch ?? createDefaultWebResearch(
      opts.db,
      opts.onSignupOfferBudgetInterruption,
    ),
    now: opts.now ?? Date.now,
    reconcileCoachProjectMembership: projectCoachMembershipReconciler(opts),
  };
}

function installSnapshotRoutes(
  router: Router,
  deps: ResolvedFleetBrokerRouteDeps,
  platformAdminMmUserId: string | null,
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
    const modelDials = {
      freeTierModelRef: (await deps.resolveFreeTierModel()).ref,
      builderAgentDefault: await deps.resolveBuilderAgentDefault(),
    };
    const gatewayData = (
      await db.collection(GATEWAYS_COLLECTION).doc(bound.gatewayId).get()
    ).data();
    const users: FleetBrokerUserSnapshot[] = [];
    for (const doc of snap.docs) {
      const data = await isAssignedToGateway(db, bound.gatewayId, doc.id, doc.data() as Record<string, unknown>);
      if (!data) continue;
      if (completeOnly && stringAt(data, "provisioning.openclaw.status") !== "complete") {
        continue;
      }
      const slug = slugFromAssignedUser(data);
      if (!slug) continue;
      const snapshot = await loadSnapshot(
        db,
        doc.id,
        data,
        {
          modelDials,
          projectCheckoutScope: projectCheckoutScopeForGatewayRoot(
            gatewayData,
            bound.gatewayId,
            doc.id,
            slug,
          ),
          platformAdminMmUserId,
        },
      );
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
    const uid = await findUidBySlug(db, bound.gatewayId, bound.podName, slug);
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
    const slug = slugFromAssignedUser(data);
    if (!slug) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const gatewayData = (
      await db.collection(GATEWAYS_COLLECTION).doc(bound.gatewayId).get()
    ).data();
    const snapshot = await loadSnapshot(
      db,
      uid,
      data,
      {
        modelDials: {
          freeTierModelRef: (await deps.resolveFreeTierModel()).ref,
          builderAgentDefault: await deps.resolveBuilderAgentDefault(),
        },
        projectCheckoutScope: projectCheckoutScopeForGatewayRoot(
          gatewayData,
          bound.gatewayId,
          uid,
          slug,
        ),
        platformAdminMmUserId,
      },
    );
    if (!snapshot) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    res.json({ user: snapshot });
  });

  router.post("/reconcile-project-coach-membership", async (req, res) => {
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
    const slug = slugFromAssignedUser(data);
    if (!slug) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const [collectedChannels, coachSecret, projectAgents] = await Promise.all([
      collectChannelBindings(db, slug),
      db.collection("users").doc(uid).collection("secrets").doc("coachMattermost").get(),
      collectProjectAgentStates(db, uid, slug),
    ]);
    const coach = snapshotCoachFields(
      coachSecret.data() as Record<string, unknown> | undefined,
    );
    const agentByProject = new Map(projectAgents.map((agent) => [agent.projectId, agent]));
    await deps.reconcileCoachProjectMembership({
      coachMmUserId: coach.coachMmUserId,
      projects: collectedChannels.projectMemberships.map(({ projectId, channelIds }) => {
        const agent = agentByProject.get(projectId);
        return {
          projectId,
          projectAgentEnabled: projectAgentEnabled(agent),
          projectAgentMmUserId: agent?.mmUserId ?? null,
          channelIds,
        };
      }),
    });
    res.status(204).end();
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

async function requireConfiguredBuilderRuntimeState(
  db: Firestore,
  req: Request,
  res: Response,
): Promise<{ bound: GatewayBinding; slug: string } | null> {
  const bound = boundGateway(req, res);
  if (!bound) return null;
  const request = configuredBuilderBootstrapRequest(
    bound.gatewayId,
    bound.podName,
    req.body,
  );
  if (!request) {
    res.status(403).json(FORBIDDEN);
    return null;
  }

  const gatewaySnap = await db.collection(GATEWAYS_COLLECTION).doc(bound.gatewayId).get();
  const gateway = gatewaySnap.data();
  const config = projectGatewayMutableConfigForGateway(gateway, bound.gatewayId);
  const uid = config?.ownerUid;
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
    return null;
  }
  return { bound, slug: request.slug };
}

function configuredBuilderBootstrapPayload(input: {
  uid: string;
  slug: string;
  user: Record<string, unknown> | undefined;
  coach: Record<string, unknown> | undefined;
  projectCredentials: FleetBrokerConfiguredBuilderProjectCredential[];
}): FleetBrokerConfiguredBuilderBootstrap | null {
  const { uid, slug, user, coach, projectCredentials } = input;
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
    projectCredentials,
  };
}

function configuredBuilderProjectCredentials(
  slug: string,
  projectAgents: readonly FleetBrokerProjectAgent[],
): FleetBrokerConfiguredBuilderProjectCredential[] {
  const credentials: FleetBrokerConfiguredBuilderProjectCredential[] = [];
  for (const project of projectAgents) {
    if (
      !project.enabled ||
      !isValidProjectId(project.projectId) ||
      typeof project.token !== "string" ||
      project.token.length === 0
    ) continue;
    credentials.push({
      projectId: project.projectId,
      agentId: projectAgentId(slug, project.projectId),
      accountId: `${slug}-proj-${project.projectId}`,
      token: project.token,
    });
  }
  return credentials.sort((a, b) => a.projectId.localeCompare(b.projectId));
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

  const [userSnap, coachSnap, projectAgents] = await Promise.all([
    db.collection("users").doc(uid).get(),
    db.collection("users").doc(uid).collection("secrets").doc("coachMattermost").get(),
    collectProjectAgentStates(db, uid, request.slug),
  ]);
  const bootstrap = configuredBuilderBootstrapPayload({
    uid,
    slug: request.slug,
    user: userSnap.data() as Record<string, unknown> | undefined,
    coach: coachSnap.data() as Record<string, unknown> | undefined,
    projectCredentials: configuredBuilderProjectCredentials(request.slug, projectAgents),
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
  const { db, provisionMattermost, markProvisioningComplete, notifyOpsOfSignup, ensureCommunityMembership, now } = deps;
  // A pod re-reports the same mount failure every reconcile cycle, and each write
  // to gateways/{id} costs the fleet a Firestore snapshot event. Repeats inside
  // the window are acknowledged without a write; anything new lands immediately.
  const reportedReconcileErrors = new Map<string, { report: string; at: number }>();

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
        "provisioning.status": status === "complete" ? "complete" : "in_progress",
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
    const { gatewayId } = assigned.bound;
    const truncated = message.slice(0, 2000);
    const report = `${assigned.slug}\0${truncated}`;
    const at = now();
    const reported = reportedReconcileErrors.get(gatewayId);
    if (
      reported &&
      reported.report === report &&
      at - reported.at < RECONCILE_ERROR_REPORT_WINDOW_MS
    ) {
      res.status(204).end();
      return;
    }
    await runBrokered(res, async () => {
      await db.collection("gateways").doc(gatewayId).set(
        {
          lastError: {
            slug: assigned.slug,
            message: truncated,
            at: FieldValue.serverTimestamp(),
          },
        },
        { merge: true },
      );
      reportedReconcileErrors.set(gatewayId, { report, at });
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
      reportedReconcileErrors.delete(assigned.bound.gatewayId);
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

/**
 * The manifest is the one blob object the pod may not name for itself, so it gets
 * its own routes rather than riding the generic blob path.
 */
function installWorkspaceManifestRoutes(
  router: Router,
  deps: ResolvedFleetBrokerRouteDeps,
): void {
  const { db, createBlobSignedUrl } = deps;

  router.post("/blob/manifest/read-url", async (req, res) => {
    const assigned = await requireAssignedSlug(db, req, res);
    if (!assigned) return;
    await runBrokered(res, async () => {
      const signed = await createBlobSignedUrl({
        gcsPath: gcsPathForWorkspaceManifest(assigned.slug),
        action: "read",
      });
      res.json(signed);
    });
  });

  router.post("/blob/manifest/write-url", async (req, res) => {
    const assigned = await requireAssignedSlug(db, req, res);
    if (!assigned) return;
    const precondition = validGenerationPrecondition(objectBody(req).ifGenerationMatch);
    if (precondition === null) {
      res.status(400).json({ error: "invalid_generation" });
      return;
    }
    await runBrokered(res, async () => {
      const signed = await createBlobSignedUrl({
        gcsPath: gcsPathForWorkspaceManifest(assigned.slug),
        action: "write",
        contentType: "application/json",
        ifGenerationMatch: precondition,
      });
      res.json(signed);
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
    pruneBuilderRuntimeState,
    now,
  } = deps;

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

  installWorkspaceManifestRoutes(router, deps);

  router.post("/builder-runtime-state/download-url", async (req, res) => {
    const configured = await requireConfiguredBuilderRuntimeState(db, req, res);
    if (!configured) return;
    await runBrokered(res, async () => {
      const signed = await createBlobSignedUrl({
        gcsPath: gcsPathForBuilderRuntimeState(configured.slug),
        action: "read",
      });
      res.json(signed);
    });
  });

  router.post("/builder-runtime-state/snapshot-urls", async (req, res) => {
    const configured = await requireConfiguredBuilderRuntimeState(db, req, res);
    if (!configured) return;
    const body = objectBody(req);
    const size = finiteNonNegative(body.size);
    if (size === null || size > BUILDER_RUNTIME_STATE_MAX_SIZE) {
      res.status(400).json({ error: "invalid_size" });
      return;
    }
    const recoveryTiers = validBuilderRuntimeStateRecoveryTiers(body.recoveryTiers);
    if (!recoveryTiers) {
      res.status(400).json({ error: "invalid_recovery_tiers" });
      return;
    }
    await runBrokered(res, async () => {
      const snapshotAt = now();
      const live = await createBlobSignedUrl({
        gcsPath: gcsPathForBuilderRuntimeState(configured.slug),
        action: "write",
        contentType: BUILDER_RUNTIME_STATE_CONTENT_TYPE,
      });
      const recovery = await Promise.all(recoveryTiers.map((tier) => createBlobSignedUrl({
        gcsPath: runtimeStateRecoveryObjectPath(configured.slug, tier, snapshotAt),
        action: "write",
        contentType: BUILDER_RUNTIME_STATE_CONTENT_TYPE,
        ifGenerationMatch: 0,
      })));
      const response: FleetBrokerBuilderRuntimeStateSnapshotUrls = { live, recovery };
      res.json(response);
    });
  });

  router.post("/builder-runtime-state/prune", async (req, res) => {
    const configured = await requireConfiguredBuilderRuntimeState(db, req, res);
    if (!configured) return;
    await runBrokered(res, async () => {
      const deleted = await pruneBuilderRuntimeState({
        canonicalPath: gcsPathForBuilderRuntimeState(configured.slug),
        runtimeStatePrefix: gcsPathForBuilderRuntimeStateRoot(configured.slug),
        now: now(),
      });
      const response: FleetBrokerBuilderRuntimeStatePruneResult = { deleted };
      res.json(response);
    });
  });
}

// A chat-broker caller is validated in three layers:
// gateway binding (boundGateway) -> workspace assigned to that gateway ->
// exact workspace-owner turn proof -> Builder PAT resolution.
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

async function assignedChatOwnerTurnAllowed(input: {
  deps: ResolvedFleetBrokerRouteDeps;
  req: Request;
  gatewayId: string;
  uid: string;
  data: Record<string, unknown> | null;
  agentId: string;
}): Promise<boolean> {
  if (!input.data || !agentBelongsToAssignedWorkspace(input.data, input.agentId)) return false;
  return verifyOwnerWorkspaceTurnFailClosed(input.deps.verifyOwnerWorkspaceTurn, {
    req: input.req,
    gatewayId: input.gatewayId,
    agentId: input.agentId,
    ownerUid: input.uid,
    assignedData: input.data,
  }, "agent-chat");
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
  const data = await isAssignedToGateway(deps.db, bound.gatewayId, uid);
  if (!await assignedChatOwnerTurnAllowed({
    deps,
    req,
    gatewayId: bound.gatewayId,
    uid,
    data,
    agentId,
  })) {
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
    if (!await verifyOwnerWorkspaceTurnFailClosed(deps.verifyOwnerWorkspaceTurn, {
      req,
      gatewayId: assigned.bound.gatewayId,
      agentId: assigned.agentId,
      ownerUid: assigned.uid,
      assignedData: assigned.data,
    }, "set-coach-identity")) {
      res.status(403).json(FORBIDDEN);
      return;
    }
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
  const platformAdminMmUserId = trustedPlatformAdminMattermostUserId(
    opts.platformAdminMmUserId ?? process.env.MM_ADMIN_USER_ID,
  );
  installSnapshotRoutes(router, deps, platformAdminMmUserId);
  installProvisioningRoutes(router, deps);
  installGatewayOpsRoutes(router, deps);
  installAgentRoutes(router, deps);
  return router;
}
