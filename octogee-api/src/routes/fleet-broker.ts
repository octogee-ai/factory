import { Router, type Request, type Response } from "express";
import { FieldValue, type Firestore } from "firebase-admin/firestore";

import { logger } from "../../../gateway-edge/src/middleware/logging.js";
import { isValidUsername } from "../../../shared/types/identity.js";
import type {
  FleetBrokerBlobSignedUrl,
  FleetBrokerChannelBinding,
  FleetBrokerGreetingResult,
  FleetBrokerMacOpsToken,
  FleetBrokerMattermostUpdate,
  FleetBrokerProjectCreateInput,
  FleetBrokerProjectRestore,
  FleetBrokerProvisioningStatus,
  FleetBrokerUsageData,
  FleetBrokerUserSnapshot,
} from "../../../shared/types/fleet-broker.js";
import {
  mapProjectChannelDoc,
  mapWorkspaceChannelDoc,
} from "../../../scripts/lib/customer-snapshot-mapping.js";
import { slugFromAssignedUser } from "../../../scripts/lib/assigned-roster.js";

type GatewayBinding = Extract<Express.Request["boundTenant"], { kind: "gateway" }>;

const FORBIDDEN = { error: "forbidden" } as const;
const OPENCLAW_GATEWAY_ID_FIELD = "provisioning.openclaw.gatewayId";

type AgentProjectActor = {
  uid: string;
  userData: Record<string, unknown>;
  workspaceId: string;
  isAdmin: false;
  source: "agent";
};

type CreateProjectForActor = (
  actor: AgentProjectActor,
  input: FleetBrokerProjectCreateInput,
) => Promise<{ status: number; body: Record<string, unknown> }>;

type ApplyMilestoneSignal = (input: {
  db: Firestore;
  uid: string;
  slug: string;
  milestones: Record<string, unknown>;
}) => Promise<void>;

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
  createProjectForActor?: CreateProjectForActor;
  applyMilestoneSignal?: ApplyMilestoneSignal;
  recordUsageEvent?: RecordUsageEvent;
  createBlobSignedUrl?: CreateBlobSignedUrl;
  mintMacOpsToken?: MintMacOpsToken;
}

const BLOB_SIGNED_URL_TTL_MS = 10 * 60 * 1000;
const BLOB_SYNC_MAX_SIZE = 100 * 1024 * 1024;
const MAC_OPS_PAT_DESCRIPTION = "Octogee Mac ops agent (OpenClaw)";

async function defaultProvisionMattermost(input: {
  uid: string;
  userData: Record<string, unknown>;
}): Promise<FleetBrokerMattermostUpdate> {
  const { buildProvisioningContext, provisionMattermost } = await import(
    "../../../scripts/lib/provisionSteps.js"
  );
  return provisionMattermost(buildProvisioningContext(input.uid, input.userData));
}

async function defaultMarkProvisioningComplete(input: {
  uid: string;
  userData: Record<string, unknown>;
  mmUpdate: FleetBrokerMattermostUpdate;
}): Promise<void> {
  const { buildProvisioningContext, markProvisioningComplete } = await import(
    "../../../scripts/lib/provisionSteps.js"
  );
  const ctx = buildProvisioningContext(input.uid, input.userData);
  await markProvisioningComplete(ctx, input.mmUpdate, [`octogee-${ctx.slug}-coach`]);
}

async function defaultNotifyOpsOfSignup(input: {
  uid: string;
  userData: Record<string, unknown>;
}): Promise<void> {
  const { buildProvisioningContext, notifyOpsOfSignup } = await import(
    "../../../scripts/lib/provisionSteps.js"
  );
  await notifyOpsOfSignup(buildProvisioningContext(input.uid, input.userData));
}

const defaultCreateProjectForActor: CreateProjectForActor = async (actor, input) => {
  const { createProjectForActor } = await import(
    "../../../gateway-edge/src/lib/project-create-service.js"
  );
  return createProjectForActor(actor, input);
};

