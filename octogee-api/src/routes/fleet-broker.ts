import { sharedAgentAnchorMigrationScope } from "../lib/shared-agent-anchor-migration.js";
import { SharedContextPendingError } from "../lib/native-shared-context-job.js";
import { createGcsSharedContextObjectStore, type SharedContextObjectStore } from "../lib/native-shared-context-object.js";
import { authorizeSharedContextCheckpoint } from "../lib/native-shared-context-checkpoint.js";
import { nativeSharedContextRestoreHeld } from "@octogee/core/assigned-roster";
import { readCustomerRestoreAuthoritySnapshot, type FleetStateFirestore } from "@octogee/core/fleet-state";
import { configuredBuilderPreparationAllowed } from "../lib/builder-preparation.js";
import { completeProjectAgentReadiness } from "../lib/project-agent-readiness-delivery.js";
import { parseProjectAgentReadinessReports } from "../lib/project-agent-readiness.js";
import { streamAssignmentChanges } from "./fleet-assignment-watch.js";
import { readComputerRuntimeObservation, recordComputerDiskObservation, recordComputerBootRecovery, recordComputerImageObservation, recordComputerHomeCheckpoint, recordComputerPreemptionNotice } from "../lib/computer-runtime-observation.js";
import { readComputerEgress, recordComputerEgress } from "../lib/computer-egress-state.js";
import { isIP } from "node:net";
import {
  COMPUTER_HOME_CHECKPOINT_CONTENT_TYPE,
  COMPUTER_HOME_CHECKPOINT_KEEP,
  COMPUTER_HOME_CHECKPOINT_MAX_BYTES,
  computerHomeCheckpointName,
  gatewayVmRuntimeDocPath,
  isGatewayVmDiskSample,
  isGatewayVmBootRecoverySample,
  isGatewayVmImageSample,
  isGatewayEgressMode,
  isGatewayVmRuntimeBundle,
  isDisposableHomeCheckpoint,
  sameHomeCheckpoint,
  resolveGatewayRuntime,
  homeCheckpointOutstanding,
  type GatewayVmHomeCheckpoint,
  type GatewayVmEgressState,
  type GatewayVmHomeState,
  type GatewayVmRuntimeRequest,
  type GatewayVmRuntimeResponse,
} from "@octogee/shared/types/glm";
import {
  ComputerHomeCheckpointError,
  computerHomeCheckpointPath,
  computerHomeCheckpointsPrefix,
  computerHomeCurrentPath,
  createGcsComputerHomeStore,
  validComputerHomeCheckpointName,
  validSha256,
  type ComputerHomeStore,
} from "../lib/computer-home-checkpoint.js";
import { Router, type Request, type Response } from "express";
import { FieldValue, type Firestore, type QuerySnapshot } from "firebase-admin/firestore";

