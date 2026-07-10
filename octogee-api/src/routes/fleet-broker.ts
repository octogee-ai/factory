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
  FleetBrokerChannelBinding,
  FleetBrokerGreetingResult,
  FleetBrokerMacOpsToken,
  FleetBrokerMattermostUpdate,
  FleetBrokerPreStopFlushEvent,
  FleetBrokerPreStopFlushStep,
  FleetBrokerProjectRestore,
  FleetBrokerProvisioningStatus,
  FleetBrokerUsageData,
  FleetBrokerUserSnapshot,
} from "@octogee/shared/types/fleet-broker";
import {
  GLM_GATEWAYS_COLLECTION,
  isGatewayClass,
  isGatewayProfile,
  resolveGatewayClass,
} from "@octogee/shared/types/glm";
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
  mountsOnRevision,
  readAssignmentDocsForGateway,
} from "@octogee/core/assignment-doc";
import { GATEWAYS_COLLECTION } from "@octogee/shared/types/fleet-controller";
import {
  isGatewayDesiredDoc,
  revisionIdForRelease,
} from "@octogee/shared/types/gateway-releases";
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

type MintMacOpsToken = (input: {
  gatewayId: string;
}) => Promise<FleetBrokerMacOpsToken>;

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
  excludeMmUserId: string;
  /** Agent bot's own credential — used only for the `unread` read cursor. */
  unread: { pat: string; mmUserId: string };
  slug: string;
  siteUrl: string;
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
  excludeMmUserId: string;
  unread: { pat: string; mmUserId: string };
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
  notifyOpsOfSignup?: (input: {
    uid: string;
    userData: Record<string, unknown>;
  }) => Promise<void>;
  recordUsageEvent?: RecordUsageEvent;
  renderAvatar?: RenderAvatar;
  applyCoachIdentity?: ApplyCoachIdentity;
  createBlobSignedUrl?: CreateBlobSignedUrl;
  mintMacOpsToken?: MintMacOpsToken;
  executeChatSearch?: ExecuteChatSearch;
  executeChatHistory?: ExecuteChatHistory;
  resolveChatIdentity?: ResolveChatIdentity;
  webResearch?: Pick<ReturnType<typeof createWebResearchService>, "search" | "extract">;
}

const BLOB_SIGNED_URL_TTL_MS = 10 * 60 * 1000;
const BLOB_SYNC_MAX_SIZE = 100 * 1024 * 1024;
const MAC_OPS_PAT_DESCRIPTION = "Octogee Mac ops agent (OpenClaw)";