const defaultApplyMilestoneSignal: ApplyMilestoneSignal = async (input) => {
  const { mmApi } = await import("../../../gateway-edge/src/lib/mattermost.js");
  const userUpdate: Record<string, unknown> = {
    "onboarding.updatedAt": FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  };
  for (const [key, value] of Object.entries(input.milestones)) {
    if (key === "coachName" || key === "coachPersonality" || key === "avatarEmoji") {
      continue;
    }
    userUpdate[`onboarding.${key}`] = value;
  }
  if (input.milestones.complete === true) {
    userUpdate["onboarding.complete"] = true;
  }
  await input.db.collection("users").doc(input.uid).update(userUpdate);

  const agentUpdate: Record<string, unknown> = {};
  if (typeof input.milestones.coachName === "string" && input.milestones.coachName) {
    agentUpdate.name = input.milestones.coachName;
  }
  if (typeof input.milestones.coachPersonality === "string") {
    agentUpdate.persona = input.milestones.coachPersonality;
  }
  if (typeof input.milestones.avatarEmoji === "string" && input.milestones.avatarEmoji) {
    agentUpdate.avatarEmoji = input.milestones.avatarEmoji;
  }
  if (Object.keys(agentUpdate).length > 0) {
    agentUpdate.id = input.uid;
    agentUpdate.updatedAt = FieldValue.serverTimestamp();
    await input.db.doc(`agents/${input.uid}`).set(agentUpdate, { merge: true });
  }

  if (typeof input.milestones.coachName === "string" && input.milestones.coachName) {
    try {
      const [sysDoc, userDoc] = await Promise.all([
        input.db.doc(`users/${input.uid}/system/config`).get(),
        input.db.collection("users").doc(input.uid).get(),
      ]);
      const coachMmUserId =
        stringAt(sysDoc.data() as Record<string, unknown> | undefined, "mattermost.coachUserId") ||
        stringAt(userDoc.data() as Record<string, unknown> | undefined, "mattermost.coachUserId");
      if (coachMmUserId) {
        await mmApi("PUT", `/bots/${coachMmUserId}`, {
          display_name: input.milestones.coachName,
        });
      }
    } catch (err) {
      logger.warn("[milestones] failed to patch coach Mattermost display", {
        slug: input.slug,
        err,
      });
    }
  }
};