import { logger } from "../../../gateway-edge/src/middleware/logging.js";
import { parseAgentLook, type AgentLook } from "@octogee/shared/types/agent-look";
import { parseTimeZone } from "@octogee/shared/types/time-zone";
import { DEFAULT_AGENT_LOOK, characterSvg } from "@octogee/shared/types/agent-characters";
import {
  isValidProjectId,
  isValidUsername,
  parseAgentId,
  projectAgentId,
} from "@octogee/shared/types/identity";
import { MANIFEST_OBJECT_SUFFIX } from "@octogee/core/workspace-manifest";
import { pickPlanInputs } from "@octogee/shared/types/billing";
import { projectAgentConfigured, projectRepoSourceFromDoc } from "@octogee/shared/types/project";
import {
  createCachedBuilderAgentDefaultResolver,
  createCachedFreeTierModelResolver,
  type BuilderAgentDefaultResolver,
  type FreeTierModelResolver,
} from "../lib/platform-model-config.js";
import type {
  FleetBrokerAgentAnchor,
  FleetBrokerAgentAnchorMigration,
  FleetBrokerAgentAnchors,
  FleetBrokerGatewayStateAnchor,
  BuilderRuntimeStateRecoveryTier,
  FleetBrokerBlobSignedUrl,
  FleetBrokerBuilderRuntimeStatePruneResult,
  FleetBrokerComputerHomeCheckpointCommit,
  FleetBrokerComputerHomeCheckpointUrl,
  FleetBrokerComputerHomeDownload,
  FleetBrokerComputerHomePruneResult,
  FleetBrokerComputerEgress,
  FleetBrokerBuilderRuntimeStateSnapshotUrls,
  FleetBrokerAssignmentRosterEntry,
  FleetBrokerChannelBinding,
  FleetBrokerConfiguredBuilderBootstrap,
  FleetBrokerConfiguredBuilderDesk,
  FleetBrokerConfiguredBuilderProjectCredential,
  FleetBrokerCustomerRuntimeReset,
  FleetBrokerMattermostUpdate,
  FleetBrokerNpmRegistryCredentials,
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
import type { BuilderIdentity } from "@octogee/shared/types/builder-identity";
import { isDeveloperToolchainStatus } from "@octogee/shared/types/developer-toolchain";
import {
  byotSnapshotProjectionFromSystemConfig,
  collectProjectAgentStates,
  deriveSlug,
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
  customerRuntimeMutationFenced,
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
import { createOpenClawBootSentinelStore } from "../lib/openclaw-boot-sentinel.js";
import {
  createOwnerWorkspaceTurnVerifier,
  type OwnerWorkspaceTurnVerifier,
} from "../lib/openclaw-owner-turn.js";
import {
  reconcileCoachProjectMembership,
  type ProjectCoachMembershipInput,
  type ProjectCoachMembershipResult,
} from "../lib/project-coach-membership.js";
import {
  InMemoryNpmCacheCapabilityStore,
  NPM_CACHE_CAPABILITY_AUDIENCE,
  NpmCacheCapabilityIssueError,
  npmCacheProxyRegistryUrl,
  type NpmCacheCapabilityStore,
} from "../lib/npm-cache-capabilities.js";

type GatewayBinding = Extract<Express.Request["boundTenant"], { kind: "gateway" }>;

const FORBIDDEN = { error: "forbidden" } as const;
const OPENCLAW_GATEWAY_ID_FIELD = "provisioning.openclaw.gatewayId";
const RECONCILE_ERROR_REPORT_WINDOW_MS = 60_000;

type RecordUsageEvent = (input: {
  db: Firestore;
  uid: string;
  agentId: string;
  usage: FleetBrokerUsageData;
  gatewayId: string;
}) => Promise<void>;

type ReadBlobMetadata = (gcsPath: string) => Promise<{ generation?: unknown; size?: unknown; md5Hash?: unknown }>;

type CreateBlobSignedUrl = (input: {
  gcsPath: string;
  action: "read" | "write";
  contentType?: string;
  ifGenerationMatch?: number | string;
  generation?: string;
  contentMd5?: string;
  contentLength?: number;
}) => Promise<FleetBrokerBlobSignedUrl>;

type PruneBuilderRuntimeState = (input: {
  canonicalPath: string;
  runtimeStatePrefix: string;
  allocationGeneration: number;
  now: number;
  confirmAllocationCurrent: () => Promise<void>;
}) => Promise<number>;

type RenderAvatar = (bytes: Buffer) => Promise<Buffer>;

function validIdentityEmoji(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= 32;
}

type ApplyCoachIdentity = (input: {
  uid: string;
  slug: string;
  name?: string;
  persona?: string;
  emoji?: string;
  avatarPng?: Buffer;
  look?: AgentLook;
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
  reconcileCoachProjectMembership?: (input: ProjectCoachMembershipInput) => Promise<ProjectCoachMembershipResult>;
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
  readBlobMetadata?: ReadBlobMetadata;
  pruneBuilderRuntimeState?: PruneBuilderRuntimeState;
  computerHomeStore?: ComputerHomeStore;
  sharedContextObjectStore?: SharedContextObjectStore;
  executeChatSearch?: ExecuteChatSearch;
  executeChatHistory?: ExecuteChatHistory;
  resolveChatIdentity?: ResolveChatIdentity;
  verifyOwnerWorkspaceTurn?: OwnerWorkspaceTurnVerifier;
  webResearch?: Pick<ReturnType<typeof createWebResearchService>, "search" | "extract">;
  onSignupOfferBudgetInterruption?: (input: {
    uid: string;
    reason: "waiting_for_unlock" | "hard_cap_exhausted";
  }) => void | Promise<void>;
  npmCacheCapabilities?: NpmCacheCapabilityStore;
  npmCacheRegistryUrl?: string;
  reportNpmCacheCapabilityFailure?: (input: {
    gatewayId: string;
    reason: "capacity-exhausted" | "rate-limited" | "unexpected-error";
  }) => void;
  now?: () => number;
}

const BLOB_SIGNED_URL_TTL_MS = 10 * 60 * 1000;
const BLOB_SYNC_MAX_SIZE = 100 * 1024 * 1024;
const BUILDER_RUNTIME_STATE_MAX_SIZE = 64 * 1024 * 1024;
const BUILDER_RUNTIME_STATE_CONTENT_TYPE = "application/gzip";
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
    { name: input.name, persona: input.persona, emoji: input.emoji, avatarPng: input.avatarPng, look: input.look },
    { slug: input.slug },
  );
};

async function applyDefaultCoachLook(
  input: { uid: string; slug: string },
  deps: { renderAvatar: RenderAvatar; applyCoachIdentity: ApplyCoachIdentity },
): Promise<void> {
  try {
    const avatarPng = await deps.renderAvatar(Buffer.from(characterSvg(DEFAULT_AGENT_LOOK), "utf8"));
    await deps.applyCoachIdentity({ ...input, avatarPng, look: DEFAULT_AGENT_LOOK });
  } catch (error) {
    logger.error("[fleet-broker] default coach look was not applied", { uid: input.uid, error });
  }
}

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

const defaultReadBlobMetadata: ReadBlobMetadata = async (gcsPath) => {
  const { getStorage } = await import("firebase-admin/storage");
  const [metadata] = await getStorage().bucket().file(gcsPath).getMetadata();
  return metadata;
};

const defaultCreateBlobSignedUrl: CreateBlobSignedUrl = async (input) => {
  const { getStorage } = await import("firebase-admin/storage");
  const expires = Date.now() + BLOB_SIGNED_URL_TTL_MS;
  const requiredHeaders = {
    ...(input.ifGenerationMatch === undefined ? {} : { "x-goog-if-generation-match": String(input.ifGenerationMatch) }),
    ...(input.contentMd5 === undefined ? {} : { "content-md5": input.contentMd5 }),
    ...(input.contentLength === undefined ? {} : { "content-length": String(input.contentLength) }),
  };
  const [url] = await getStorage()
    .bucket()
    .file(input.gcsPath)
    .getSignedUrl({
      version: "v4",
      action: input.action,
      expires,
      ...(input.action === "write" ? { contentType: input.contentType } : {}),
      ...(input.contentMd5 ? { contentMd5: input.contentMd5 } : {}),
      ...(Object.keys(requiredHeaders).length ? { extensionHeaders: requiredHeaders } : {}),
      ...(input.generation ? { queryParams: { generation: input.generation } } : {}),
    });
  return {
    url,
    method: input.action === "read" ? "GET" : "PUT",
    gcsPath: input.gcsPath,
    expiresAt: new Date(expires).toISOString(),
    ...(Object.keys(requiredHeaders).length ? { requiredHeaders } : {}),
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

function gcsPathForWorkspaceManifest(slug: string): string {
  return `customers/${slug}/${MANIFEST_OBJECT_SUFFIX}`;
}

function gcsPathForBuilderRuntimeStateRoot(slug: string): string {
  return `customers/${slug}/runtime-state`;
}

function gcsPathForBuilderRuntimeState(scope: BuilderRuntimeStateScope): string {
  return `${gcsPathForBuilderRuntimeStateRoot(scope.slug)}/allocations/${scope.gatewayId}-g${scope.generation}/checkpoint.tar.gz`;
}

const ALLOCATION_RUNTIME_STATE_PATH = /^allocations\/[^/]+-g([1-9]\d*)\/checkpoint\.tar\.gz$/u;

function allocationRuntimeStateGeneration(runtimeStatePrefix: string, gcsPath: string): number | null {
  if (!gcsPath.startsWith(`${runtimeStatePrefix}/`)) return null;
  const match = ALLOCATION_RUNTIME_STATE_PATH.exec(gcsPath.slice(runtimeStatePrefix.length + 1));
  const generation = match ? Number(match[1]) : Number.NaN;
  return Number.isSafeInteger(generation) ? generation : null;
}

export class BuilderRuntimeStateAllocationSupersededError extends Error {
  constructor(readonly scope: BuilderRuntimeStateScope) {
    super(`runtime-state allocation ${scope.gatewayId}-g${scope.generation} is no longer current`);
    this.name = "BuilderRuntimeStateAllocationSupersededError";
  }
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
  return `${gcsPathForBuilderRuntimeStateRoot(slug)}/recovery/${tier}/${timestamp}.tar.gz`;
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
  const match = /^recovery\/(minute|hour|day)\/(.+)\.tar\.gz$/u.exec(relative);
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
  allocationGeneration: number;
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
    const allocationGeneration = allocationRuntimeStateGeneration(input.runtimeStatePrefix, generation.gcsPath);
    if (allocationGeneration !== null) {
      if (allocationGeneration >= input.allocationGeneration) continue;
      if (!generation.generation) {
        throw new Error("runtime-state earlier allocation object is missing its generation identifier");
      }
      candidates.push(generation);
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
  await input.confirmAllocationCurrent();
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
  const uid = config.ownerUid;
  if (typeof uid !== "string" || !configuredBuilderCredentialBootstrapAllowed(gateway, {
      gatewayId,
      podName,
      slug,
      uid,
    })) return false;
  const user = (await db.collection("users").doc(uid).get()).data();
  if (slugFromAssignedUser(user) !== slug) return false;
  const assignedGatewayId = stringAt(user, OPENCLAW_GATEWAY_ID_FIELD);
  if (assignedGatewayId === gatewayId) return true;
  if (await hasRunningInboundMigrationForUid(db, gatewayId, uid)) return true;
  const root = projectGatewayDesiredRootForGateway(gateway, gatewayId);
  return assignedGatewayId === "" && stringAt(user, "provisioning.openclaw.status") !== "complete" &&
    root?.liveRelease === null && root.latestRelease === 1;
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
  preparingProjectRead = false,
): Promise<{ bound: GatewayBinding; uid: string; slug: string } | null> {
  const bound = boundGateway(req, res);
  if (!bound) return null;
  const slug = typeof req.body?.slug === "string" ? req.body.slug : "";
  if (!isValidUsername(slug)) {
    res.status(400).json({ error: "invalid_slug" });
    return null;
  }
  const assignedUid = await findAssignedUidBySlug(db, bound.gatewayId, slug);
  const uid = assignedUid ?? (preparingProjectRead ? (await configuredBuilderNpmSubject(db, bound, slug, "preparation"))?.uid : null);
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

function configuredBuilderNpmOwnerUid(input: {
  gatewayData: Record<string, unknown> | undefined;
  bound: GatewayBinding;
  slug: string;
}): string | null {
  const gateway = projectGatewayDesiredRootForGateway(
    input.gatewayData,
    input.bound.gatewayId,
  );
  const ownerUid = gateway?.ownerUid;
  if (typeof ownerUid !== "string") return null;
  if (!configuredBuilderCredentialBootstrapAllowed(input.gatewayData, {
    gatewayId: input.bound.gatewayId,
    podName: input.bound.podName,
    slug: input.slug,
    uid: ownerUid,
  })) return null;
  return ownerUid;
}

function assignedBuilderNpmUid(input: {
  docs: Array<{ id: string; data(): unknown }>;
  gatewayId: string;
  slug: string;
}): string | null {
  const matches = input.docs
    .map((doc) => parseAssignmentDoc(doc.id, doc.data() as Record<string, unknown>))
    .filter((assignment) =>
      assignment?.gatewayId === input.gatewayId && assignment.slug === input.slug,
    );
  return matches.length === 1 ? matches[0]!.uid : null;
}


async function configuredBuilderNpmSubject(
  db: Firestore,
  bound: GatewayBinding,
  slug: string,
  mode: "assignment-or-preparation" | "preparation" = "assignment-or-preparation",
): Promise<{ uid: string } | null> {
  if (!bound.podUid) return null;
  const [gatewaySnap, assignmentsSnap] = await Promise.all([
    db.collection(GATEWAYS_COLLECTION).doc(bound.gatewayId).get(),
    db
      .collection(GATEWAYS_COLLECTION)
      .doc(bound.gatewayId)
      .collection(GATEWAY_ASSIGNMENTS_SUBCOLLECTION)
      .get(),
  ]);
  const gatewayData = gatewaySnap.data() as Record<string, unknown> | undefined;
  const ownerUid = configuredBuilderNpmOwnerUid({ gatewayData, bound, slug });
  if (!ownerUid) return null;
  const assignedUid = assignedBuilderNpmUid({
    docs: assignmentsSnap.docs,
    gatewayId: bound.gatewayId,
    slug,
  });
  if (assignedUid === ownerUid && mode === "assignment-or-preparation") return { uid: ownerUid };
  if (assignmentsSnap.docs.length > 0 && assignedUid !== ownerUid) return null;
  return await configuredBuilderPreparationAllowed(db, bound, slug, ownerUid) ? { uid: ownerUid } : null;
}

function installNpmCacheCapabilityRoutes(
  router: Router,
  db: Firestore,
  deps: ResolvedFleetBrokerRouteDeps,
): void {
  router.post("/npm-registry-credentials", async (req, res) => {
    const bound = boundGateway(req, res);
    if (!bound) return;
    const slug = typeof req.body?.slug === "string" ? req.body.slug : "";
    if (!isValidUsername(slug)) {
      res.status(400).json({ error: "invalid_slug" });
      return;
    }
    const subject = await configuredBuilderNpmSubject(db, bound, slug);
    if (!subject || !bound.podUid) {
      res.status(403).json(FORBIDDEN);
      return;
    }
    try {
      const credentials: FleetBrokerNpmRegistryCredentials = deps.npmCacheCapabilities.issue({
        subject: {
          gatewayId: bound.gatewayId,
          uid: subject.uid,
          slug,
          podUid: bound.podUid,
        },
        registryUrl: deps.npmCacheRegistryUrl,
        nowMs: deps.now(),
      });
      res.set("Cache-Control", "no-store");
      res.set("Pragma", "no-cache");
      res.json(credentials);
    } catch (error) {
      const reason = error instanceof NpmCacheCapabilityIssueError
        ? error.reasonCode
        : "unexpected-error";
      deps.reportNpmCacheCapabilityFailure({ gatewayId: bound.gatewayId, reason });
      res.status(reason === "rate-limited" ? 429 : 503).json({
        error: reason === "rate-limited"
          ? "npm_registry_capability_rate_limited"
          : "npm_registry_unavailable",
      });
    }
  });

  router.post("/npm-cache-authorize", (req, res) => {
    const bound = req.boundTenant;
    if (bound?.kind !== "platform" || bound.actor !== "npm-cache-proxy") {
      res.status(403).json(FORBIDDEN);
      return;
    }
    const token = typeof req.body?.token === "string" ? req.body.token : "";
    const authorization = deps.npmCacheCapabilities.authorize({
      token,
      nowMs: deps.now(),
    });
    if (!authorization || authorization.audience !== NPM_CACHE_CAPABILITY_AUDIENCE) {
      res.status(403).json(FORBIDDEN);
      return;
    }
    res.set("Cache-Control", "no-store");
    res.json({ authorization });
  });
}

function snapshotProvisioningStatus(data: Record<string, unknown>): FleetBrokerProvisioningStatus {
  const status = stringAt(data, "provisioning.openclaw.status");
  return status === "provisioning" || status === "complete" ? status : "";
}

function snapshotOnboardingVibe(data: Record<string, unknown>): string | null {
  const value = readPath(data, "onboarding.vibe");
  return typeof value === "string" ? value : null;
}


type StoredRuntimeReset = FleetBrokerCustomerRuntimeReset | (
  Omit<FleetBrokerCustomerRuntimeReset, "status"> & {
    status: "acknowledged";
    acknowledgedAt: unknown;
  }
);

function storedRuntimeReset(
  data: Record<string, unknown>,
): StoredRuntimeReset | undefined {
  const raw = readPath(data, "provisioning.openclaw.runtimeReset");
  if (raw === undefined) return undefined;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("invalid customer runtime reset marker");
  }
  const marker = raw as Record<string, unknown>;
  const stringFields = [
    "uid",
    "slug",
    "operationId",
    "sourceGatewayId",
    "targetGatewayId",
    "disposableLeaseId",
  ] as const;
  const validStrings = stringFields.every(
    (field) => typeof marker[field] === "string" && marker[field].length > 0,
  );
  const validIntegers = ["generation", "disposableLeaseGeneration", "requestedAt"].every(
    (field) => Number.isSafeInteger(marker[field]) && (marker[field] as number) >= 0,
  );
  const validStatus = marker.status === "pending" ||
    (marker.status === "acknowledged" && marker.acknowledgedAt !== undefined);
  if (!validStatus || !validStrings || !validIntegers || !isValidUsername(marker.slug)) {
    throw new Error("invalid customer runtime reset marker");
  }
  return marker as unknown as StoredRuntimeReset;
}

function snapshotRuntimeReset(
  data: Record<string, unknown>,
): FleetBrokerCustomerRuntimeReset | undefined {
  const marker = storedRuntimeReset(data);
  return marker?.status === "pending" ? marker : undefined;
}

async function admittedRuntimeReset(
  db: Firestore,
  uid: string,
  data: Record<string, unknown>,
): Promise<FleetBrokerCustomerRuntimeReset | undefined> {
  const marker = snapshotRuntimeReset(data);
  if (!marker) return undefined;
  const assignmentSnapshot = await db
    .collection(GATEWAYS_COLLECTION)
    .doc(marker.targetGatewayId)
    .collection(GATEWAY_ASSIGNMENTS_SUBCOLLECTION)
    .doc(uid)
    .get();
  const assignmentData = assignmentSnapshot.data() as Record<string, unknown> | undefined;
  const assignment = assignmentData ? parseAssignmentDoc(uid, assignmentData) : null;
  const exact = [
    marker.uid === uid,
    marker.slug === slugFromAssignedUser(data),
    marker.targetGatewayId === stringAt(data, OPENCLAW_GATEWAY_ID_FIELD),
    assignment?.uid === uid,
    assignment?.gatewayId === marker.targetGatewayId,
    assignment?.epoch === marker.generation,
    assignmentData?.source === "repair",
    assignmentData?.updatedByOperationId === marker.operationId,
  ].every(Boolean);
  if (!exact) throw new Error("customer runtime reset assignment fence changed");
  return marker;
}

export function snapshotGreetingPosted(data: Record<string, unknown>): boolean {
  const greeting = readPath(data, "provisioning.openclaw.greeting") as { ok?: unknown; jobId?: unknown } | undefined;
  return greeting?.ok === true && typeof greeting.jobId === "string" && greeting.jobId.trim().length > 0;
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
    ownerName: stringAt(data, "displayName") || stringAt(data, "username") || slug,
    email: stringAt(data, "email"),
    displayName: stringAt(data, "displayName"),
    lastName: stringAt(data, "lastName"),
    timeZone: storedTimeZone(data),
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

interface SnapshotModelDials {
  freeTierModelRef: string;
  builderAgentDefault: FleetBrokerUserSnapshot["builderAgentDefault"];
}

interface LoadSnapshotOptions {
  modelDials: SnapshotModelDials;
  gatewayId: string;
  gatewayData: Record<string, unknown> | undefined;
}

async function loadSnapshot(
  db: Firestore,
  uid: string,
  data: Record<string, unknown>,
  options: LoadSnapshotOptions,
): Promise<(FleetBrokerUserSnapshot & { greetingPosted: boolean }) | null> {
  const { modelDials } = options;
  const slug = slugFromAssignedUser(data);
  if (!slug || !isValidUsername(slug)) return null;
  const projectCheckoutScope = projectCheckoutScopeForGatewayRoot(options.gatewayData, options.gatewayId, uid, slug);
  const [collectedChannels, projects, projectAgents, coachSecret, agentSnap, sysConfig, runtimeReset, restoreAuthority] = await Promise.all([
    collectChannelBindings(db, slug),
    projectCheckoutScope === "workspace-and-projects"
      ? collectProjects(db, slug)
      : Promise.resolve([]),
    collectProjectAgentStates(db, uid, slug),
    db.collection("users").doc(uid).collection("secrets").doc("coachMattermost").get(),
    db.collection("agents").doc(uid).get(),
    db.collection("users").doc(uid).collection("system").doc("config").get(),
    admittedRuntimeReset(db, uid, data),
    readCustomerRestoreAuthoritySnapshot({ db: db as unknown as FleetStateFirestore }, { uid, slug, gatewayId: options.gatewayId }),
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
    greetingPosted: snapshotGreetingPosted(data),
    runtimeMutationFenced: customerRuntimeMutationFenced(data)
      || readPath(data, "provisioning.openclaw.migration") !== undefined
      || nativeSharedContextRestoreHeld(data),
    ...(runtimeReset ? { runtimeReset } : {}),
    ...(restoreAuthority ? { restoreAuthority } : {}),
    ...(nativeSharedContextRestoreHeld(data) ? { nativeSharedContextRestore: readPath(data, "provisioning.openclaw.nativeSharedContextRestore") as FleetBrokerUserSnapshot["nativeSharedContextRestore"] } : {}),
    byotActive: credentialProjection.byotActive ?? baseFields.byotActive,
    freeTierModelRef: modelDials.freeTierModelRef,
    builderAgentDefault: modelDials.builderAgentDefault,
    channels,
    projectCheckoutScope,
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

async function userSnapshotAdmission(
  db: Firestore,
  gatewayId: string,
  podName: string | undefined,
  uid: string,
): Promise<{
  data: Record<string, unknown>;
  gatewayData: Record<string, unknown> | undefined;
} | null> {
  const [userSnap, gatewaySnap] = await Promise.all([
    db.collection("users").doc(uid).get(),
    db.collection(GATEWAYS_COLLECTION).doc(gatewayId).get(),
  ]);
  const data = userSnap.data() as Record<string, unknown> | undefined;
  const gatewayData = gatewaySnap.data() as Record<string, unknown> | undefined;
  if (!data) return null;
  if (stringAt(data, OPENCLAW_GATEWAY_ID_FIELD) === gatewayId) {
    return { data, gatewayData };
  }
  const slug = slugFromAssignedUser(data);
  if (
    !slug ||
    !configuredBuilderCredentialBootstrapAllowed(gatewayData, {
      gatewayId,
      podName,
      slug,
      uid,
    })
  ) {
    return null;
  }
  return { data, gatewayData };
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
  readBlobMetadata: ReadBlobMetadata;
  pruneBuilderRuntimeState: PruneBuilderRuntimeState;
  computerHomeStore: ComputerHomeStore;
  sharedContextObjectStore: SharedContextObjectStore;
  executeChatSearch: ExecuteChatSearch;
  executeChatHistory: ExecuteChatHistory;
  resolveChatIdentity: ResolveChatIdentity;
  verifyOwnerWorkspaceTurn: OwnerWorkspaceTurnVerifier;
  webResearch: Pick<ReturnType<typeof createWebResearchService>, "search" | "extract">;
  now: () => number;
  reconcileCoachProjectMembership: (input: ProjectCoachMembershipInput) => Promise<ProjectCoachMembershipResult>;
  npmCacheCapabilities: NpmCacheCapabilityStore;
  npmCacheRegistryUrl: string;
  reportNpmCacheCapabilityFailure: NonNullable<
    FleetBrokerRouteDeps["reportNpmCacheCapabilityFailure"]
  >;
};

function ownerWorkspaceTurnVerifier(
  opts: { db: Firestore } & FleetBrokerRouteDeps,
): OwnerWorkspaceTurnVerifier {
  return opts.verifyOwnerWorkspaceTurn ?? createOwnerWorkspaceTurnVerifier(opts.db);
}

function projectCoachMembershipReconciler(
  opts: FleetBrokerRouteDeps,
): (input: ProjectCoachMembershipInput) => Promise<ProjectCoachMembershipResult> {
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

function resolveFleetBrokerRouteImplementations(
  opts: FleetBrokerRouteDeps,
) {
  return {
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
    readBlobMetadata: opts.readBlobMetadata ?? defaultReadBlobMetadata,
    pruneBuilderRuntimeState: opts.pruneBuilderRuntimeState ?? defaultPruneBuilderRuntimeState,
    computerHomeStore: opts.computerHomeStore ?? createGcsComputerHomeStore(),
    executeChatSearch: opts.executeChatSearch ?? defaultExecuteChatSearch,
    executeChatHistory: opts.executeChatHistory ?? defaultExecuteChatHistory,
    resolveChatIdentity: opts.resolveChatIdentity ?? defaultResolveChatIdentity,
  };
}

function resolveFleetBrokerRouteDeps(
  opts: { db: Firestore } & FleetBrokerRouteDeps,
): ResolvedFleetBrokerRouteDeps {
  return {
    db: opts.db,
    sharedContextObjectStore: opts.sharedContextObjectStore ?? createGcsSharedContextObjectStore(),
    resolveFreeTierModel: createCachedFreeTierModelResolver({
      db: opts.db,
      onError: (err) => logger.error("fleet-broker free-tier dial resolution failed", { err }),
    }),
    resolveBuilderAgentDefault: createCachedBuilderAgentDefaultResolver({
      db: opts.db,
      onError: (err) =>
        logger.error("fleet-broker builder-agent dial resolution failed", { err }),
    }),
    ...resolveFleetBrokerRouteImplementations(opts),
    verifyOwnerWorkspaceTurn: ownerWorkspaceTurnVerifier(opts),
    webResearch: opts.webResearch ?? createDefaultWebResearch(
      opts.db,
      opts.onSignupOfferBudgetInterruption,
    ),
    now: opts.now ?? Date.now,
    reconcileCoachProjectMembership: projectCoachMembershipReconciler(opts),
    npmCacheCapabilities: opts.npmCacheCapabilities ?? new InMemoryNpmCacheCapabilityStore(),
    npmCacheRegistryUrl: opts.npmCacheRegistryUrl ?? npmCacheProxyRegistryUrl(),
    reportNpmCacheCapabilityFailure: opts.reportNpmCacheCapabilityFailure ?? ((input) => {
      logger.error("[fleet-broker] npm cache capability issue failed", input);
    }),
  };
}

function installAssignmentWatchRoute(router: Router, db: Firestore): void {
  router.post("/assignment-watch", async (req, res) => {
    const bound = boundGateway(req, res);
    if (!bound) return;
    const revisionId = typeof req.body?.revisionId === "string" ? req.body.revisionId : "";
    const gate = await resolveAssignedUsersRevisionGate(db, bound.gatewayId, revisionId);
    if (!gate.allowed) {
      respondInvalidRevision(res, bound.gatewayId, revisionId);
      return;
    }
    streamAssignmentChanges(req, res, db, bound.gatewayId, (message) => logger.error(message));
  });
}

export function builderIdentityForRoot(value: unknown, gatewayId: string): BuilderIdentity | null {
  const root = projectGatewayDesiredRootForGateway(value, gatewayId) as
    (GatewayDoc & GatewayMutableConfig & { retirementClaim?: unknown }) | null;
  if (!root) return null;
  if (root.gatewayClass !== "builder") return { gatewayId, state: "unavailable", reason: "not-builder" };
  if (root.desiredStatus === "retired") return { gatewayId, state: "unavailable", reason: "retired" };
  if (root.retireAfter != null || root.retirementClaim != null) {
    return { gatewayId, state: "unavailable", reason: "retiring" };
  }
  if (root.standby != null) return { gatewayId, state: "standby" };
  if (!root.ownerUid || !root.builderSlug) return null;
  return {
    gatewayId,
    state: "claimed",
    ownerUid: root.ownerUid,
    builderSlug: root.builderSlug,
    leaseId: root.allocation?.leaseId ?? null,
    generation: root.allocation?.generation ?? null,
  };
}

function installBuilderIdentityRoute(router: Router, db: Firestore): void {
  router.post("/builder-identity", async (req, res) => {
    const bound = boundGateway(req, res);
    if (!bound) return;
    if (!podBelongsToGateway(bound.gatewayId, bound.podName)) {
      res.status(403).json(FORBIDDEN);
      return;
    }
    const snapshot = await db.collection(GATEWAYS_COLLECTION).doc(bound.gatewayId).get();
    const identity = builderIdentityForRoot(snapshot.data(), bound.gatewayId);
    if (!identity) {
      logger.error("[fleet-broker] builder identity refused: gateway root is missing or illegal", {
        gatewayId: bound.gatewayId,
      });
      res.status(403).json(FORBIDDEN);
      return;
    }
    res.set("Cache-Control", "no-store");
    res.json({ identity });
  });
}

function installSnapshotRoutes(
  router: Router,
  deps: ResolvedFleetBrokerRouteDeps,
): void {
  const { db } = deps;
  installNpmCacheCapabilityRoutes(router, db, deps);

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

  installAssignmentWatchRoute(router, db);

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
      if (nativeSharedContextRestoreHeld(data)) {
        logger.info("fleet broker withheld Shared context restore from normal mount admission", { uid: doc.id, gatewayId: bound.gatewayId });
        continue;
      }
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
          gatewayId: bound.gatewayId,
          modelDials,
          gatewayData,
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
    const admission = await userSnapshotAdmission(db, bound.gatewayId, bound.podName, uid);
    if (!admission) {
      res.status(403).json(FORBIDDEN);
      return;
    }
    const { data, gatewayData } = admission;
    const slug = slugFromAssignedUser(data);
    if (!slug) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const snapshot = await loadSnapshot(
      db,
      uid,
      data,
      {
        gatewayId: bound.gatewayId,
        modelDials: {
          freeTierModelRef: (await deps.resolveFreeTierModel()).ref,
          builderAgentDefault: await deps.resolveBuilderAgentDefault(),
        },
        gatewayData,
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
    const { pendingProjectIds } = await deps.reconcileCoachProjectMembership({
      coachMmUserId: coach.coachMmUserId,
      projects: collectedChannels.projectMemberships.map(({ projectId, channelIds }) => {
        const agent = agentByProject.get(projectId);
        return {
          projectId,
          projectAgentConfigured: projectAgentConfigured(agent),
          projectAgentMmUserId: agent?.mmUserId ?? null,
          channelIds,
        };
      }),
    });
    if (pendingProjectIds.length > 0) {
      logger.warn("[fleet-broker] project agents pending mint; coach mounted without them", {
        gatewayId: bound.gatewayId,
        slug,
        pendingProjectIds,
      });
    }
    res.json({ pendingProjectAgents: pendingProjectIds });
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

interface BuilderRuntimeStateScope {
  gatewayId: string;
  podName: string | undefined;
  leaseId: string;
  generation: number;
  slug: string;
  uid: string;
}

async function readBuilderRuntimeStateScope(
  db: Firestore,
  input: { gatewayId: string; podName: string | undefined; slug: string },
): Promise<BuilderRuntimeStateScope | null> {
  const gatewaySnap = await db.collection(GATEWAYS_COLLECTION).doc(input.gatewayId).get();
  const gateway = gatewaySnap.data();
  const config = projectGatewayMutableConfigForGateway(gateway, input.gatewayId);
  const uid = config?.ownerUid;
  const allocation = config?.allocation;
  if (
    typeof uid !== "string" ||
    !allocation ||
    !configuredBuilderCredentialBootstrapAllowed(gateway, { ...input, uid })
  ) return null;
  return { ...input, uid, leaseId: allocation.leaseId, generation: allocation.generation };
}

interface SharedAgentAnchorScope {
  migration?: FleetBrokerAgentAnchorMigration;
  gatewayId: string;
  podName: string | undefined;
  uid: string;
  slug: string;
  assignmentEpoch: number;
  assignmentState: "serving" | "quiescing";
}

type AgentAnchorScope = BuilderRuntimeStateScope | SharedAgentAnchorScope;

function agentAnchorAssignment(
  scope: Pick<SharedAgentAnchorScope, "gatewayId" | "uid" | "slug">,
  data: Record<string, unknown> | undefined,
): Pick<SharedAgentAnchorScope, "assignmentEpoch" | "assignmentState"> | null {
  const assignment = parseAssignmentDoc(scope.uid, data);
  const epoch = data?.epoch;
  const state = data?.state;
  if (!assignment || data?.uid !== scope.uid || assignment.gatewayId !== scope.gatewayId || assignment.slug !== scope.slug ||
      (state !== "serving" && state !== "quiescing") || typeof epoch !== "number" || !Number.isSafeInteger(epoch) || epoch < 0) return null;
  return { assignmentEpoch: epoch, assignmentState: state };
}

function sharedAgentAnchorScopeCurrent(
  scope: Pick<SharedAgentAnchorScope, "gatewayId" | "uid" | "slug">,
  gatewayData: unknown,
  userData: Record<string, unknown> | undefined,
  assignmentData: Record<string, unknown> | undefined,
): SharedAgentAnchorScope | null {
  const gateway = projectGatewayDesiredRootForGateway(gatewayData, scope.gatewayId);
  const assignment = agentAnchorAssignment(scope, assignmentData);
  if (!gateway || gateway.gatewayClass !== "shared" || gateway.retirementClaim != null ||
      (gateway.desiredStatus !== "running" && gateway.desiredStatus !== "draining") ||
      stringAt(userData, OPENCLAW_GATEWAY_ID_FIELD) !== scope.gatewayId || slugFromAssignedUser(userData) !== scope.slug ||
      !assignment) return null;
  return { ...scope, podName: undefined, ...assignment };
}

async function requireAgentAnchorScope(db: Firestore, req: Request, res: Response): Promise<AgentAnchorScope | null> {
  const bound = boundGateway(req, res);
  if (!bound) return null;
  const request = configuredBuilderBootstrapRequest(bound.gatewayId, bound.podName, req.body);
  if (!request) { res.status(403).json(FORBIDDEN); return null; }
  const gatewayRef = db.collection(GATEWAYS_COLLECTION).doc(bound.gatewayId);
  const gateway = await gatewayRef.get();
  if (projectGatewayDesiredRootForGateway(gateway.data(), bound.gatewayId)?.gatewayClass !== "shared") {
    return requireConfiguredBuilderRuntimeState(db, req, res);
  }
  if (migrationAnchorRequest(req)) {
    return requireMigratingAgentAnchorScope(db, req, res, bound, request.slug);
  }
  const uid = req.body?.uid;
  if (typeof uid !== "string" || !uid || uid.length > 128 || uid.includes("/")) {
    res.status(403).json(FORBIDDEN); return null;
  }
  const [user, assignment] = await Promise.all([
    db.collection("users").doc(uid).get(),
    gatewayRef.collection(GATEWAY_ASSIGNMENTS_SUBCOLLECTION).doc(uid).get(),
  ]);
  const scope = sharedAgentAnchorScopeCurrent({ gatewayId: bound.gatewayId, uid, slug: request.slug }, gateway.data(), user.data(), assignment.data());
  if (!scope || (req.path.endsWith("/report") &&
      (req.body.assignmentEpoch !== scope.assignmentEpoch || req.body.assignmentState !== scope.assignmentState))) {
    res.status(403).json(FORBIDDEN); return null;
  }
  return { ...scope, podName: bound.podName };
}

function migrationAnchorRequest(req: Request): boolean {
  return req.body?.migrationId !== undefined || req.body?.migration !== undefined;
}

async function requireMigratingAgentAnchorScope(
  db: Firestore, req: Request, res: Response,
  bound: { gatewayId: string; podName?: string }, slug: string,
): Promise<SharedAgentAnchorScope | null> {
  const scope = await db.runTransaction((txn) => sharedAgentAnchorMigrationScope(db, txn, {
    gatewayId: bound.gatewayId, slug, migrationId: req.body.migration?.migrationId ?? req.body.migrationId, expected: req.body.migration,
  }));
  if (!scope || (req.body.uid !== undefined && req.body.uid !== scope.uid) ||
      (req.path.endsWith("/report") && (!req.body.migration || req.body.assignmentEpoch !== scope.assignmentEpoch || req.body.assignmentState !== scope.assignmentState))) {
    res.status(403).json(FORBIDDEN); return null;
  }
  return { ...scope, podName: bound.podName };
}

const AGENT_STORES_SUBCOLLECTION = "agentStores";
const UNMATCHED_ROUTE_AGENT_ID = "octogee-unmatched-route";
const AGENT_ANCHOR_STORE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const AGENT_ANCHOR_SCHEMA = /^[a-z_][a-z0-9_]{0,62}$/u;

function agentAnchorBelongsTo(slug: string, agentId: string): boolean {
  if (agentId === UNMATCHED_ROUTE_AGENT_ID) return true;
  const parsed = parseAgentId(agentId);
  return parsed.kind !== "unknown" && parsed.username === slug;
}

function agentAnchorFor(slug: string, value: unknown): FleetBrokerAgentAnchor | null {
  const record = value && typeof value === "object" ? value as Record<string, unknown> : null;
  const agentId = record?.agentId;
  const storeId = record?.storeId;
  const schema = record?.schema;
  if (typeof agentId !== "string" || !agentAnchorBelongsTo(slug, agentId) ||
      typeof storeId !== "string" || !AGENT_ANCHOR_STORE_ID.test(storeId) ||
      typeof schema !== "string" || !AGENT_ANCHOR_SCHEMA.test(schema)) return null;
  return { agentId, storeId, schema };
}

interface AgentAnchorReport {
  anchors: FleetBrokerAgentAnchor[];
  configuredAgentIds: ReadonlySet<string>;
  state: FleetBrokerGatewayStateAnchor | null;
}

const GATEWAY_STATE_ANCHOR_DOC = "_gateway-state";

function gatewayStateAnchor(value: unknown): FleetBrokerGatewayStateAnchor | null {
  const record = value && typeof value === "object" ? value as Record<string, unknown> : null;
  const storeId = record?.storeId;
  const schema = record?.schema;
  if (typeof storeId !== "string" || !AGENT_ANCHOR_STORE_ID.test(storeId) ||
      typeof schema !== "string" || !AGENT_ANCHOR_SCHEMA.test(schema)) return null;
  return { storeId, schema };
}

function recordedGatewayStateAnchor(scope: BuilderRuntimeStateScope, data: unknown): FleetBrokerGatewayStateAnchor | null {
  const record = data && typeof data === "object" ? data as Record<string, unknown> : null;
  if (record?.kind !== "gateway-state" || record.gatewayId !== scope.gatewayId || record.generation !== scope.generation) return null;
  return gatewayStateAnchor(record);
}

function reportedConfiguredAgentIds(body: unknown): Set<string> | null {
  const ids = (body as { configuredAgentIds?: unknown } | null)?.configuredAgentIds;
  if (!Array.isArray(ids) || ids.length === 0 || ids.length > 512) return null;
  if (!ids.every((id): id is string => typeof id === "string" && id.length > 0 && id.length <= 128)) return null;
  return new Set(ids);
}

function reportedAgentAnchors(slug: string, body: unknown): AgentAnchorReport | null {
  const anchors = (body as { anchors?: unknown } | null)?.anchors;
  const reportedState = (body as { state?: unknown } | null)?.state;
  const state = reportedState === undefined ? null : gatewayStateAnchor(reportedState);
  if (reportedState !== undefined && !state) return null;
  const configuredAgentIds = reportedConfiguredAgentIds(body);
  if (!configuredAgentIds || !Array.isArray(anchors) || anchors.length === 0 || anchors.length > 256) return null;
  const parsed = anchors.map((value) => agentAnchorFor(slug, value));
  if (parsed.some((anchor) => anchor === null || !configuredAgentIds.has(anchor.agentId))) return null;
  const seen = new Set<string>();
  for (const anchor of parsed as FleetBrokerAgentAnchor[]) {
    if (seen.has(anchor.agentId)) return null;
    seen.add(anchor.agentId);
  }
  return { anchors: parsed as FleetBrokerAgentAnchor[], configuredAgentIds, state };
}

function recordedAgentAnchor(scope: BuilderRuntimeStateScope, data: unknown): FleetBrokerAgentAnchor | null {
  const record = data && typeof data === "object" ? data as Record<string, unknown> : null;
  if (record?.gatewayId !== scope.gatewayId || record.generation !== scope.generation) return null;
  return agentAnchorFor(scope.slug, record);
}

class AgentAnchorConflictError extends Error {
  constructor(readonly agentId: string) {
    const subject = agentId === GATEWAY_STATE_ANCHOR_DOC ? "the gateway state" : "agent " + agentId;
    super(`${subject} already records a different PostgreSQL store in this allocation`);
    this.name = "AgentAnchorConflictError";
  }
}

function agentStoreRecords(db: Firestore, uid: string) {
  return db.collection("users").doc(uid).collection(AGENT_STORES_SUBCOLLECTION);
}

function builderAgentAnchorPruningAllowed(
  scope: BuilderRuntimeStateScope,
  user: Record<string, unknown> | undefined,
  assignment: Record<string, unknown> | undefined,
): boolean {
  return agentAnchorAssignment(scope, assignment)?.assignmentState === "serving" &&
    stringAt(user, OPENCLAW_GATEWAY_ID_FIELD) === scope.gatewayId && slugFromAssignedUser(user) === scope.slug &&
    readPath(user, "provisioning.openclaw.migration") === undefined && !customerRuntimeMutationFenced(user);
}

async function recordAgentAnchors(
  db: Firestore,
  scope: BuilderRuntimeStateScope,
  { anchors, configuredAgentIds, state }: AgentAnchorReport,
  recordedAt: number,
): Promise<void> {
  const records = agentStoreRecords(db, scope.uid);
  const reported = new Map(anchors.map((anchor) => [anchor.agentId, anchor]));
  await db.runTransaction(async (txn) => {
    const [existing, user, assignment] = await Promise.all([
      txn.get(records),
      txn.get(db.collection("users").doc(scope.uid)),
      txn.get(db.collection(GATEWAYS_COLLECTION).doc(scope.gatewayId).collection(GATEWAY_ASSIGNMENTS_SUBCOLLECTION).doc(scope.uid)),
    ]);
    const canPrune = builderAgentAnchorPruningAllowed(scope, user.data(), assignment.data());
    for (const doc of existing.docs) {
      if (doc.id === GATEWAY_STATE_ANCHOR_DOC) {
        const prior = recordedGatewayStateAnchor(scope, doc.data());
        if (prior && state && (prior.storeId !== state.storeId || prior.schema !== state.schema)) {
          throw new AgentAnchorConflictError(GATEWAY_STATE_ANCHOR_DOC);
        }
        continue;
      }
      const prior = recordedAgentAnchor(scope, doc.data());
      if (!prior) continue;
      const next = reported.get(prior.agentId);
      if (!configuredAgentIds.has(prior.agentId)) {
        if (canPrune) txn.delete(doc.ref);
      } else if (next && (prior.storeId !== next.storeId || prior.schema !== next.schema)) {
        throw new AgentAnchorConflictError(prior.agentId);
      }
    }
    for (const anchor of anchors) {
      txn.set(records.doc(anchor.agentId), { ...anchor, gatewayId: scope.gatewayId, generation: scope.generation, recordedAt });
    }
    if (state) {
      txn.set(records.doc(GATEWAY_STATE_ANCHOR_DOC), { kind: "gateway-state", ...state, gatewayId: scope.gatewayId, generation: scope.generation, recordedAt });
    }
  });
}

function recordedSharedAgentAnchor(scope: SharedAgentAnchorScope, id: string, data: unknown): FleetBrokerAgentAnchor | null {
  if (id === UNMATCHED_ROUTE_AGENT_ID || !agentAnchorBelongsTo(scope.slug, id)) return null;
  const record = data as Record<string, unknown> | null;
  const anchor = agentAnchorFor(scope.slug, data);
  if (!anchor || anchor.agentId !== id || (scope.assignmentState === "quiescing" && !scope.migration &&
      (!record || record.gatewayId !== scope.gatewayId || record.assignmentEpoch !== scope.assignmentEpoch))) {
    throw new AgentAnchorConflictError(id);
  }
  return anchor;
}

class SharedAgentAnchorCustodyError extends Error {}

function anchorCustodyGateway(scope: SharedAgentAnchorScope): string {
  return scope.migration?.sourceGatewayId ?? scope.gatewayId;
}

function unconfiguredSharedAgentAnchors(scope: SharedAgentAnchorScope, existing: QuerySnapshot, configuredAgentIds: ReadonlySet<string>) {
  if (scope.assignmentState !== "serving" || scope.migration) return [];
  return existing.docs.filter((doc) => {
    const prior = recordedSharedAgentAnchor(scope, doc.id, doc.data());
    return prior && !configuredAgentIds.has(prior.agentId);
  });
}

async function recordSharedAgentAnchors(
  db: Firestore,
  scope: SharedAgentAnchorScope,
  { anchors, configuredAgentIds }: AgentAnchorReport,
  recordedAt: number,
): Promise<void> {
  const gatewayRef = db.collection(GATEWAYS_COLLECTION).doc(scope.gatewayId);
  const records = agentStoreRecords(db, scope.uid);
  await db.runTransaction(async (txn) => {
    const [gateway, user, assignment, existing] = await Promise.all([
      txn.get(gatewayRef), txn.get(db.collection("users").doc(scope.uid)),
      txn.get(gatewayRef.collection(GATEWAY_ASSIGNMENTS_SUBCOLLECTION).doc(scope.uid)), txn.get(records),
    ]);
    const current = scope.migration
      ? await sharedAgentAnchorMigrationScope(db, txn, { gatewayId: scope.gatewayId, slug: scope.slug, migrationId: scope.migration.migrationId, expected: scope.migration })
      : sharedAgentAnchorScopeCurrent(scope, gateway.data(), user.data(), assignment.data());
    if (!current || current.assignmentEpoch !== scope.assignmentEpoch || current.assignmentState !== scope.assignmentState) {
      throw new SharedAgentAnchorCustodyError("Shared agent anchor custody changed before reporting");
    }
    for (const anchor of anchors) {
      const doc = existing.docs.find((candidate) => candidate.id === anchor.agentId);
      const prior = doc ? recordedSharedAgentAnchor(scope, doc.id, doc.data()) : null;
      if ((prior && (prior.storeId !== anchor.storeId || prior.schema !== anchor.schema)) ||
          (!prior && scope.assignmentState !== "serving")) throw new AgentAnchorConflictError(anchor.agentId);
    }
    for (const doc of unconfiguredSharedAgentAnchors(scope, existing, configuredAgentIds)) txn.delete(doc.ref);
    for (const anchor of anchors) {
      const prior = existing.docs.find((candidate) => candidate.id === anchor.agentId)?.data();
      txn.set(records.doc(anchor.agentId), { ...prior, ...anchor, gatewayId: anchorCustodyGateway(scope), assignmentEpoch: scope.assignmentEpoch, recordedAt });
    }
  });
}

function installAgentAnchorRoutes(router: Router, deps: ResolvedFleetBrokerRouteDeps): void {
  const { db } = deps;
  const stores = (uid: string) => agentStoreRecords(db, uid);

  router.post("/agent-anchors/report", async (req, res) => {
    const scope = await requireAgentAnchorScope(db, req, res);
    if (!scope) return;
    const report = reportedAgentAnchors(scope.slug, req.body);
    if (!report || ("assignmentEpoch" in scope && (report.state ||
        [...report.configuredAgentIds].some((id) => id === UNMATCHED_ROUTE_AGENT_ID || !agentAnchorBelongsTo(scope.slug, id))))) {
      res.status(400).json({ error: "invalid_agent_anchors" });
      return;
    }
    await runBrokered(res, async () => {
      const recordedAt = deps.now();
      try {
        if ("assignmentEpoch" in scope) await recordSharedAgentAnchors(db, scope, report, recordedAt);
        else await recordAgentAnchors(db, scope, report, recordedAt);
      } catch (error) {
        if (error instanceof SharedAgentAnchorCustodyError) { res.status(403).json(FORBIDDEN); return; }
        if (!(error instanceof AgentAnchorConflictError)) throw error;
        logger.error("[fleet-broker] agent anchor conflict refused", {
          gatewayId: scope.gatewayId, slug: scope.slug, agentId: error.agentId,
        });
        res.status(409).json({ error: "agent_anchor_conflict", agentId: error.agentId });
        return;
      }
      res.status(204).end();
    });
  });

  router.post("/agent-anchors/read", async (req, res) => {
    const scope = await requireAgentAnchorScope(db, req, res);
    if (!scope) return;
    await runBrokered(res, async () => {
      const snapshot = "assignmentEpoch" in scope && scope.migration ? await db.runTransaction(async (txn) => {
        const current = await sharedAgentAnchorMigrationScope(db, txn, { gatewayId: scope.gatewayId, slug: scope.slug, migrationId: scope.migration!.migrationId, expected: scope.migration });
        if (!current) return null;
        return txn.get(stores(scope.uid));
      }) : await stores(scope.uid).get();
      if (!snapshot) { res.status(403).json(FORBIDDEN); return; }
      if ("assignmentEpoch" in scope) {
        try {
          const anchors = snapshot.docs.map((doc) => recordedSharedAgentAnchor(scope, doc.id, doc.data()))
            .filter((anchor): anchor is FleetBrokerAgentAnchor => anchor !== null)
            .sort((left, right) => left.agentId.localeCompare(right.agentId));
          res.json({ anchors, assignment: { uid: scope.uid, epoch: scope.assignmentEpoch, state: scope.assignmentState }, ...(scope.migration ? { migration: scope.migration } : {}) } satisfies FleetBrokerAgentAnchors);
        } catch (error) {
          if (!(error instanceof AgentAnchorConflictError)) throw error;
          res.status(409).json({ error: "agent_anchor_conflict", agentId: error.agentId });
        }
        return;
      }
      const anchors = snapshot.docs
        .filter((doc) => doc.id !== GATEWAY_STATE_ANCHOR_DOC)
        .map((doc) => recordedAgentAnchor(scope, doc.data()))
        .filter((anchor): anchor is FleetBrokerAgentAnchor => anchor !== null)
        .sort((left, right) => left.agentId.localeCompare(right.agentId));
      const stateDoc = snapshot.docs.find((doc) => doc.id === GATEWAY_STATE_ANCHOR_DOC);
      const state = stateDoc ? recordedGatewayStateAnchor(scope, stateDoc.data()) : null;
      const response: FleetBrokerAgentAnchors = { anchors, ...(state ? { state } : {}) };
      res.json(response);
    });
  });
}

async function confirmBuilderRuntimeStateAllocationCurrent(
  db: Firestore,
  scope: BuilderRuntimeStateScope,
): Promise<void> {
  const current = await readBuilderRuntimeStateScope(db, scope);
  if (current?.leaseId !== scope.leaseId || current.generation !== scope.generation) {
    throw new BuilderRuntimeStateAllocationSupersededError(scope);
  }
}

async function pruneBuilderRuntimeStateForScope(
  db: Firestore,
  prune: PruneBuilderRuntimeState,
  scope: BuilderRuntimeStateScope,
  now: number,
): Promise<number | null> {
  try {
    return await prune({
      canonicalPath: gcsPathForBuilderRuntimeState(scope),
      runtimeStatePrefix: gcsPathForBuilderRuntimeStateRoot(scope.slug),
      allocationGeneration: scope.generation,
      now,
      confirmAllocationCurrent: () => confirmBuilderRuntimeStateAllocationCurrent(db, scope),
    });
  } catch (error) {
    if (!(error instanceof BuilderRuntimeStateAllocationSupersededError)) throw error;
    logger.warn("[fleet-broker] runtime-state prune refused: allocation superseded", {
      gatewayId: scope.gatewayId, slug: scope.slug, generation: scope.generation,
    });
    return null;
  }
}

async function requireConfiguredBuilderRuntimeState(
  db: Firestore,
  req: Request,
  res: Response,
): Promise<BuilderRuntimeStateScope | null> {
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

  const scope = await readBuilderRuntimeStateScope(db, {
    gatewayId: bound.gatewayId,
    podName: bound.podName,
    slug: request.slug,
  });
  if (!scope) {
    res.status(403).json(FORBIDDEN);
    return null;
  }
  return scope;
}

function openClawBootRequest(
  bound: GatewayBinding,
  body: unknown,
): { releaseKey: string; podUid: string; podName: string } | null {
  const record = body && typeof body === "object" ? body as Record<string, unknown> : {};
  const revisionId = typeof record.revisionId === "string" ? record.revisionId : "";
  const releaseKey = typeof record.releaseKey === "string" ? record.releaseKey.trim() : "";
  const authenticatedRevisionId = revisionIdFromGatewayPodName(bound.gatewayId, bound.podName);
  if (!bound.podUid || !bound.podName || !authenticatedRevisionId || revisionId !== authenticatedRevisionId) {
    return null;
  }
  if (!releaseKey || releaseKey.length > 512) return null;
  return { releaseKey, podUid: bound.podUid, podName: bound.podName };
}

function installOpenClawBootRoutes(
  router: Router,
  deps: ResolvedFleetBrokerRouteDeps,
): void {
  installAgentAnchorRoutes(router, deps);
  const store = createOpenClawBootSentinelStore(deps.db, deps.now);

  router.post("/openclaw-boot/claim", async (req, res) => {
    const bound = boundGateway(req, res);
    if (!bound) return;
    const request = openClawBootRequest(bound, req.body);
    if (!request) {
      res.status(403).json(FORBIDDEN);
      return;
    }
    await runBrokered(res, async () => {
      const result = await store.claim({ gatewayId: bound.gatewayId, ...request });
      if (!result) {
        res.status(409).json({ error: "gateway_runtime_missing" });
        return;
      }
      res.json(result);
    });
  });

  router.post("/openclaw-boot/doctor-current", async (req, res) => {
    const bound = boundGateway(req, res);
    if (!bound) return;
    const request = openClawBootRequest(bound, req.body), requestId = req.body?.requestId;
    if (!request || typeof requestId !== "string" || !requestId || requestId.includes("/")) { res.status(403).json(FORBIDDEN); return; }
    await runBrokered(res, async () => {
      await store.assertDoctor({ gatewayId: bound.gatewayId, ...request, requestId });
      res.status(204).end();
    });
  });

  router.post("/openclaw-boot/doctor-complete", async (req, res) => {
    const bound = boundGateway(req, res);
    if (!bound) return;
    const request = openClawBootRequest(bound, req.body);
    const requestId = req.body?.requestId;
    const verifiedAgentIds = req.body?.verifiedAgentIds;
    if (!request || typeof requestId !== "string" || !requestId || requestId.includes("/") ||
        !Array.isArray(verifiedAgentIds) || verifiedAgentIds.length === 0 || !verifiedAgentIds.every((id: unknown) => typeof id === "string")) {
      res.status(403).json(FORBIDDEN);
      return;
    }
    await runBrokered(res, async () => {
      await store.completeDoctor({ gatewayId: bound.gatewayId, ...request, requestId, verifiedAgentIds });
      res.status(204).end();
    });
  });

  router.post("/openclaw-boot/healthy", async (req, res) => {
    const bound = boundGateway(req, res);
    if (!bound) return;
    const request = openClawBootRequest(bound, req.body);
    if (!request) {
      res.status(403).json(FORBIDDEN);
      return;
    }
    await runBrokered(res, async () => {
      const completed = await store.complete({ gatewayId: bound.gatewayId, ...request });
      if (!completed) {
        res.status(409).json({ error: "gateway_runtime_missing" });
        return;
      }
      res.status(204).end();
    });
  });
}

export class CorruptStoredFieldError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CorruptStoredFieldError";
  }
}

export function storedAgentLook(agent: Record<string, unknown> | undefined): AgentLook {
  if (agent?.look === undefined || agent?.look === null) return DEFAULT_AGENT_LOOK;
  const look = parseAgentLook(agent.look);
  if (!look) throw new CorruptStoredFieldError(`agents/{uid}.look is not a drawable look: ${JSON.stringify(agent.look)}`);
  return look;
}

export function storedTimeZone(user: Record<string, unknown> | undefined): string | null {
  const raw = readPath(user, "preferences.timeZone");
  if (raw === undefined || raw === null) return null;
  const zone = parseTimeZone(raw);
  if (!zone) throw new CorruptStoredFieldError(`users/{uid}.preferences.timeZone is not an IANA zone: ${JSON.stringify(raw)}`);
  return zone;
}

export function configuredBuilderDesk(
  user: Record<string, unknown> | undefined,
  agent: Record<string, unknown> | undefined,
): FleetBrokerConfiguredBuilderDesk {
  return {
    builderName: stringAt(user, "displayName") || stringAt(user, "username"),
    agentName: stringAt(agent, "name"),
    look: storedAgentLook(agent),
    timeZone: storedTimeZone(user),
  };
}

function configuredBuilderBootstrapPayload(input: {
  uid: string;
  slug: string;
  user: Record<string, unknown> | undefined;
  coach: Record<string, unknown> | undefined;
  agent: Record<string, unknown> | undefined;
  projectCredentials: FleetBrokerConfiguredBuilderProjectCredential[];
}): FleetBrokerConfiguredBuilderBootstrap | null {
  const { uid, slug, user, coach, agent, projectCredentials } = input;
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
    desk: configuredBuilderDesk(user, agent),
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

  const [userSnap, coachSnap, agentSnap, projectAgents] = await Promise.all([
    db.collection("users").doc(uid).get(),
    db.collection("users").doc(uid).collection("secrets").doc("coachMattermost").get(),
    db.collection("agents").doc(uid).get(),
    collectProjectAgentStates(db, uid, request.slug),
  ]);
  let bootstrap: FleetBrokerConfiguredBuilderBootstrap | null;
  try {
    bootstrap = configuredBuilderBootstrapPayload({
      uid,
      slug: request.slug,
      user: userSnap.data() as Record<string, unknown> | undefined,
      coach: coachSnap.data() as Record<string, unknown> | undefined,
      agent: agentSnap.data() as Record<string, unknown> | undefined,
      projectCredentials: configuredBuilderProjectCredentials(request.slug, projectAgents),
    });
  } catch (error) {
    if (!(error instanceof CorruptStoredFieldError)) throw error;
    logger.error("[fleet-broker] configured Builder bootstrap refused: corrupt stored identity", { uid, slug: request.slug, error: error.message });
    res.status(500).json({ error: "corrupt_stored_identity", detail: error.message });
    return;
  }
  if (!bootstrap) {
    res.status(404).json({ error: "configured_builder_bootstrap_unavailable" });
    return;
  }
  res.json({ bootstrap });
}

function installToolchainStatusRoute(router: Router, db: Firestore): void {
  router.post("/set-toolchain-status", async (req, res) => {
    const assigned = await requireAssignedUser(db, req, res);
    if (!assigned) return;
    const status = objectBody(req).status;
    if (!isDeveloperToolchainStatus(status)) {
      res.status(400).json({ error: "invalid_status" });
      return;
    }
    await runBrokered(res, async () => {
      await db.collection("users").doc(assigned.uid).update({
        "provisioning.openclaw.toolchain.status": status,
        "provisioning.openclaw.toolchain.updatedAt": FieldValue.serverTimestamp(),
      });
      res.status(204).end();
    });
  });
}

function installRuntimeResetAckRoute(router: Router, db: Firestore): void {
  router.post("/runtime-reset-ack", async (req, res) => {
    const assigned = await requireAssignedUser(db, req, res);
    if (!assigned) return;
    const body = objectBody(req);
    const operationId = typeof body.operationId === "string" ? body.operationId : "";
    const generation = body.generation;
    if (!operationId || !Number.isSafeInteger(generation) || (generation as number) < 0) {
      res.status(400).json({ error: "invalid_runtime_reset_ack" });
      return;
    }
    await runBrokered(res, async () => {
      const result = await db.runTransaction(async (txn) => {
        const userRef = db.collection("users").doc(assigned.uid);
        const assignmentRef = db
          .collection(GATEWAYS_COLLECTION)
          .doc(assigned.bound.gatewayId)
          .collection(GATEWAY_ASSIGNMENTS_SUBCOLLECTION)
          .doc(assigned.uid);
        const [userSnapshot, assignmentSnapshot] = await Promise.all([
          txn.get(userRef),
          txn.get(assignmentRef),
        ]);
        const userData = userSnapshot.data() as Record<string, unknown> | undefined;
        if (stringAt(userData, OPENCLAW_GATEWAY_ID_FIELD) !== assigned.bound.gatewayId) {
          return "conflict" as const;
        }
        const marker = userData ? storedRuntimeReset(userData) : undefined;
        if (!marker) return "missing" as const;
        if (marker.status === "acknowledged") return "missing" as const;
        const assignmentData = assignmentSnapshot.data() as Record<string, unknown> | undefined;
        const assignment = assignmentData
          ? parseAssignmentDoc(assigned.uid, assignmentData)
          : null;
        const exact = [
          marker.uid === assigned.uid,
          marker.slug === slugFromAssignedUser(userData),
          marker.targetGatewayId === assigned.bound.gatewayId,
          marker.operationId === operationId,
          marker.generation === generation,
          assignment?.uid === assigned.uid,
          assignment?.gatewayId === assigned.bound.gatewayId,
          assignment?.epoch === marker.generation,
          assignmentData?.source === "repair",
          assignmentData?.updatedByOperationId === marker.operationId,
        ].every(Boolean);
        if (!exact) return "conflict" as const;
        txn.update(userRef, {
          "provisioning.openclaw.runtimeReset": {
            ...marker,
            status: "acknowledged",
            acknowledgedAt: FieldValue.serverTimestamp(),
          },
        });
        return "acked" as const;
      });
      if (result === "conflict") {
        res.status(409).json({ error: "runtime_reset_fence_changed" });
        return;
      }
      res.status(204).end();
    });
  });
}

function installProjectAgentReadinessRoute(router: Router, db: Firestore): void {
  router.post("/project-agent-readiness", async (req, res) => {
    const assigned = await requireAssignedUser(db, req, res);
    if (!assigned) return;
    const projects = parseProjectAgentReadinessReports(objectBody(req).projects);
    if (!projects) {
      res.status(400).json({ error: "invalid_project_agent_readiness" });
      return;
    }
    await runBrokered(res, async () => {
      const accepted = await completeProjectAgentReadiness(db, {
        uid: assigned.uid,
        gatewayId: assigned.bound.gatewayId,
        slug: deriveSlug(assigned.uid, assigned.data),
        projects,
      });
      if (!accepted) {
        res.status(409).json({ error: "stale_project_agent_readiness" });
        return;
      }
      res.status(204).end();
    });
  });

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
  installToolchainStatusRoute(router, db);
  installRuntimeResetAckRoute(router, db);

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
      const slug = stringAt(assigned.data, "username");
      if (slug) await applyDefaultCoachLook({ uid: assigned.uid, slug }, deps);
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

  installProjectAgentReadinessRoute(router, db);

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

function installWorkspaceManifestRoutes(
  router: Router,
  deps: ResolvedFleetBrokerRouteDeps,
): void {
  const { db, createBlobSignedUrl } = deps;

  router.post("/blob/manifest/read-url", async (req, res) => {
    const assigned = await requireAssignedSlug(db, req, res);
    if (!assigned) return;
    const project = objectBody(req).projectSlug;
    if (project !== undefined && (typeof project !== "string" || !/^[a-z0-9][a-z0-9-]*$/u.test(project))) {
      res.status(400).json({ error: "invalid_project" }); return;
    }
    await runBrokered(res, async () => {
      const signed = await createBlobSignedUrl({
        gcsPath: project ? `customers/${assigned.slug}/projects/${project}/${MANIFEST_OBJECT_SUFFIX}` : gcsPathForWorkspaceManifest(assigned.slug),
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

function installBlobMaterializationRoute(router: Router, deps: ResolvedFleetBrokerRouteDeps): void {
  router.post("/blob/project/upload-url", async (req, res) => {
    const assigned = await requireAssignedSlug(deps.db, req, res);
    if (!assigned) return;
    const body = objectBody(req);
    const { projectSlug, sha256, size, md5Hash } = body;
    if (typeof projectSlug !== "string" || !/^[a-z0-9][a-z0-9-]*$/u.test(projectSlug) ||
      typeof sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(sha256) ||
      typeof size !== "number" || !Number.isSafeInteger(size) || size < 0 || size > 512 * 1024 * 1024 ||
      typeof md5Hash !== "string" || !/^[A-Za-z0-9+/]{22}==$/u.test(md5Hash)) {
      res.status(400).json({ error: "invalid_project_asset" }); return;
    }
    await runBrokered(res, async () => {
      res.json(await deps.createBlobSignedUrl({
        gcsPath: `customers/${assigned.slug}/projects/${projectSlug}/.objects/${sha256}`,
        action: "write", contentType: validContentType(body.mimeType), ifGenerationMatch: 0,
        contentMd5: md5Hash, contentLength: size,
      }));
    });
  });
  router.post("/blob/materialization/manifest/read-url", async (req, res) => {
    const assigned = await requireAssignedSlug(deps.db, req, res, true);
    if (!assigned) return;
    const project = objectBody(req).projectSlug;
    if (typeof project !== "string" || !/^[a-z0-9][a-z0-9-]*$/u.test(project)) {
      res.status(400).json({ error: "invalid_project" }); return;
    }
    await runBrokered(res, async () => {
      const signed = await deps.createBlobSignedUrl({ gcsPath: `customers/${assigned.slug}/projects/${project}/${MANIFEST_OBJECT_SUFFIX}`, action: "read" });
      res.json(signed);
    });
  });
  router.post("/blob/materialization/read-url", async (req, res) => {
    const assigned = await requireAssignedSlug(deps.db, req, res, true);
    if (!assigned) return;
    const body = objectBody(req);
    const relativePath = validBlobRelativePath(body.path);
    const size = body.size;
    const sha256 = body.sha256;
    if (sha256 !== undefined && (typeof sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(sha256))) {
      res.status(400).json({ error: "invalid_materialization" }); return;
    }
    if (!/^projects\/[a-z0-9][a-z0-9-]*\/.+/u.test(relativePath) || typeof size !== "number" || !Number.isSafeInteger(size) || size < 0 || size > 512 * 1024 * 1024) {
      res.status(400).json({ error: "invalid_materialization" }); return;
    }
    await runBrokered(res, async () => {
      const gcsPath = sha256
        ? `customers/${assigned.slug}/projects/${relativePath.split("/")[1]}/.objects/${sha256}`
        : gcsPathForBlob(assigned.slug, relativePath);
      const metadata = await deps.readBlobMetadata(gcsPath);
      const generation = typeof metadata.generation === "string" ? metadata.generation : "";
      const objectSize = typeof metadata.size === "string" && /^(0|[1-9]\d*)$/u.test(metadata.size) ? Number(metadata.size) : NaN;
      const md5Hash = typeof metadata.md5Hash === "string" ? metadata.md5Hash : "";
      if (!/^[1-9]\d{0,19}$/u.test(generation) || objectSize !== size || !/^[A-Za-z0-9+/]{22}==$/u.test(md5Hash)) {
        res.status(409).json({ error: "blob_identity_changed" }); return;
      }
      const download = await deps.createBlobSignedUrl({ gcsPath, action: "read", generation });
      res.json({ download, generation, size, md5Hash });
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
  installBlobMaterializationRoute(router, deps);

  router.post("/builder-runtime-state/download-url", async (req, res) => {
    const configured = await requireConfiguredBuilderRuntimeState(db, req, res);
    if (!configured) return;
    await runBrokered(res, async () => {
      const signed = await createBlobSignedUrl({
        gcsPath: gcsPathForBuilderRuntimeState(configured),
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
        gcsPath: gcsPathForBuilderRuntimeState(configured),
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
      const deleted = await pruneBuilderRuntimeStateForScope(db, pruneBuilderRuntimeState, configured, now());
      if (deleted === null) {
        res.status(409).json({ error: "runtime_state_allocation_superseded" });
        return;
      }
      const response: FleetBrokerBuilderRuntimeStatePruneResult = { deleted };
      res.json(response);
    });
  });

  installComputerHomeRoutes(router, deps);
  installOpenClawBootRoutes(router, deps);
}

function validatedHomeRestore(home: Partial<GatewayVmHomeState> | undefined, res: Response): GatewayVmHomeCheckpoint | undefined | null {
  const expected = home?.restoreCheckpoint;
  if (expected !== undefined && !isDisposableHomeCheckpoint(expected)) {
    res.status(409).json({ error: "home_restore_checkpoint_invalid" });
    return null;
  }
  return expected;
}

function homeCheckpointProtocolValid(coverage: unknown, writerProtocol: unknown): boolean {
  return (coverage === undefined || coverage === "builder-home-v2") && (writerProtocol === undefined || writerProtocol === 2);
}

function computerHomeBindingValid(glm: Record<string, unknown> | undefined, bound: GatewayBinding, gateway: ReturnType<typeof projectGatewayDesiredRootForGateway>, slug: string): boolean {
  const vm = glm?.vm as { instanceId?: unknown } | null | undefined;
  return resolveGatewayRuntime(glm?.runtime) === "gce-vm" && vm?.instanceId === bound.podUid
    && computerHomeGatewayEligible(gateway, slug, bound.finalHomeCheckpoint === true);
}

async function requireComputerHomeScope(
  db: Firestore,
  req: Request,
  res: Response,
): Promise<{ bound: GatewayBinding; slug: string; instanceId: string; ownerUid: string; restoreCheckpoint?: GatewayVmHomeCheckpoint } | null> {
  const bound = boundGateway(req, res);
  if (!bound) return null;
  const slug = typeof req.body?.slug === "string" ? req.body.slug : "";
  if (!isValidUsername(slug)) {
    res.status(400).json({ error: "invalid_slug" });
    return null;
  }
  if (!bound.podUid) {
    res.status(403).json(FORBIDDEN);
    return null;
  }
  const [glm, gatewaySnap] = await Promise.all([
    readComputerRuntimeObservation(db, bound.gatewayId),
    db.doc(`${GATEWAYS_COLLECTION}/${bound.gatewayId}`).get(),
  ]);
  const gateway = projectGatewayDesiredRootForGateway(gatewaySnap.exists ? gatewaySnap.data() : undefined, bound.gatewayId);
  if (!computerHomeBindingValid(glm, bound, gateway, slug)) {
    res.status(403).json(FORBIDDEN);
    return null;
  }
  const restoreCheckpoint = validatedHomeRestore(glm?.vmHome as Partial<GatewayVmHomeState> | undefined, res);
  if (restoreCheckpoint === null) return null;
  return { bound, slug, instanceId: bound.podUid, ownerUid: gateway!.ownerUid as string, ...(restoreCheckpoint ? { restoreCheckpoint } : {}) };
}

function computerHomeGatewayEligible(
  gateway: (ReturnType<typeof projectGatewayDesiredRootForGateway> & { retirementClaim?: unknown }) | null,
  slug: string,
  finalHomeCheckpoint: boolean,
): boolean {
  if (gateway === null) return false;
  const lifecycleAdmits = finalHomeCheckpoint
    ? gateway.desiredStatus === "retired"
    : gateway.desiredStatus === "running" && gateway.retireAfter == null && gateway.retirementClaim == null;
  return lifecycleAdmits &&
    gateway.gatewayClass === "builder" &&
    gateway.builderSlug === slug &&
    typeof gateway.ownerUid === "string";
}

function respondComputerHomeError(res: Response, error: unknown): boolean {
  if (!(error instanceof ComputerHomeCheckpointError)) return false;
  res.status(409).json({ error: error.code });
  return true;
}

function installComputerHomeRoutes(router: Router, deps: ResolvedFleetBrokerRouteDeps): void {
  const { db, createBlobSignedUrl, computerHomeStore, now } = deps;

  router.post("/computer-home/checkpoint-url", async (req, res) => {
    const scope = await requireComputerHomeScope(db, req, res);
    if (!scope) return;
    const size = finiteNonNegative(objectBody(req).size);
    if (size === null || size === 0 || size > COMPUTER_HOME_CHECKPOINT_MAX_BYTES) {
      res.status(400).json({ error: "invalid_size" });
      return;
    }
    await runBrokered(res, async () => {
      const name = computerHomeCheckpointName(now());
      const upload = await createBlobSignedUrl({
        gcsPath: computerHomeCheckpointPath(scope.slug, name),
        action: "write",
        contentType: COMPUTER_HOME_CHECKPOINT_CONTENT_TYPE,
        ifGenerationMatch: 0,
      });
      const response: FleetBrokerComputerHomeCheckpointUrl = { name, upload };
      res.json(response);
    });
  });

  router.post("/computer-home/commit", async (req, res) => {
    const scope = await requireComputerHomeScope(db, req, res);
    if (!scope) return;
    const body = objectBody(req);
    const name = validComputerHomeCheckpointName(body.name);
    const sha256 = validSha256(body.sha256);
    const size = finiteNonNegative(body.size);
    const coverage = body.coverage;
    const writerProtocol = body.writerProtocol;
    const requestedAt = body.requestedAt === null ? null : finiteNonNegative(body.requestedAt);
    if (!homeCheckpointProtocolValid(coverage, writerProtocol)
      || (body.requestedAt !== null && requestedAt === null) || (requestedAt !== null && requestedAt > now())
      || !name || !sha256 || size === null || size === 0 || size > COMPUTER_HOME_CHECKPOINT_MAX_BYTES) {
      res.status(400).json({ error: "invalid_checkpoint" });
      return;
    }
    await runBrokered(res, async () => {
      let checkpoint: GatewayVmHomeCheckpoint = { name, size, sha256, instanceId: scope.instanceId, completedAt: now(), ...(coverage === "builder-home-v2" ? { coverage } : {}), ...(writerProtocol === 2 ? { writerProtocol } : {}) };
      try {
        checkpoint = await computerHomeStore.commit({
          checkpointPath: computerHomeCheckpointPath(scope.slug, name),
          currentPath: computerHomeCurrentPath(scope.slug),
          checkpoint,
        });
      } catch (error) {
        if (respondComputerHomeError(res, error)) return;
        throw error;
      }
      const home: Pick<GatewayVmHomeState, "lastCheckpoint" | "checkpointAcknowledgedAt"> = { lastCheckpoint: checkpoint, checkpointAcknowledgedAt: requestedAt };
      await recordComputerHomeCheckpoint(db, scope.bound.gatewayId, home, { uid: scope.ownerUid, instanceId: scope.instanceId });
      const response: FleetBrokerComputerHomeCheckpointCommit = { name, size, sha256, completedAt: checkpoint.completedAt };
      res.json(response);
    });
  });

  router.post("/computer-home/download-url", async (req, res) => {
    if (req.body?.agentContextRestore !== undefined) {
      const bound = boundGateway(req, res);
      if (!bound) return;
      const slug = typeof req.body.slug === "string" ? req.body.slug : "";
      try {
        const recovery = await authorizeSharedContextCheckpoint(db, bound.gatewayId, slug, req.body.agentContextRestore);
        const object = await deps.sharedContextObjectStore.derive({ checkpoint: recovery.checkpoint, archive: recovery.archive });
        const current = await authorizeSharedContextCheckpoint(db, bound.gatewayId, slug, req.body.agentContextRestore);
        if (current.claimedStartedAt !== recovery.claimedStartedAt) throw new Error("Shared context checkpoint attempt changed");
        const download = await createBlobSignedUrl({ gcsPath: object.gcsPath, action: "read", generation: object.generation });
        res.json({ checkpoint: recovery.checkpoint, size: object.size, sha256: object.sha256, generation: object.generation, download });
      } catch (error) {
        if (error instanceof SharedContextPendingError) {
          res.setHeader("Retry-After", "5");
          res.status(503).json({ error: "shared_context_checkpoint_preparing" });
          return;
        }
        logger.error("Shared context checkpoint download refused", { gatewayId: bound.gatewayId });
        res.status(403).json(FORBIDDEN);
      }
      return;
    }
    const scope = await requireComputerHomeScope(db, req, res);
    if (!scope) return;
    await runBrokered(res, async () => {
      const current = await computerHomeStore.readCurrent(computerHomeCurrentPath(scope.slug));
      if (!current) {
        res.status(scope.restoreCheckpoint ? 409 : 404).json({ error: scope.restoreCheckpoint ? "home_restore_checkpoint_unavailable" : "no_checkpoint" });
        return;
      }
      if (scope.restoreCheckpoint && !sameHomeCheckpoint(scope.restoreCheckpoint, current)) {
        res.status(409).json({ error: "home_restore_checkpoint_mismatch" });
        return;
      }
      const download = await createBlobSignedUrl({
        gcsPath: computerHomeCheckpointPath(scope.slug, current.name),
        action: "read",
        ...(current.generation ? { generation: current.generation } : {}),
      });
      const response: FleetBrokerComputerHomeDownload = {
        name: current.name,
        size: current.size,
        sha256: current.sha256,
        completedAt: current.completedAt,
        instanceId: current.instanceId,
        ...(current.coverage ? { coverage: current.coverage } : {}),
        ...(current.writerProtocol ? { writerProtocol: current.writerProtocol } : {}),
        ...(current.generation ? { generation: current.generation } : {}),
        download,
      };
      res.json(response);
    });
  });

  router.post("/computer-home/prune", async (req, res) => {
    const scope = await requireComputerHomeScope(db, req, res);
    if (!scope) return;
    await runBrokered(res, async () => {
      const current = await computerHomeStore.readCurrent(computerHomeCurrentPath(scope.slug));
      const deleted = await computerHomeStore.prune({
        checkpointsPrefix: computerHomeCheckpointsPrefix(scope.slug),
        currentName: current?.name ?? null,
        keep: COMPUTER_HOME_CHECKPOINT_KEEP,
      });
      const response: FleetBrokerComputerHomePruneResult = { deleted };
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

async function recordVmDiskReport(
  deps: ResolvedFleetBrokerRouteDeps,
  req: Request,
  res: Response,
  bound: GatewayBinding,
  observation: Record<string, unknown> | undefined,
): Promise<boolean> {
  const disk = (req.body as Partial<GatewayVmRuntimeRequest> | undefined)?.disk;
  if (disk === undefined) return true;
  if (!isGatewayVmDiskSample(disk)) {
    res.status(400).json({ error: "invalid_disk_sample" });
    return false;
  }
  const vm = observation?.vm as { instanceId?: unknown } | null | undefined;
  if (!bound.podUid || vm?.instanceId !== bound.podUid) return true;
  try {
    await recordComputerDiskObservation(deps.db, bound.gatewayId, observation?.vmDisk, { ...disk, instanceId: bound.podUid, observedAt: deps.now() });
  } catch (error) {
    logger.error("[fleet-broker] computer disk observation failed", { gatewayId: bound.gatewayId, error });
  }
  return true;
}

async function recordVmPreemptionNotice(
  deps: ResolvedFleetBrokerRouteDeps,
  req: Request,
  res: Response,
  bound: GatewayBinding,
  observation: Record<string, unknown> | undefined,
): Promise<boolean> {
  const preempted = (req.body as Partial<GatewayVmRuntimeRequest> | undefined)?.preempted;
  if (preempted === undefined) return true;
  if (preempted !== true) {
    res.status(400).json({ error: "invalid_preemption_notice" });
    return false;
  }
  const vm = observation?.vm as { instanceId?: unknown } | null | undefined;
  if (!bound.podUid || vm?.instanceId !== bound.podUid) return true;
  logger.warn("[fleet-broker] computer announced its Spot preemption", { gatewayId: bound.gatewayId, instanceId: bound.podUid });
  try {
    await recordComputerPreemptionNotice(deps.db, bound.gatewayId, { instanceId: bound.podUid, announcedAt: deps.now() });
  } catch (error) {
    logger.error("[fleet-broker] computer preemption notice not recorded", { gatewayId: bound.gatewayId, error });
    res.status(503).json({ error: "preemption_notice_unrecorded" });
    return false;
  }
  return true;
}

async function recordVmImageReport(
  deps: ResolvedFleetBrokerRouteDeps,
  req: Request,
  res: Response,
  bound: GatewayBinding,
): Promise<boolean> {
  const images = (req.body as Partial<GatewayVmRuntimeRequest> | undefined)?.images;
  if (images === undefined) return true;
  if (!isGatewayVmImageSample(images)) {
    res.status(400).json({ error: "invalid_image_sample" });
    return false;
  }
  if (!bound.podUid) return true;
  const containers = images.containers.map(({ name, imageReference, digests, running }) => ({ name, imageReference, digests, running }));
  try {
    await recordComputerImageObservation(deps.db, bound.gatewayId, { containers, instanceId: bound.podUid, observedAt: deps.now() });
  } catch (error) {
    logger.error("[fleet-broker] computer image observation failed", { gatewayId: bound.gatewayId, error });
    res.status(503).json({ error: "image_observation_unrecorded" });
    return false;
  }
  return true;
}

async function recordVmBootRecoveryReport(deps: ResolvedFleetBrokerRouteDeps, req: Request, res: Response, bound: GatewayBinding, bundleVersion: string): Promise<boolean> {
  const sample = (req.body as Partial<GatewayVmRuntimeRequest> | undefined)?.bootRecovery;
  if (sample === undefined) return true;
  if (!isGatewayVmBootRecoverySample(sample)) { res.status(400).json({ error: "invalid_boot_recovery_sample" }); return false; }
  if (!bound.podUid || sample.ready && sample.bundleVersion !== bundleVersion) return true;
  const { currentPointId, retainedPoints, ready, freeBytes } = sample;
  try {
    await recordComputerBootRecovery(deps.db, bound.gatewayId, { currentPointId, retainedPoints, ready, freeBytes, bundleVersion: sample.bundleVersion, instanceId: bound.podUid, observedAt: deps.now() });
  } catch (error) {
    logger.error("[fleet-broker] computer boot recovery observation failed", { gatewayId: bound.gatewayId, error });
    res.status(503).json({ error: "boot_recovery_unrecorded" }); return false;
  }
  return true;
}

function vmRuntimeCheckpointSignal(home: Partial<GatewayVmHomeState> | undefined): GatewayVmRuntimeResponse["homeCheckpoint"] {
  return {
    requestedAt: typeof home?.checkpointRequestedAt === "number" ? home.checkpointRequestedAt : null,
    completedAt: !homeCheckpointOutstanding(home) && typeof home?.lastCheckpoint?.completedAt === "number" ? home.lastCheckpoint.completedAt : null,
  };
}

function installVmRuntimeRoutes(router: Router, deps: ResolvedFleetBrokerRouteDeps): void {
  const { db } = deps;
  router.post("/vm-runtime", async (req, res) => {
    const bound = boundGateway(req, res);
    if (!bound) return;
    const [snap, observation] = await Promise.all([
      db.doc(gatewayVmRuntimeDocPath(bound.gatewayId)).get(),
      readComputerRuntimeObservation(db, bound.gatewayId),
    ]);
    const bundle = snap.exists ? snap.data() : undefined;
    if (!isGatewayVmRuntimeBundle(bundle) || bundle.gatewayId !== bound.gatewayId) {
      res.status(404).json({ error: "vm_runtime_not_rendered" });
      return;
    }
    if (!(await recordVmBootRecoveryReport(deps, req, res, bound, bundle.version))) return;
    if (!(await recordVmImageReport(deps, req, res, bound))) return;
    if (!(await recordVmPreemptionNotice(deps, req, res, bound, observation))) return;
    if (!(await recordVmDiskReport(deps, req, res, bound, observation))) return;
    const home = observation?.vmHome as Partial<GatewayVmHomeState> | undefined;
    const restoreCheckpoint = validatedHomeRestore(home, res);
    if (restoreCheckpoint === null) return;
    const response: GatewayVmRuntimeResponse = {
      bundle: { ...bundle, ...(restoreCheckpoint ? { homeRestoreCheckpoint: restoreCheckpoint } : {}) },
      homeCheckpoint: vmRuntimeCheckpointSignal(home),
    };
    res.set("cache-control", "no-store");
    res.json(response);
  });
}

function installComputerEgressRoutes(router: Router, deps: ResolvedFleetBrokerRouteDeps): void {
  const { db, now } = deps;
  router.post("/computer-egress", async (req, res) => {
    const bound = boundGateway(req, res);
    if (!bound) return;
    const requested = objectBody(req).mode;
    if (requested !== undefined && !isGatewayEgressMode(requested)) {
      res.status(400).json({ error: "invalid_egress_mode" });
      return;
    }
    const record = await readComputerEgress(db, bound.gatewayId);
    if (record.kind === "missing") {
      res.status(404).json({ error: "gateway_not_found" });
      return;
    }
    let egress: GatewayVmEgressState | null = null;
    if (requested) {
      egress = { mode: requested, updatedAt: now() };
      if (await recordComputerEgress(db, bound.gatewayId, egress) === "missing") {
        res.status(404).json({ error: "gateway_not_found" });
        return;
      }
    } else if (record.kind === "malformed") {
      logger.error("[fleet-broker] stored computer egress record is malformed", { gatewayId: bound.gatewayId, stored: record.stored });
      res.status(409).json({ error: "egress_record_malformed" });
      return;
    } else if (record.kind === "stored") {
      egress = record.egress;
    }
    const response: FleetBrokerComputerEgress = { egress };
    res.set("cache-control", "no-store").json(response);
  });
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

    const patch: { name?: string; persona?: string; emoji?: string; avatarPng?: Buffer } = {};
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (name) {
      if (name.length > 80) {
        res.status(400).json({ error: "invalid_name" });
        return;
      }
      patch.name = name;
    }
    if (body.emoji !== undefined) {
      if (!validIdentityEmoji(body.emoji)) {
        res.status(400).json({ error: "invalid_emoji" }); return;
      }
      patch.emoji = body.emoji.trim();
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
    if (Object.keys(patch).length === 0) {
      res.status(400).json({ error: "empty_identity" });
      return;
    }

    await runBrokered(res, async () => {
      const updated = await applyCoachIdentity({
        uid: assigned.uid,
        slug: assigned.slug,
        name: patch.name,
        persona: patch.persona,
        ...(patch.emoji !== undefined ? { emoji: patch.emoji } : {}),
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
  installBuilderIdentityRoute(router, deps.db);
  installProvisioningRoutes(router, deps);
  installGatewayOpsRoutes(router, deps);
  installVmRuntimeRoutes(router, deps);
  installComputerEgressRoutes(router, deps);
  installAgentRoutes(router, deps);
  return router;
}