async function defaultProvisionMattermost(input: {
  uid: string;
  userData: Record<string, unknown>;
}): Promise<FleetBrokerMattermostUpdate> {
  const { buildProvisioningContext, provisionMattermost } = await import(
    "@octogee/core/provisionSteps"
  );
  return provisionMattermost(buildProvisioningContext(input.uid, input.userData));
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

function mattermostBaseUrl(): string {
  return (
    process.env.MM_URL ||
    process.env.MM_INTERNAL_URL ||
    `http://mattermost.${process.env.K8S_NAMESPACE || "octogee"}.svc.cluster.local:8065`
  );
}

async function mmAdminCall(
  method: string,
  endpoint: string,
  body?: unknown,
): Promise<Record<string, unknown> | Record<string, unknown>[] | null> {
  const token = process.env.MM_ADMIN_TOKEN;
  if (!token) throw new Error("MM_ADMIN_TOKEN not configured");
  const resp = await fetch(`${mattermostBaseUrl()}/api/v4${endpoint}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (resp.status >= 500) {
    const text = await resp.text().catch(() => "");
    throw new Error(`MM ${method} ${endpoint} -> ${resp.status} ${text.slice(0, 200)}`);
  }
  if (!resp.ok || resp.status === 204) return null;
  return (await resp.json()) as Record<string, unknown> | Record<string, unknown>[];
}

async function provisionMacOpsBot(gatewayId: string): Promise<{
  mmUserId: string;
  username: string;
}> {
  const username = `mac-${gatewayId}`;
  const created = await mmAdminCall("POST", "/bots", {
    username,
    display_name: "Mac",
    description: `Octogee ops agent for ${gatewayId}`,
  });
  if (!Array.isArray(created)) {
    const id = stringAt(created ?? undefined, "user_id") || stringAt(created ?? undefined, "id");
    if (id) return { mmUserId: id, username };
  }

  const existing = await mmAdminCall("GET", `/users/username/${username}`);
  if (!Array.isArray(existing)) {
    const id = stringAt(existing ?? undefined, "id");
    if (id) return { mmUserId: id, username };
  }
  throw new Error(`Mac ops bot ${username} not found or created`);
}

async function revokeStaleMacOpsTokens(mmUserId: string): Promise<void> {
  const existing = await mmAdminCall("GET", `/users/${mmUserId}/tokens`);
  if (!Array.isArray(existing)) return;
  for (const token of existing) {
    if (
      token.description === MAC_OPS_PAT_DESCRIPTION &&
      typeof token.id === "string" &&
      token.id.length > 0
    ) {
      await mmAdminCall("POST", "/users/tokens/revoke", { token_id: token.id });
    }
  }
}

const defaultMintMacOpsToken: MintMacOpsToken = async ({ gatewayId }) => {
  const bot = await provisionMacOpsBot(gatewayId);
  await revokeStaleMacOpsTokens(bot.mmUserId);
  const minted = await mmAdminCall("POST", `/users/${bot.mmUserId}/tokens`, {
    description: MAC_OPS_PAT_DESCRIPTION,
  });
  if (Array.isArray(minted) || typeof minted?.token !== "string" || !minted.token) {
    throw new Error(`Mac ops token mint failed for ${bot.username}`);
  }
  return {
    gatewayId,
    username: bot.username,
    mmUserId: bot.mmUserId,
    token: minted.token,
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

function gatewayClassFromGlmDoc(data: Record<string, unknown> | undefined): string {
  if (!data) return "shared";
  return resolveGatewayClass({
    gatewayClass: isGatewayClass(data.gatewayClass) ? data.gatewayClass : undefined,
    profile: isGatewayProfile(data.profile) ? data.profile : undefined,
    imageProfile: isGatewayProfile(data.imageProfile) ? data.imageProfile : undefined,
  });
}

function warmTargetGatewayId(data: Record<string, unknown> | undefined): string | null {
  const preemption =
    data?.preemption && typeof data.preemption === "object"
      ? (data.preemption as Record<string, unknown>)
      : {};
  return typeof preemption.warmTargetGatewayId === "string" &&
    preemption.warmTargetGatewayId.length > 0
    ? preemption.warmTargetGatewayId
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
    if (!data || data.approved !== true) continue;
    if (agentBelongsToAssignedWorkspace(data, agentId)) {
      return { uid: doc.id, data };
    }
  }
  return null;
}

async function findApprovedUsersByAgentId(
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
      if (!data || data.approved !== true || !agentBelongsToAssignedWorkspace(data, agentId)) {
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

  const candidates = await findApprovedUsersByAgentId(db, agentId);
  for (const candidate of candidates) {
    if (await hasRunningInboundMigrationForUid(db, gatewayId, candidate.uid)) {
      return candidate;
    }
  }
  return null;
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
  if (!userData || userData.approved !== true) return null;
  return stringAt(userData, OPENCLAW_GATEWAY_ID_FIELD) === gatewayId ? userData : null;
}

// Defense-in-depth against same-gateway revision spoofing (PR5 review P1). The
// KSA binds the BARE gateway, but the revisionId is self-reported, so a pod
// bound as `default` could otherwise request `default-r2` while running r1 and
// double-mount during a roll. This is NOT a cross-tenant boundary (both revisions
// serve the same tenant); it rejects an out-of-family or non-active revision.
// (Deferred hardening: true revision-authenticated pod identity — vs the
// self-reported GATEWAY_REVISION_ID env — is a later item, since it is not a
// cross-tenant boundary today.)
type RevisionGatewayState = {
  desiredRelease?: unknown;
  liveRevisionId?: unknown;
  roll?: { targetRevisionId?: unknown } | null;
};

export function isRequestedRevisionAllowed(
  gatewayId: string,
  revisionId: string,
  gatewayDoc: RevisionGatewayState | undefined,
): boolean {
  if (!revisionId) return true; // legacy pod: no filtering
  if (!revisionId.startsWith(`${gatewayId}-r`)) return false; // wrong gateway / malformed
  if (!gatewayDoc) return true; // pre-backfill: prefix is the only boundary
  const live = typeof gatewayDoc.liveRevisionId === "string" ? gatewayDoc.liveRevisionId : null;
  const roll = gatewayDoc.roll as { targetRevisionId?: unknown } | null | undefined;
  const target = typeof roll?.targetRevisionId === "string" ? roll.targetRevisionId : null;
  const firstDesired =
    live === null && typeof gatewayDoc.desiredRelease === "number"
      ? revisionIdForRelease(gatewayId, gatewayDoc.desiredRelease)
      : null;
  return revisionId === live || revisionId === target || revisionId === firstDesired;
}

// The full revision-request gate for the /assigned-users mount driver. An
// empty/absent revisionId is the legacy escape hatch (mount everyone) — but it is
// permitted ONLY when the bound gateway is genuinely pre-backfill: no
// gateways/{gw} desired doc AND no assignment docs. A backfilled gateway that
// omits its revision would otherwise downgrade the revision-filtered roster to
// the FULL roster and double-mount during a roll, so it is rejected (the pod must
// report its GATEWAY_REVISION_ID). Non-empty revisions keep the existing
// same-gateway spoofing validation.
export function isRevisionRosterRequestAllowed(input: {
  gatewayId: string;
  podRevisionId: string;
  gatewayDoc: RevisionGatewayState | undefined;
  hasAssignmentDocs: boolean;
}): boolean {
  if (!input.podRevisionId) {
    return !input.gatewayDoc && !input.hasAssignmentDocs;
  }
  return isRequestedRevisionAllowed(input.gatewayId, input.podRevisionId, input.gatewayDoc);
}

// Reads the gateway's desired doc (and, for an omitted revision, its assignment
// docs) and applies the revision-request gate. Returns the live revision for the
// mount filter when allowed, else { allowed: false } → the route answers 400.
async function resolveAssignedUsersRevisionGate(
  db: Firestore,
  gatewayId: string,
  podRevisionId: string,
): Promise<{ allowed: false } | { allowed: true; liveRevisionId: string | null }> {
  const gatewaySnap = await db.collection(GATEWAYS_COLLECTION).doc(gatewayId).get();
  const gatewayData = gatewaySnap.data();
  const gatewayDoc = isGatewayDesiredDoc(gatewayData) ? gatewayData : undefined;
  const hasAssignmentDocs = podRevisionId
    ? false
    : (await readAssignmentDocsForGateway(db, gatewayId)).length > 0;
  if (!isRevisionRosterRequestAllowed({ gatewayId, podRevisionId, gatewayDoc, hasAssignmentDocs })) {
    return { allowed: false };
  }
  const liveRevisionId =
    typeof gatewayDoc?.liveRevisionId === "string" ? gatewayDoc.liveRevisionId : null;
  return { allowed: true, liveRevisionId };
}

// The roster (mount driver) predicate for one revision pod: an approved,
// bare-assigned user mounts on the pod's revision iff mountsOnRevision says so
// (assignment doc → its revision; gap user → the live revision). Legacy pods
// (empty revisionId) load nothing and mount everyone — byte-identical to today.
export async function buildRosterRevisionFilter(
  db: Firestore,
  gatewayId: string,
  podRevisionId: string,
  liveRevisionId: string | null,
): Promise<(uid: string) => boolean> {
  if (!podRevisionId) return () => true;
  const assignments = await readAssignmentDocsForGateway(db, gatewayId);
  const assignmentRevisionByUid = new Map(assignments.map((a) => [a.uid, a.revisionId]));
  return (uid: string) =>
    mountsOnRevision({
      podRevisionId,
      liveRevisionId,
      assignmentRevisionId: assignmentRevisionByUid.get(uid) ?? null,
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
    if (data?.approved !== true) continue;
    if (slugFromAssignedUser(data) === slug) return doc.id;
  }
  return null;
}

type ResolvedFleetBrokerRouteDeps = {
  db: Firestore;
  resolveFreeTierModel: FreeTierModelResolver;
  provisionMattermost: NonNullable<FleetBrokerRouteDeps["provisionMattermost"]>;
  markProvisioningComplete: NonNullable<FleetBrokerRouteDeps["markProvisioningComplete"]>;
  notifyOpsOfSignup: NonNullable<FleetBrokerRouteDeps["notifyOpsOfSignup"]>;
  recordUsageEvent: RecordUsageEvent;
  renderAvatar: RenderAvatar;
  applyCoachIdentity: ApplyCoachIdentity;
  createBlobSignedUrl: CreateBlobSignedUrl;
  mintMacOpsToken: MintMacOpsToken;
  executeChatSearch: ExecuteChatSearch;
  executeChatHistory: ExecuteChatHistory;
  resolveChatIdentity: ResolveChatIdentity;
  webResearch: Pick<ReturnType<typeof createWebResearchService>, "search" | "extract">;
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
    notifyOpsOfSignup: opts.notifyOpsOfSignup ?? defaultNotifyOpsOfSignup,
    recordUsageEvent: opts.recordUsageEvent ?? defaultRecordUsageEvent,
    renderAvatar: opts.renderAvatar ?? defaultRenderAvatar,
    applyCoachIdentity: opts.applyCoachIdentity ?? defaultApplyCoachIdentity,
    createBlobSignedUrl: opts.createBlobSignedUrl ?? defaultCreateBlobSignedUrl,
    mintMacOpsToken: opts.mintMacOpsToken ?? defaultMintMacOpsToken,
    executeChatSearch: opts.executeChatSearch ?? defaultExecuteChatSearch,
    executeChatHistory: opts.executeChatHistory ?? defaultExecuteChatHistory,
    resolveChatIdentity: opts.resolveChatIdentity ?? defaultResolveChatIdentity,
    webResearch: opts.webResearch ?? createDefaultWebResearch(opts.db),
  };
}

function installSnapshotRoutes(
  router: Router,
  deps: ResolvedFleetBrokerRouteDeps,
): void {
  const { db } = deps;

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
      res.status(400).json({
        error: "invalid_revision",
        gatewayId: bound.gatewayId,
        revisionId: podRevisionId,
      });
      return;
    }
    const revisionFilter = await buildRosterRevisionFilter(
      db,
      bound.gatewayId,
      podRevisionId,
      gate.liveRevisionId,
    );
    const snap = await db
      .collection("users")
      .where(OPENCLAW_GATEWAY_ID_FIELD, "==", bound.gatewayId)
      .get();
    const freeTierModelRef = (await deps.resolveFreeTierModel()).ref;
    const users: FleetBrokerUserSnapshot[] = [];
    for (const doc of snap.docs) {
      const data = await isAssignedToGateway(db, bound.gatewayId, doc.id, doc.data() as Record<string, unknown>);
      if (!data) continue;
      // Revision-aware mount driver (GATEWAY-RELEASES-SPEC): during a same-gateway
      // roll both revision pods hit this with the SAME bare tenant — the filter
      // keeps each pod to its own revision so both never mount the full roster.
      if (!revisionFilter(doc.id)) continue;
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

function installProvisioningRoutes(
  router: Router,
  deps: ResolvedFleetBrokerRouteDeps,
): void {
  const { db, provisionMattermost, markProvisioningComplete, notifyOpsOfSignup } = deps;

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

function installGatewayOpsRoutes(
  router: Router,
  deps: ResolvedFleetBrokerRouteDeps,
): void {
  const { db, mintMacOpsToken, recordUsageEvent, createBlobSignedUrl } = deps;

  router.post("/mac-ops-token", async (req, res) => {
    const bound = boundGateway(req, res);
    if (!bound) return;
    await runBrokered(res, async () => {
      const token = await mintMacOpsToken({ gatewayId: bound.gatewayId });
      res.json(token);
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
      const glmRef = db.collection(GLM_GATEWAYS_COLLECTION).doc(bound.gatewayId);
      await db.runTransaction(async (txn) => {
        const glmSnap = await txn.get(glmRef);
        const glmData = glmSnap.exists
          ? (glmSnap.data() as Record<string, unknown> | undefined)
          : undefined;
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

        if (!glmSnap.exists) return;
        const gatewayClass = gatewayClassFromGlmDoc(glmData);
        const targetGatewayId = warmTargetGatewayId(glmData);
        if (
          event.phase === "started" &&
          (gatewayClass === "builder" || gatewayClass === "operator") &&
          targetGatewayId
        ) {
          txn.set(
            glmRef,
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
          typeof readPath(glmData, "preemptionHandoff.status") === "string";
        if (event.phase === "completed" && (targetGatewayId || hasExistingHandoff)) {
          txn.set(
            glmRef,
            {
              preemptionHandoff: {
                flushCompletedAt: FieldValue.serverTimestamp(),
                flushOk: event.result?.ok === true,
              },
            },
            { merge: true },
          );
        }
      });
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
  // Strict scheme check — the value lands in permalinks returned to the agent.
  const siteUrl = typeof body.siteUrl === "string" && /^https?:\/\//.test(body.siteUrl)
    ? body.siteUrl
    : "";
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
        excludeMmUserId: resolved.excludeMmUserId,
        unread: resolved.unread,
        slug,
        siteUrl,
      },
    };
  } catch (err) {
    const code = (err as { code?: unknown }).code;
    if (code === "invalid-agent") {
      res.status(400).json({ error: "invalid_agent_id", code });
      return null;
    }
    if (
      code === "foreign-agent" ||
      code === "no-builder-pat" ||
      code === "no-coach-identity" ||
      code === "no-project-pat"
    ) {
      res.status(403).json({ error: "forbidden", code });
      return null;
    }
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