const defaultRecordUsageEvent: RecordUsageEvent = async (input) => {
  const { extractRole, reportUsageForUid } = await import(
    "../../../scripts/lib/usage-tracking.js"
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

function validUsageData(value: unknown): FleetBrokerUsageData | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const data = value as Record<string, unknown>;
  const cost = data.costBreakdown;
  if (!cost || typeof cost !== "object" || Array.isArray(cost)) return null;
  const costBreakdown = cost as Record<string, unknown>;
  const input = finiteNonNegative(data.input);
  const output = finiteNonNegative(data.output);
  const cacheRead = finiteNonNegative(data.cacheRead);
  const cacheWrite = finiteNonNegative(data.cacheWrite);
  const totalTokens = finiteNonNegative(data.totalTokens);
  const costUsd = finiteNonNegative(data.costUsd);
  const model = typeof data.model === "string" ? data.model.trim() : "";
  const costInput = finiteNonNegative(costBreakdown.input);
  const costOutput = finiteNonNegative(costBreakdown.output);
  const costCacheRead = finiteNonNegative(costBreakdown.cacheRead);
  const costCacheWrite = finiteNonNegative(costBreakdown.cacheWrite);
  if (
    input === null ||
    output === null ||
    cacheRead === null ||
    cacheWrite === null ||
    totalTokens === null ||
    costUsd === null ||
    model.length === 0 ||
    model.length > 200 ||
    costInput === null ||
    costOutput === null ||
    costCacheRead === null ||
    costCacheWrite === null
  ) {
    return null;
  }
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    totalTokens,
    costUsd,
    model,
    costBreakdown: {
      input: costInput,
      output: costOutput,
      cacheRead: costCacheRead,
      cacheWrite: costCacheWrite,
    },
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

function validMilestoneValue(value: unknown): boolean {
  return (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  );
}

function validMilestones(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const out: Record<string, unknown> = {};
  for (const [key, milestoneValue] of Object.entries(value as Record<string, unknown>)) {
    if (!/^\w{1,64}$/.test(key)) return null;
    if (!validMilestoneValue(milestoneValue)) return null;
    out[key] = milestoneValue;
  }
  return Object.keys(out).length > 0 ? out : null;
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

async function findAssignedUserByAgentId(
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

async function loadSnapshot(
  db: Firestore,
  uid: string,
  data: Record<string, unknown>,
): Promise<FleetBrokerUserSnapshot | null> {
  const slug = slugFromAssignedUser(data);
  if (!slug || !isValidUsername(slug)) return null;
  const [channels, projects, coachSecret, agentSnap] = await Promise.all([
    collectChannelBindings(db, slug),
    collectProjects(db, slug),
    db.collection("users").doc(uid).collection("secrets").doc("coachMattermost").get(),
    db.collection("agents").doc(uid).get(),
  ]);
  const coachData = coachSecret.data() as Record<string, unknown> | undefined;
  const agentData = agentSnap.data() as Record<string, unknown> | undefined;
  const name = typeof agentData?.name === "string" ? agentData.name : "";
  const emoji = typeof agentData?.avatarEmoji === "string" ? agentData.avatarEmoji : "";
  const status = stringAt(data, "provisioning.openclaw.status");
  return {
    uid,
    slug,
    tier: stringAt(data, "tier") || stringAt(data, "subscription.tier") || "trial",
    gatewayId: stringAt(data, OPENCLAW_GATEWAY_ID_FIELD),
    status: status === "provisioning" || status === "complete" ? status : "",
    agentIds: stringArray(readPath(data, "provisioning.openclaw.agentIds")),
    repoUrl: stringAt(data, "provisioning.git.repoUrl"),
    mattermostUserId: stringAt(data, "mattermost.userId") || null,
    customerMmUserId: stringAt(data, "mattermost.userId") || null,
    greetingPosted: Boolean((readPath(data, "provisioning.openclaw.greeting") as { ok?: unknown } | undefined)?.ok),
    channels,
    projects,
    ownerName: stringAt(data, "displayName") || stringAt(data, "username") || slug,
    email: stringAt(data, "email"),
    displayName: stringAt(data, "displayName"),
    lastName: stringAt(data, "lastName"),
    photoURL: stringAt(data, "photoURL"),
    onboardingVibe:
      typeof readPath(data, "onboarding.vibe") === "string"
        ? (readPath(data, "onboarding.vibe") as string)
        : null,
    coachToken: typeof coachData?.personalToken === "string" ? coachData.personalToken : null,
    coachMmUserId:
      typeof coachData?.coachMmUserId === "string" ? coachData.coachMmUserId : null,
    ...(name || emoji ? { coachIdentity: { name, emoji } } : {}),
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

export function createFleetBrokerRoutes(opts: { db: Firestore } & FleetBrokerRouteDeps): Router {
  const router = Router();
  const { db } = opts;
  const provisionMattermost = opts.provisionMattermost ?? defaultProvisionMattermost;
  const markProvisioningComplete =
    opts.markProvisioningComplete ?? defaultMarkProvisioningComplete;
  const notifyOpsOfSignup = opts.notifyOpsOfSignup ?? defaultNotifyOpsOfSignup;
  const createProjectForActor =
    opts.createProjectForActor ?? defaultCreateProjectForActor;
  const applyMilestoneSignal =
    opts.applyMilestoneSignal ?? defaultApplyMilestoneSignal;
  const recordUsageEvent = opts.recordUsageEvent ?? defaultRecordUsageEvent;
  const createBlobSignedUrl = opts.createBlobSignedUrl ?? defaultCreateBlobSignedUrl;
  const mintMacOpsToken = opts.mintMacOpsToken ?? defaultMintMacOpsToken;

  router.post("/assigned-users", async (req, res) => {
    const bound = boundGateway(req, res);
    if (!bound) return;
    const completeOnly = req.body?.completeOnly === true;
    const snap = await db
      .collection("users")
      .where(OPENCLAW_GATEWAY_ID_FIELD, "==", bound.gatewayId)
      .get();
    const users: FleetBrokerUserSnapshot[] = [];
    for (const doc of snap.docs) {
      const data = await isAssignedToGateway(db, bound.gatewayId, doc.id, doc.data() as Record<string, unknown>);
      if (!data) continue;
      if (completeOnly && stringAt(data, "provisioning.openclaw.status") !== "complete") {
        continue;
      }
      const snapshot = await loadSnapshot(db, doc.id, data);
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
    const snapshot = await loadSnapshot(db, uid, data);
    if (!snapshot) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    res.json({ user: snapshot });
  });

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

  router.post("/mac-ops-token", async (req, res) => {
    const bound = boundGateway(req, res);
    if (!bound) return;
    await runBrokered(res, async () => {
      const token = await mintMacOpsToken({ gatewayId: bound.gatewayId });
      res.json(token);
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
    const usage = validUsageData(body.usage);
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

  router.post("/agent/create-project", async (req, res) => {
    const assigned = await requireAssignedAgentWorkspace(db, req, res);
    if (!assigned) return;
    const project = recordBodyValue(objectBody(req).project);
    if (!project) {
      res.status(400).json({ error: "invalid_project" });
      return;
    }
    await runBrokered(res, async () => {
      const result = await createProjectForActor(
        {
          uid: assigned.uid,
          userData: assigned.data,
          workspaceId: assigned.slug,
          isAdmin: false,
          source: "agent",
        },
        project as FleetBrokerProjectCreateInput,
      );
      res.status(result.status).json(result.body);
    });
  });

  router.post("/agent/apply-milestones", async (req, res) => {
    const assigned = await requireAssignedAgentWorkspace(db, req, res);
    if (!assigned) return;
    const milestones = validMilestones(objectBody(req).milestones);
    if (!milestones) {
      res.status(400).json({ error: "invalid_milestones" });
      return;
    }
    await runBrokered(res, async () => {
      await applyMilestoneSignal({
        db,
        uid: assigned.uid,
        slug: assigned.slug,
        milestones,
      });
      res.status(204).end();
    });
  });

  return router;
}
