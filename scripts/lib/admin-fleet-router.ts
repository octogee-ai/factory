

import {
  Router,
  type Request,
  type Response,
  type NextFunction,
} from "express";
import { FieldValue, type Firestore } from "firebase-admin/firestore";
import {
  GLM_GATEWAYS_COLLECTION,
  GLM_OPERATIONS_COLLECTION,
  GATEWAY_PROFILES,
  type GatewayProfile,
} from "../../shared/types/glm.js";
import {
  SIZING_TIERS,
  resolveSizingTier,
  type SizingTier,
} from "../../shared/types/sizing.js";
import { estimateGatewayMonthlyCost } from "../../shared/types/cost-estimator.js";
import { IMAGE_TAG_PATTERN } from "./image-tag.js";

export interface FleetLogger {
  info: (msg: string, meta?: Record<string, unknown>) => void;
  warn: (msg: string, meta?: Record<string, unknown>) => void;
}

export interface FleetRouterDeps {
  db: Firestore;
  logger: FleetLogger;
  workspaceSlugsForUser: (data: { username?: string | null }) => string[];
  provisionGatewayAuthSecret: (opts: {
    gatewayId: string;
    gatewayServiceAccount: string;
  }) => Promise<unknown>;
  listGatewayBuilds: (opts: {
    service: string;
    limit: number;
  }) => Promise<unknown[]>;
  
  deleteAuthUserTolerantOfMissing: (uid: string) => Promise<void>;
}

type ActorRequest = Request & {
  uid?: string;
  user?: { email?: string | null };
};

function resolveSizingForResponse(
  glmDoc: Record<string, unknown> | undefined,
): {
  tier: SizingTier;
  resolvedFrom: "explicit" | "profile-default";
  resources: { requests: { cpu: string; memory: string }; limits: { cpu: string; memory: string } };
  capacity: { targetActiveBuilders: number; typicalBuilders: number };
  monthlyCostUsd: { compute: number; perBuilderAtTarget: number; perBuilderAtTypical: number };
} {
  const sizingTier =
    typeof glmDoc?.sizingTier === "string" && (SIZING_TIERS as readonly string[]).includes(glmDoc.sizingTier)
      ? (glmDoc.sizingTier as SizingTier)
      : undefined;
  const profile =
    typeof glmDoc?.profile === "string" && (GATEWAY_PROFILES as readonly string[]).includes(glmDoc.profile)
      ? (glmDoc.profile as GatewayProfile)
      : undefined;
  const resolved = resolveSizingTier({ sizingTier, profile });
  // Paused pods are scaled to 0 replicas → no node consumption → no compute
  // bill. Reflect that in both the per-gateway surface and the fleet roll-up
  // so the operator sees real cost, not nameplate.
  const isPaused = glmDoc?.desiredStatus === "paused";
  const cost = isPaused
    ? { computeUsd: 0, perBuilderAtTarget: 0, perBuilderAtTypical: 0 }
    : estimateGatewayMonthlyCost(resolved.tier);
  return {
    tier: resolved.tier,
    resolvedFrom: resolved.resolvedFrom,
    resources: {
      requests: {
        cpu: resolved.preset.resources.requests.cpu,
        memory: resolved.preset.resources.requests.memory,
      },
      limits: {
        cpu: resolved.preset.resources.limits.cpu,
        memory: resolved.preset.resources.limits.memory,
      },
    },
    capacity: resolved.preset.capacity,
    monthlyCostUsd: {
      compute: cost.computeUsd,
      perBuilderAtTarget: cost.perBuilderAtTarget,
      perBuilderAtTypical: cost.perBuilderAtTypical,
    },
  };
}

type GlmDoc = Record<string, unknown>;
interface FirestoreDocLike { id: string; data(): GlmDoc }
interface JobsByGateway { jobsByGateway: Map<string, Array<{ id: string; data: GlmDoc }>>; mounting: number; staleJobs: number; pending: number }
interface JobsTotals { mounting: number; staleJobs: number; pending: number }

function indexGlmDocs(docs: ReadonlyArray<FirestoreDocLike>): Map<string, GlmDoc> {
  const out = new Map<string, GlmDoc>();
  for (const doc of docs) out.set(doc.id, doc.data());
  return out;
}

function aggregateJobs(docs: ReadonlyArray<FirestoreDocLike>, now: number): JobsByGateway {
  const jobsByGateway = new Map<string, Array<{ id: string; data: GlmDoc }>>();
  let mounting = 0, staleJobs = 0, pending = 0;
  for (const doc of docs) {
    const data = doc.data();
    const gid = typeof data.gatewayId === "string" ? data.gatewayId : "";
    const arr = jobsByGateway.get(gid) ?? [];
    arr.push({ id: doc.id, data });
    jobsByGateway.set(gid, arr);
    const state = data.state;
    if (state === "pending") pending++;
    if (state === "dispatched" || state === "running") {
      const ageMs = toMillis(data.dispatchedAt) ?? toMillis(data.createdAt);
      if (ageMs != null && now - ageMs > JOB_TTL_MS) staleJobs++;
      else mounting++;
    }
  }
  return { jobsByGateway, mounting, staleJobs, pending };
}

function projectInFlightJob(
  inFlightJobId: string | null,
  ownJobs: ReadonlyArray<{ id: string; data: GlmDoc }>,
  now: number,
): { jobId: string; slug: unknown; state: unknown; ageMs: number } | null {
  const raw = inFlightJobId ? ownJobs.find((j) => j.id === inFlightJobId) : null;
  if (!raw) return null;
  const dispatchedMs = toMillis(raw.data.dispatchedAt) ?? toMillis(raw.data.createdAt);
  return {
    jobId: raw.id,
    slug: raw.data.slug,
    state: raw.data.state,
    ageMs: dispatchedMs == null ? 0 : now - dispatchedMs,
  };
}

function projectLastError(raw: unknown):
  | { jobId?: string; slug?: string; message?: string; at: string | null }
  | null {
  if (!raw || typeof raw !== "object") return null;
  const e = raw as { jobId?: string; slug?: string; message?: string; at?: unknown };
  return { jobId: e.jobId, slug: e.slug, message: e.message, at: toIso(e.at) };
}

function projectDesiredStatus(glmDoc: GlmDoc | undefined):
  | "running" | "paused" | "draining" | "retired" | null {
  const v = glmDoc?.desiredStatus;
  if (typeof v !== "string") return null;
  if (v === "running" || v === "paused" || v === "draining" || v === "retired") return v;
  return null;
}

function projectGatewaySummary(
  doc: FirestoreDocLike,
  ownJobs: ReadonlyArray<{ id: string; data: GlmDoc }>,
  glmDoc: GlmDoc | undefined,
  now: number,
): {
  gatewayId: string; status: string;
  desiredStatus: "running" | "paused" | "draining" | "retired" | null;
  imageTag: string | null; openclawVersion: string | null;
  mountedCustomers: unknown[];
  lastHeartbeatAt: string | null; heartbeatAgeMs: number | null;
  startedAt: string | null; uptimeMs: number | null;
  inFlightJobId: string | null;
  inFlightJob: ReturnType<typeof projectInFlightJob>;
  lastError: ReturnType<typeof projectLastError>;
  sizing: ReturnType<typeof resolveSizingForResponse>;
} {
  const data = doc.data();
  const inFlightJobId = typeof data.inFlightJobId === "string" ? data.inFlightJobId : null;
  return {
    gatewayId: typeof data.gatewayId === "string" ? data.gatewayId : doc.id,
    status: typeof data.status === "string" ? data.status : "unknown",
    desiredStatus: projectDesiredStatus(glmDoc),
    imageTag: typeof data.version === "string" ? data.version : null,
    openclawVersion: typeof data.openclawVersion === "string" ? data.openclawVersion : null,
    mountedCustomers: Array.isArray(data.mountedCustomers) ? data.mountedCustomers : [],
    lastHeartbeatAt: toIso(data.lastHeartbeatAt),
    heartbeatAgeMs: ageMsOrNull(toMillis(data.lastHeartbeatAt), now),
    startedAt: toIso(data.startedAt),
    uptimeMs: ageMsOrNull(toMillis(data.startedAt), now),
    inFlightJobId,
    inFlightJob: projectInFlightJob(inFlightJobId, ownJobs, now),
    lastError: projectLastError(data.lastError),
    sizing: resolveSizingForResponse(glmDoc),
  };
}

function rollupFleetStats(
  gateways: ReadonlyArray<ReturnType<typeof projectGatewaySummary>>,
  jobs: JobsTotals,
): {
  gateways: { total: number; ready: number; unreachable: number };
  customersMounted: number;
  inFlight: { mounting: number; unmounting: number; total: number };
  staleJobs: number;
  pendingPlacements: number;
  fleetCost: { monthlyUsd: number; byTier: Record<string, { count: number; subtotalUsd: number }> };
} {
  let ready = 0, unreachable = 0, customersMounted = 0, fleetMonthlyUsd = 0;
  const byTier: Record<string, { count: number; subtotalUsd: number }> = {};
  for (const g of gateways) {
    if (g.status === "ready") ready++;
    if (g.status === "unreachable") unreachable++;
    customersMounted += g.mountedCustomers.length;
    fleetMonthlyUsd += g.sizing.monthlyCostUsd.compute;
    const entry = byTier[g.sizing.tier] ?? { count: 0, subtotalUsd: 0 };
    entry.count += 1;
    entry.subtotalUsd += g.sizing.monthlyCostUsd.compute;
    byTier[g.sizing.tier] = entry;
  }
  return {
    gateways: { total: gateways.length, ready, unreachable },
    customersMounted,
    inFlight: { mounting: jobs.mounting, unmounting: 0, total: jobs.mounting },
    staleJobs: jobs.staleJobs,
    pendingPlacements: jobs.pending,
    fleetCost: { monthlyUsd: fleetMonthlyUsd, byTier },
  };
}

const JOB_TTL_MS = 10 * 60_000;
const ERR_GATEWAY_NOT_FOUND = "gateway not found";
const GATEWAY_IMAGE_REPO_PREFIX =
  "us-central1-docker.pkg.dev/octogee/octogee/";
const RESTORE_JOB_STATES = [
  "pending",
  "dispatched",
  "running",
  "done",
  "failed",
  "unknown",
] as const;
type RestoreJobStateLabel = (typeof RESTORE_JOB_STATES)[number];
const BUILDS_SERVICE_ALLOWLIST = new Set([
  "octogee-gateway",
  "gateway-edge",
]);

const OP_KINDS = new Set([
  "add-gateway",
  "migrate-customer",
  "retire-gateway",
  "restart-gateway",
  "rollout",
  "deprovision-customer",
]);
const OP_STATUSES = new Set([
  "pending",
  "running",
  "succeeded",
  "failed",
  "rolled-back",
]);

interface StripeRefs {
  customerId: string | null;
  subscriptionId: string | null;
  subscriptionStatus: string | null;
}

interface DrawerMountedCustomer {
  uid: string;
  slug: string;
  username: string;
  email: string;
  throttleLevel: number;
  lastActive: string | null;
}

interface DrawerOperation {
  id: string;
  kind: string;
  status: string;
  createdBy: string;
  createdAt: number | null;
  startedAt: number | null;
  completedAt: number | null;
  input: Record<string, unknown>;
  steps: unknown[];
  error?: string;
  rolledBack?: boolean;
}

interface NewOperationInput {
  kind:
    | "add-gateway"
    | "migrate-customer"
    | "retire-gateway"
    | "restart-gateway"
    | "rollout"
    | "deprovision-customer";
  createdBy: string;
  input: Record<string, unknown>;
}

interface CustomerLookupDoc {
  id: string;
  data: () =>
    | { provisioning?: { openclaw?: { gatewayId?: string } } }
    | undefined;
}

function asStringOrNull(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

function coerceNumberOrNull(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function toMillis(v: unknown): number | null {
  if (v == null) return null;
  const t = v as { toDate?: () => Date };
  if (typeof t?.toDate === "function") return t.toDate().getTime();
  if (v instanceof Date) return v.getTime();
  if (typeof v === "number") return v;
  return null;
}

function toIso(v: unknown): string | null {
  const ms = toMillis(v);
  return ms == null ? null : new Date(ms).toISOString();
}

function ageMsOrNull(ms: number | null, now: number): number | null {
  return ms == null ? null : now - ms;
}

function isValidGatewayImageRepository(repo: string): boolean {
  return repo.startsWith(GATEWAY_IMAGE_REPO_PREFIX);
}

interface RolloutBodyError {
  status: number;
  body: Record<string, unknown>;
}

interface RolloutBodyOk {
  imageTag: string;
  imageRepository: string | null;
  profile?: GatewayProfile;
}

export function validateRolloutBody(
  body: Partial<{ imageTag: string; imageRepository: string; profile: string }>,
): { error: RolloutBodyError } | { ok: RolloutBodyOk } {
  if (!body.imageTag || typeof body.imageTag !== "string") {
    return { error: { status: 400, body: { error: "missing imageTag" } } };
  }
  if (!IMAGE_TAG_PATTERN.test(body.imageTag)) {
    return {
      error: {
        status: 400,
        body: {
          error:
            "imageTag must be a lowercase hex SHA (7–40 chars) or pinned bundle (e.g. abc1234-oc2026.5.2)",
          got: body.imageTag,
        },
      },
    };
  }
  if (
    body.imageRepository != null &&
    (typeof body.imageRepository !== "string" ||
      !isValidGatewayImageRepository(body.imageRepository))
  ) {
    return {
      error: {
        status: 400,
        body: {
          error:
            "imageRepository must be the canonical Octogee Artifact Registry repo",
          expectedPrefix: GATEWAY_IMAGE_REPO_PREFIX,
          got: body.imageRepository,
        },
      },
    };
  }
  if (
    body.profile != null &&
    (typeof body.profile !== "string" ||
      !(GATEWAY_PROFILES as readonly string[]).includes(body.profile))
  ) {
    return {
      error: {
        status: 400,
        body: {
          error: `profile must be one of: ${GATEWAY_PROFILES.join(", ")}`,
          got: body.profile,
        },
      },
    };
  }
  return {
    ok: {
      imageTag: body.imageTag,
      imageRepository: body.imageRepository ?? null,
      ...(body.profile != null
        ? { profile: body.profile as GatewayProfile }
        : {}),
    },
  };
}

async function findInFlightJobId(
  db: Firestore,
  gatewayId: string,
): Promise<string | null> {
  const heartbeatSnap = await db.collection("gateways").doc(gatewayId).get();
  if (!heartbeatSnap.exists) return null;
  const hbData = heartbeatSnap.data() as
    | { inFlightJobId?: unknown }
    | undefined;
  return typeof hbData?.inFlightJobId === "string" &&
    hbData.inFlightJobId.length > 0
    ? hbData.inFlightJobId
    : null;
}

function resolveCustomerSlug(
  userData: Record<string, unknown>,
  workspaceSlugsForUser: FleetRouterDeps["workspaceSlugsForUser"],
): string | null {
  const provisioning =
    (userData.provisioning as Record<string, unknown> | undefined) ?? {};
  const openclaw =
    (provisioning.openclaw as Record<string, unknown> | undefined) ?? {};
  const openclawSlug = asStringOrNull(openclaw.slug);
  return (
    openclawSlug ??
    workspaceSlugsForUser(userData as { username?: string | null })[0] ??
    null
  );
}

function resolveStripeRefs(userData: Record<string, unknown>): StripeRefs {
  const subscription =
    (userData.subscription as Record<string, unknown> | undefined) ?? {};
  const billing =
    (userData.billing as Record<string, unknown> | undefined) ?? {};
  return {
    customerId:
      asStringOrNull(userData.stripeCustomerId) ??
      asStringOrNull(billing.stripeCustomerId),
    subscriptionId:
      asStringOrNull(subscription.id) ??
      asStringOrNull(billing.subscriptionId),
    subscriptionStatus:
      asStringOrNull(subscription.status) ??
      asStringOrNull(billing.subscriptionStatus),
  };
}

interface PendingPlacement {
  uid: string;
  username: string;
  email: string;
  currentGatewayId: string | null;
  reason: "never-assigned" | "gateway-gone";
  approvedAt: string | null;
}

interface UserPlacement {
  kind: "unassigned" | "orphan" | "assigned-not-mounted" | "mounted";
  gid: string | null;
  pending: PendingPlacement | null;
}

function classifyUserPlacement(
  uid: string,
  data: Record<string, unknown>,
  gateways: Map<string, { mountedCustomers: Set<string> }>,
): UserPlacement {
  const provisioning =
    (data.provisioning as Record<string, unknown> | undefined) ?? {};
  const openclaw =
    (provisioning.openclaw as Record<string, unknown> | undefined) ?? {};
  const slug = typeof openclaw.slug === "string" ? openclaw.slug : null;
  const gid =
    typeof openclaw.gatewayId === "string" ? openclaw.gatewayId : null;
  const username = typeof data.username === "string" ? data.username : "";
  const email = typeof data.email === "string" ? data.email : "";
  const approvedAt = toIso(data.approvedAt);

  if (!gid) {
    return {
      kind: "unassigned",
      gid: null,
      pending: {
        uid,
        username,
        email,
        currentGatewayId: null,
        reason: "never-assigned",
        approvedAt,
      },
    };
  }
  const gw = gateways.get(gid);
  if (!gw) {
    return {
      kind: "orphan",
      gid,
      pending: {
        uid,
        username,
        email,
        currentGatewayId: gid,
        reason: "gateway-gone",
        approvedAt,
      },
    };
  }
  return {
    kind: slug && gw.mountedCustomers.has(slug) ? "mounted" : "assigned-not-mounted",
    gid,
    pending: null,
  };
}

function readMountedSlugs(
  hbData: Record<string, unknown> | undefined,
): Set<string> {
  if (!Array.isArray(hbData?.mountedCustomers)) return new Set();
  return new Set(
    (hbData.mountedCustomers as unknown[]).filter(
      (s): s is string => typeof s === "string",
    ),
  );
}

function buildMountedCustomer(
  uid: string,
  data: Record<string, unknown>,
  slug: string,
): DrawerMountedCustomer {
  return {
    uid,
    slug,
    username: typeof data.username === "string" ? data.username : "",
    email: typeof data.email === "string" ? data.email : "",
    throttleLevel:
      typeof data.throttleLevel === "number" ? data.throttleLevel : 0,
    lastActive: toIso(data.lastActive),
  };
}

function userSlug(data: Record<string, unknown>): string {
  const provisioning =
    (data.provisioning as Record<string, unknown> | undefined) ?? {};
  const openclaw =
    (provisioning.openclaw as Record<string, unknown> | undefined) ?? {};
  return typeof openclaw.slug === "string" ? openclaw.slug : "";
}

function shapeDrawerOperation(
  id: string,
  data: Record<string, unknown>,
): DrawerOperation {
  const kind =
    typeof data.kind === "string" && OP_KINDS.has(data.kind)
      ? data.kind
      : "unknown";
  const status =
    typeof data.status === "string" && OP_STATUSES.has(data.status)
      ? data.status
      : "unknown";
  const out: DrawerOperation = {
    id,
    kind,
    status,
    createdBy:
      typeof data.createdBy === "string" ? data.createdBy : "unknown",
    createdAt: coerceNumberOrNull(data.createdAt),
    startedAt: coerceNumberOrNull(data.startedAt),
    completedAt: coerceNumberOrNull(data.completedAt),
    input:
      typeof data.input === "object" && data.input !== null
        ? (data.input as Record<string, unknown>)
        : {},
    steps: Array.isArray(data.steps) ? data.steps : [],
  };
  if (typeof data.error === "string") out.error = data.error;
  if (typeof data.rolledBack === "boolean") out.rolledBack = data.rolledBack;
  return out;
}

function serializeCustomerLookup(doc: CustomerLookupDoc): {
  uid: string;
  currentGatewayId: string | null;
} {
  const data = doc.data();
  const currentGatewayId =
    data?.provisioning?.openclaw?.gatewayId ?? null;
  return { uid: doc.id, currentGatewayId };
}

async function createOperation(
  db: Firestore,
  opts: NewOperationInput,
): Promise<string> {
  const gatewayId =
    typeof opts.input.gatewayId === "string" ? opts.input.gatewayId : null;
  const inputUid =
    typeof opts.input.uid === "string" ? opts.input.uid : null;
  const ref = await db.collection(GLM_OPERATIONS_COLLECTION).add({
    kind: opts.kind,
    status: "pending",
    createdBy: opts.createdBy,
    createdAt: Date.now(),
    startedAt: null,
    completedAt: null,
    input: opts.input,
    steps: [],
    ...(gatewayId !== null ? { gatewayId } : {}),
    ...(inputUid !== null ? { inputUid } : {}),
  });
  return ref.id;
}

// eslint-disable-next-line max-lines-per-function -- factory mounts ~15 admin routes; splitting it would scatter the contract across files for no readability gain
export function addAdminFleetRoutes(
  router: Router,
  deps: FleetRouterDeps,
): Router {
  const { db, logger } = deps;

router.post(
    "/customer/:uid/delete",
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const uid = req.params.uid as string;
        const userRef = db.collection("users").doc(uid);
        const userSnap = await userRef.get();
        if (!userSnap.exists) {
          res.status(404).json({ error: "User not found", uid });
          return;
        }
        const userData = userSnap.data() ?? {};

        const stripe = resolveStripeRefs(userData);
        if (stripe.customerId || stripe.subscriptionId) {
          logger.warn(
            `[admin-delete] ⚠️  STRIPE NOT CANCELLED — manual cancellation required. ` +
              `uid=${uid} email=${userData.email ?? "?"} stripeCustomerId=${stripe.customerId ?? "?"} ` +
              `subscriptionId=${stripe.subscriptionId ?? "?"} status=${stripe.subscriptionStatus ?? "?"}`,
          );
        }

        const slug = resolveCustomerSlug(userData, deps.workspaceSlugsForUser);

        if (!slug) {
          await deps.deleteAuthUserTolerantOfMissing(uid);
          await userRef.delete();
          logger.info(`[admin-delete] inline lite-delete uid=${uid}`);
          res.json({ status: "deleted-inline", uid });
          return;
        }

        const inFlight = await db
          .collection(GLM_OPERATIONS_COLLECTION)
          .where("kind", "==", "deprovision-customer")
          .where("inputUid", "==", uid)
          .where("status", "in", ["pending", "running"])
          .get();
        const conflict = inFlight.docs[0] ?? null;
        if (conflict) {
          res.status(409).json({
            error: "Cleanup already in progress",
            operationId: conflict.id,
          });
          return;
        }

        const actor = req as ActorRequest;
        const operationId = await createOperation(db, {
          kind: "deprovision-customer",
          createdBy: actor.uid ?? "unknown",
          input: { uid, slug },
        });
        logger.info(
          `[admin-delete] queued deprovision-customer op=${operationId} uid=${uid} slug=${slug}`,
        );
        res.status(202).json({ status: "queued", operationId, slug });
      } catch (e) {
        next(e);
      }
    },
  );

router.get(
    "/gateways",
    async (_req: Request, res: Response, next: NextFunction) => {
      try {
        const [gwSnap, jobsSnap, glmSnap] = await Promise.all([
          db.collection("gateways").get(),
          db
            .collection("restoreJobs")
            .where("state", "in", ["pending", "dispatched", "running"])
            .get(),
          db.collection(GLM_GATEWAYS_COLLECTION).get(),
        ]);
        const glmByGatewayId = indexGlmDocs(glmSnap.docs);
        const now = Date.now();
        const { jobsByGateway, mounting, staleJobs, pending } = aggregateJobs(jobsSnap.docs, now);
        const gateways = gwSnap.docs.map((doc) =>
          projectGatewaySummary(doc, jobsByGateway.get(doc.id) ?? [], glmByGatewayId.get(doc.id), now),
        );
        res.json({
          gateways,
          stats: rollupFleetStats(gateways, { mounting, staleJobs, pending }),
          generatedAt: new Date().toISOString(),
        });
      } catch (e) {
        next(e);
      }
    },
  );

router.get(
    "/customer-distribution",
    async (_req: Request, res: Response, next: NextFunction) => {
      try {
        const [gwSnap, usersSnap] = await Promise.all([
          db.collection("gateways").get(),
          db.collection("users").where("approved", "==", true).get(),
        ]);

        const gateways = new Map<
          string,
          {
            status: string;
            mountedCustomers: Set<string>;
            mountedCount: number;
          }
        >();
        for (const doc of gwSnap.docs) {
          const data = doc.data() as
            | { status?: string; mountedCustomers?: unknown }
            | undefined;
          const mounted = Array.isArray(data?.mountedCustomers)
            ? (data!.mountedCustomers as unknown[]).filter(
                (s): s is string => typeof s === "string",
              )
            : [];
          gateways.set(doc.id, {
            status: typeof data?.status === "string" ? data.status : "unknown",
            mountedCustomers: new Set(mounted),
            mountedCount: mounted.length,
          });
        }

        const assignedByGateway = new Map<string, number>();
        const mountedByGateway = new Map<string, number>();
        const pendingPlacements: PendingPlacement[] = [];
        let totalApproved = 0;
        let assigned = 0;
        let unassigned = 0;
        let mounted = 0;

        for (const doc of usersSnap.docs) {
          totalApproved++;
          const placement = classifyUserPlacement(
            doc.id,
            doc.data() as Record<string, unknown>,
            gateways,
          );
          if (placement.pending) pendingPlacements.push(placement.pending);
          if (placement.kind === "unassigned") {
            unassigned++;
          } else if (placement.kind !== "orphan" && placement.gid) {
            assigned++;
            assignedByGateway.set(
              placement.gid,
              (assignedByGateway.get(placement.gid) ?? 0) + 1,
            );
            if (placement.kind === "mounted") {
              mounted++;
              mountedByGateway.set(
                placement.gid,
                (mountedByGateway.get(placement.gid) ?? 0) + 1,
              );
            }
          }
        }

        const perGateway = Array.from(gateways.entries()).map(
          ([gatewayId, gw]) => ({
            gatewayId,
            status: gw.status,
            assignedCount: assignedByGateway.get(gatewayId) ?? 0,
            mountedCount: mountedByGateway.get(gatewayId) ?? 0,
          }),
        );

        res.json({
          stats: {
            totalApproved,
            assigned,
            unassigned,
            mounted,
            assignedNotMounted: assigned - mounted,
          },
          perGateway,
          pendingPlacements,
          generatedAt: new Date().toISOString(),
        });
      } catch (e) {
        next(e);
      }
    },
  );

router.get(
    "/gateways/:id/details",
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const id = req.params.id as string;
        const [glmSnap, hbSnap, usersSnap, opsSnap] = await Promise.all([
          db.collection(GLM_GATEWAYS_COLLECTION).doc(id).get(),
          db.collection("gateways").doc(id).get(),
          db.collection("users").where("approved", "==", true).get(),
          db
            .collection(GLM_OPERATIONS_COLLECTION)
            .where("gatewayId", "==", id)
            .limit(50)
            .get(),
        ]);
        if (!glmSnap.exists && !hbSnap.exists) {
          res
            .status(404)
            .json({ error: ERR_GATEWAY_NOT_FOUND, gatewayId: id });
          return;
        }
        const hbData = hbSnap.exists
          ? (hbSnap.data() as Record<string, unknown>)
          : undefined;
        const mountedSlugs = readMountedSlugs(hbData);

        const mountedCustomers: DrawerMountedCustomer[] = [];
        for (const doc of usersSnap.docs) {
          const data = doc.data() as Record<string, unknown>;
          const slug = userSlug(data);
          if (!slug || !mountedSlugs.has(slug)) continue;
          mountedCustomers.push(buildMountedCustomer(doc.id, data, slug));
        }
        mountedCustomers.sort((a, b) => a.slug.localeCompare(b.slug));

        const recentOperations = opsSnap.docs
          .map((d) =>
            shapeDrawerOperation(d.id, d.data() as Record<string, unknown>),
          )
          .sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))
          .slice(0, 20);

        res.json({
          mountedCustomers,
          recentOperations,
          generatedAt: new Date().toISOString(),
        });
      } catch (e) {
        next(e);
      }
    },
  );

router.post(
    "/customers/:uid/assign",
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const uid = req.params.uid as string;
        const body = req.body as Partial<{ gatewayId: string }>;
        if (!body.gatewayId || typeof body.gatewayId !== "string") {
          res.status(400).json({ error: "missing gatewayId in body" });
          return;
        }
        const userSnap = await db.collection("users").doc(uid).get();
        if (!userSnap.exists) {
          res.status(404).json({ error: "user not found", uid });
          return;
        }
        const userData = userSnap.data() as
          | {
              approved?: boolean;
              provisioning?: { openclaw?: { gatewayId?: string } };
            }
          | undefined;
        if (!userData?.approved) {
          res.status(409).json({ error: "user is not approved", uid });
          return;
        }
        const heartbeatSnap = await db
          .collection("gateways")
          .doc(body.gatewayId)
          .get();
        if (!heartbeatSnap.exists) {
          res.status(404).json({
            error: ERR_GATEWAY_NOT_FOUND,
            gatewayId: body.gatewayId,
          });
          return;
        }
        const hb = heartbeatSnap.data() as { status?: string } | undefined;
        if (hb?.status !== "ready") {
          res.status(409).json({
            error: "target gateway not ready",
            gatewayId: body.gatewayId,
            status: hb?.status ?? "unknown",
          });
          return;
        }
        const currentGid = userData.provisioning?.openclaw?.gatewayId;
        if (currentGid === body.gatewayId) {
          res.status(409).json({
            error: "user already assigned to that gateway — no-op",
            uid,
            gatewayId: body.gatewayId,
          });
          return;
        }
        await db
          .collection("users")
          .doc(uid)
          .update({ "provisioning.openclaw.gatewayId": body.gatewayId });
        res.status(202).json({ uid, gatewayId: body.gatewayId });
      } catch (e) {
        next(e);
      }
    },
  );

router.post(
    "/gateways",
    // eslint-disable-next-line complexity -- linear preflight: validate body, check uniqueness, provision GSA secret, write desired state. Each guard returns its own error response; flattening is clearer than threading.
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const body = req.body as Partial<{
          gatewayId: string;
          instanceName: string;
          imageRepository: string;
          imageTag: string;
          profile: string;
          sizingTier: string;
        }>;
        if (
          typeof body.gatewayId !== "string" || body.gatewayId.length === 0 ||
          typeof body.instanceName !== "string" || body.instanceName.length === 0 ||
          typeof body.imageRepository !== "string" || body.imageRepository.length === 0 ||
          typeof body.imageTag !== "string" || body.imageTag.length === 0
        ) {
          res.status(400).json({
            error: "missing required fields",
            required: [
              "gatewayId",
              "instanceName",
              "imageRepository",
              "imageTag",
            ],
          });
          return;
        }
        if (body.profile !== undefined && !(GATEWAY_PROFILES as readonly string[]).includes(body.profile)) {
          res.status(400).json({
            error: `profile must be one of: ${GATEWAY_PROFILES.join(", ")}`,
            got: body.profile,
          });
          return;
        }
        if (body.sizingTier !== undefined && !(SIZING_TIERS as readonly string[]).includes(body.sizingTier)) {
          res.status(400).json({
            error: `sizingTier must be one of: ${SIZING_TIERS.join(", ")}`,
            got: body.sizingTier,
          });
          return;
        }
        if (!isValidGatewayImageRepository(body.imageRepository)) {
          res.status(400).json({
            error:
              "imageRepository must be the canonical Octogee Artifact Registry repo",
            expectedPrefix: GATEWAY_IMAGE_REPO_PREFIX,
            got: body.imageRepository,
          });
          return;
        }
        const existing = await db
          .collection(GLM_GATEWAYS_COLLECTION)
          .doc(body.gatewayId)
          .get();
        if (existing.exists) {
          res.status(409).json({
            error: "gateway already exists",
            gatewayId: body.gatewayId,
          });
          return;
        }
        const collisionSnap = await db
          .collection(GLM_GATEWAYS_COLLECTION)
          .where("instanceName", "==", body.instanceName)
          .limit(1)
          .get();
        if (collisionSnap.size > 0) {
          const collidingId = collisionSnap.docs[0].id;
          res.status(409).json({
            error: "instanceName already in use",
            instanceName: body.instanceName,
            ownedBy: collidingId,
          });
          return;
        }
        const gatewayServiceAccount = process.env.GATEWAY_SERVICE_ACCOUNT;
        if (!gatewayServiceAccount) {
          res.status(500).json({
            error:
              "GATEWAY_SERVICE_ACCOUNT not configured — admin cannot provision gateway auth-token secret",
          });
          return;
        }
        try {
          await deps.provisionGatewayAuthSecret({
            gatewayId: body.gatewayId,
            gatewayServiceAccount,
          });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          res.status(502).json({
            error: "failed to provision gateway auth-token secret",
            gatewayId: body.gatewayId,
            detail: message,
          });
          return;
        }
        const actor = req as ActorRequest;
        const createdBy = actor.uid ?? "unknown";
        await db
          .collection(GLM_GATEWAYS_COLLECTION)
          .doc(body.gatewayId)
          .set({
            gatewayId: body.gatewayId,
            instanceName: body.instanceName,
            imageRepository: body.imageRepository,
            imageTag: body.imageTag,
            desiredStatus: "running",
            createdBy,
            createdAt: Date.now(),
            ...(body.profile ? { profile: body.profile as GatewayProfile } : {}),
            ...(body.sizingTier ? { sizingTier: body.sizingTier as SizingTier } : {}),
          });
        const operationId = await createOperation(db, {
          kind: "add-gateway",
          createdBy,
          input: {
            gatewayId: body.gatewayId,
            instanceName: body.instanceName,
            imageTag: body.imageTag,
          },
        });
        res
          .status(202)
          .json({ gatewayId: body.gatewayId, operationId });
      } catch (e) {
        next(e);
      }
    },
  );

  router.patch(
    "/gateways/:id",
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const id = req.params.id as string;
        const body = req.body as Partial<{
          imageTag: string;
          desiredStatus: "running" | "paused" | "draining" | "retired";
          sizingTier: string;
        }>;
        const update: Record<string, unknown> = {};
        if (typeof body.imageTag === "string" && body.imageTag.length > 0) {
          update.imageTag = body.imageTag;
        }
        if (body.desiredStatus !== undefined) {
          if (
            body.desiredStatus !== "running" &&
            body.desiredStatus !== "paused" &&
            body.desiredStatus !== "draining" &&
            body.desiredStatus !== "retired"
          ) {
            res.status(400).json({
              error:
                "desiredStatus must be one of: running, paused, draining, retired",
              got: body.desiredStatus,
            });
            return;
          }
          update.desiredStatus = body.desiredStatus;
        }
        if (body.sizingTier !== undefined) {
          if (!(SIZING_TIERS as readonly string[]).includes(body.sizingTier)) {
            res.status(400).json({
              error: `sizingTier must be one of: ${SIZING_TIERS.join(", ")}`,
              got: body.sizingTier,
            });
            return;
          }
          update.sizingTier = body.sizingTier;
        }
        if (Object.keys(update).length === 0) {
          res.status(400).json({ error: "no updatable fields provided" });
          return;
        }
        const ref = db.collection(GLM_GATEWAYS_COLLECTION).doc(id);
        const snap = await ref.get();
        if (!snap.exists) {
          res
            .status(404)
            .json({ error: ERR_GATEWAY_NOT_FOUND, gatewayId: id });
          return;
        }
        await ref.update(update);
        res
          .status(202)
          .json({ gatewayId: id, updated: Object.keys(update) });
      } catch (e) {
        next(e);
      }
    },
  );

  router.delete(
    "/gateways/:id",
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const id = req.params.id as string;
        const actor = req as ActorRequest;
        const createdBy = actor.uid ?? "unknown";
        const ref = db.collection(GLM_GATEWAYS_COLLECTION).doc(id);
        const snap = await ref.get();
        if (!snap.exists) {
          res
            .status(404)
            .json({ error: ERR_GATEWAY_NOT_FOUND, gatewayId: id });
          return;
        }
        const heartbeatSnap = await db.collection("gateways").doc(id).get();
        if (heartbeatSnap.exists) {
          const hbData = heartbeatSnap.data() as
            | { mountedCustomers?: unknown; inFlightJobId?: unknown }
            | undefined;
          const mounted = Array.isArray(hbData?.mountedCustomers)
            ? (hbData!.mountedCustomers as unknown[]).filter(
                (s): s is string => typeof s === "string",
              )
            : [];
          if (mounted.length > 0) {
            res.status(409).json({
              error:
                "gateway still has mounted customers; migrate them off before retiring",
              gatewayId: id,
              mountedCustomers: mounted,
            });
            return;
          }
          const inFlightJobId =
            typeof hbData?.inFlightJobId === "string" &&
            hbData.inFlightJobId.length > 0
              ? hbData.inFlightJobId
              : null;
          if (inFlightJobId) {
            res.status(409).json({
              error:
                "gateway has an in-flight restore job; let it finish (or fail) before retiring",
              gatewayId: id,
              inFlightJobId,
            });
            return;
          }
        }

const opRef = db.collection(GLM_OPERATIONS_COLLECTION).doc();
        const operationId = opRef.id;
        const batch = db.batch();
        batch.update(ref, { desiredStatus: "retired" });
        batch.set(opRef, {
          kind: "retire-gateway",
          status: "pending",
          createdBy,
          createdAt: Date.now(),
          startedAt: null,
          completedAt: null,
          input: { gatewayId: id },
          steps: [],
          gatewayId: id,
        });
        await batch.commit();
        res.status(202).json({ gatewayId: id, operationId });
      } catch (e) {
        next(e);
      }
    },
  );

  router.post(
    "/gateways/:id/restart",
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const id = req.params.id as string;
        const ref = db.collection(GLM_GATEWAYS_COLLECTION).doc(id);
        const snap = await ref.get();
        if (!snap.exists) {
          res
            .status(404)
            .json({ error: ERR_GATEWAY_NOT_FOUND, gatewayId: id });
          return;
        }
        const data = snap.data() as { instanceName?: string } | undefined;
        const instanceName = data?.instanceName;
        if (typeof instanceName !== "string" || instanceName.length === 0) {
          res.status(500).json({
            error: "gateway missing instanceName — corrupt glmGateways doc",
            gatewayId: id,
          });
          return;
        }

        const inFlightJobId = await findInFlightJobId(db, id);
        if (inFlightJobId) {
          res.status(409).json({
            error:
              "gateway has an in-flight restore job; let it finish before restarting",
            gatewayId: id,
            inFlightJobId,
          });
          return;
        }

        const pendingOps = await db
          .collection(GLM_OPERATIONS_COLLECTION)
          .where("status", "in", ["pending", "running"])
          .get();
        const conflicting = pendingOps.docs.find((d) => {
          const opData = d.data() as
            | { input?: { gatewayId?: string } }
            | undefined;
          return opData?.input?.gatewayId === id;
        });
        if (conflicting) {
          res.status(409).json({
            error:
              "another operation is already pending or running for this gateway",
            gatewayId: id,
            operationId: conflicting.id,
            kind:
              (conflicting.data() as { kind?: string } | undefined)?.kind ??
              null,
          });
          return;
        }

        const actor = req as ActorRequest;
        const operationId = await createOperation(db, {
          kind: "restart-gateway",
          createdBy: actor.uid ?? "unknown",
          input: { gatewayId: id, instanceName },
        });
        res.status(202).json({ gatewayId: id, operationId });
      } catch (e) {
        next(e);
      }
    },
  );

  router.post(
    "/gateways/:id/rollout",
    // eslint-disable-next-line complexity -- linear preflight after extraction (validateRolloutBody + findInFlightJobId): body validate → exists → no-op → in-flight → conflicting-op → write. Each guard's response shape is distinct.
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const id = req.params.id as string;
        const validation = validateRolloutBody(
          req.body as Partial<{
            imageTag: string;
            imageRepository: string;
            profile: string;
          }>,
        );
        if ("error" in validation) {
          res.status(validation.error.status).json(validation.error.body);
          return;
        }
        const { imageTag, imageRepository, profile } = validation.ok;

        const ref = db.collection(GLM_GATEWAYS_COLLECTION).doc(id);
        const snap = await ref.get();
        if (!snap.exists) {
          res
            .status(404)
            .json({ error: ERR_GATEWAY_NOT_FOUND, gatewayId: id });
          return;
        }
        const data = snap.data() as
          | { imageTag?: string; imageRepository?: string; profile?: string }
          | undefined;
        const targetRepo = imageRepository ?? data?.imageRepository ?? "";
        const currentProfile = data?.profile ?? "standard";
        const targetProfile = profile ?? currentProfile;
        if (
          data?.imageTag === imageTag &&
          data.imageRepository === targetRepo &&
          targetProfile === currentProfile
        ) {
          res.status(409).json({
            error: "gateway already on requested image — no-op rollout",
            gatewayId: id,
            imageTag,
            imageRepository: targetRepo,
            profile: targetProfile,
          });
          return;
        }

        const inFlightJobId = await findInFlightJobId(db, id);
        if (inFlightJobId) {
          res.status(409).json({
            error:
              "gateway has an in-flight restore job; let it finish before rolling out",
            gatewayId: id,
            inFlightJobId,
          });
          return;
        }

        const pendingOps = await db
          .collection(GLM_OPERATIONS_COLLECTION)
          .where("status", "in", ["pending", "running"])
          .get();
        const conflicting = pendingOps.docs.find((d) => {
          const opData = d.data() as
            | { input?: { gatewayId?: string } }
            | undefined;
          return opData?.input?.gatewayId === id;
        });
        if (conflicting) {
          res.status(409).json({
            error:
              "another operation is already pending or running for this gateway",
            gatewayId: id,
            operationId: conflicting.id,
            kind:
              (conflicting.data() as { kind?: string } | undefined)?.kind ??
              null,
          });
          return;
        }

        const actor = req as ActorRequest;
        const input: {
          gatewayId: string;
          imageTag: string;
          imageRepository?: string;
          profile?: GatewayProfile;
        } = { gatewayId: id, imageTag };
        if (imageRepository) input.imageRepository = imageRepository;
        if (profile) input.profile = profile;
        const operationId = await createOperation(db, {
          kind: "rollout",
          createdBy: actor.uid ?? "unknown",
          input,
        });
        res.status(202).json({ gatewayId: id, operationId });
      } catch (e) {
        next(e);
      }
    },
  );

router.get(
    "/customers/by-slug/:slug",
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const slug = req.params.slug as string;
        const slugSnap = await db
          .collection("users")
          .where("provisioning.openclaw.slug", "==", slug)
          .limit(1)
          .get();
        if (slugSnap.size > 0) {
          res.json(serializeCustomerLookup(slugSnap.docs[0]));
          return;
        }
        const usernameSnap = await db
          .collection("users")
          .where("username", "==", slug)
          .limit(1)
          .get();
        if (usernameSnap.size > 0) {
          res.json(serializeCustomerLookup(usernameSnap.docs[0]));
          return;
        }
        res.status(404).json({ error: "customer not found", slug });
      } catch (e) {
        next(e);
      }
    },
  );

  router.post(
    "/customers/:uid/migrate",
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const uid = req.params.uid as string;
        const body = req.body as Partial<{ to: string }>;
        if (typeof body.to !== "string" || body.to.length === 0) {
          res
            .status(400)
            .json({ error: "missing target gateway", required: ["to"] });
          return;
        }
        const targetSnap = await db
          .collection("gateways")
          .doc(body.to)
          .get();
        if (!targetSnap.exists) {
          res.status(404).json({
            error: "target gateway not registered",
            gatewayId: body.to,
          });
          return;
        }
        const targetStatus = (
          targetSnap.data() as Record<string, unknown> | undefined
        )?.status;
        if (targetStatus !== "ready") {
          res.status(409).json({
            error: "target gateway not ready",
            gatewayId: body.to,
            status: targetStatus ?? "unknown",
          });
          return;
        }
        const userSnap = await db.collection("users").doc(uid).get();
        const currentGatewayId = (
          userSnap.data() as
            | { provisioning?: { openclaw?: { gatewayId?: string } } }
            | undefined
        )?.provisioning?.openclaw?.gatewayId;
        if (currentGatewayId === body.to) {
          res.status(409).json({
            error: "customer is already mounted on the target gateway",
            uid,
            gatewayId: body.to,
          });
          return;
        }
        const actor = req as ActorRequest;
        const createdBy = actor.uid ?? "unknown";
        const operationId = await createOperation(db, {
          kind: "migrate-customer",
          createdBy,
          input: { uid, toGatewayId: body.to },
        });
        res.status(202).json({ operationId });
      } catch (e) {
        next(e);
      }
    },
  );

  router.post(
    "/rollouts",
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const body = req.body as Partial<{
          fromGatewayId: string;
          imageTag: string;
        }>;
        if (
          typeof body.fromGatewayId !== "string" ||
          body.fromGatewayId.length === 0 ||
          typeof body.imageTag !== "string" ||
          body.imageTag.length === 0
        ) {
          res.status(400).json({
            error: "missing required fields",
            required: ["fromGatewayId", "imageTag"],
          });
          return;
        }
        const actor = req as ActorRequest;
        const createdBy = actor.uid ?? "unknown";
        const operationId = await createOperation(db, {
          kind: "rollout",
          createdBy,
          input: {
            fromGatewayId: body.fromGatewayId,
            imageTag: body.imageTag,
          },
        });
        res.status(202).json({ operationId });
      } catch (e) {
        next(e);
      }
    },
  );

const KICKABLE_STATES = new Set(["pending", "dispatched", "running"]);
  router.post(
    "/restore-jobs/:jobId/kick",
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const jobId = req.params.jobId as string;
        const jobRef = db.collection("restoreJobs").doc(jobId);
        const actor = req as ActorRequest;
        const kickedBy = actor.uid ?? "unknown";
        const errorMsg = `operator-kicked (uid=${kickedBy} at ${new Date().toISOString()})`;

        type Outcome =
          | { ok: false; status: number; body: Record<string, unknown> }
          | {
              ok: true;
              status: 200;
              body: {
                jobId: string;
                gatewayId: string;
                slug: string;
                kickedBy: string;
                kickedAt: string;
              };
            };

        const outcome = await db.runTransaction(async (txn) => {
          
          const jobSnap = await txn.get(jobRef);
          if (!jobSnap.exists) {
            return {
              ok: false,
              status: 404,
              body: { error: "restore job not found", jobId },
            } satisfies Outcome;
          }
          const data = jobSnap.data() as Record<string, unknown>;
          const state = typeof data.state === "string" ? data.state : null;
          if (!state || !KICKABLE_STATES.has(state)) {
            return {
              ok: false,
              status: 409,
              body: {
                error: `restore job state=${state ?? "missing"} is not kickable; allowed=[${[...KICKABLE_STATES].join(", ")}]`,
                jobId,
                state,
              },
            } satisfies Outcome;
          }
          const gatewayId =
            typeof data.gatewayId === "string" ? data.gatewayId : "";
          const snapshot = (data.snapshot ?? {}) as { slug?: unknown };
          const slug =
            typeof snapshot.slug === "string" ? snapshot.slug : "";

let shouldClearGwLock = false;
          const gwRef = gatewayId
            ? db.collection("gateways").doc(gatewayId)
            : null;
          if (gwRef) {
            const gwSnap = await txn.get(gwRef);
            if (gwSnap.exists) {
              const gwData = gwSnap.data() as
                | { inFlightJobId?: unknown }
                | undefined;
              if (gwData?.inFlightJobId === jobId) {
                shouldClearGwLock = true;
              }
            }
          }

txn.update(jobRef, {
            state: "failed",
            completedAt: FieldValue.serverTimestamp(),
            error: errorMsg,
          });
          if (gwRef && shouldClearGwLock) {
            txn.update(gwRef, { inFlightJobId: null });
          }

          return {
            ok: true,
            status: 200,
            body: {
              jobId,
              gatewayId,
              slug,
              kickedBy,
              kickedAt: new Date().toISOString(),
            },
          } satisfies Outcome;
        });

        res.status(outcome.status).json(outcome.body);
      } catch (e) {
        next(e);
      }
    },
  );

router.get(
    "/restore-jobs",
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const parsedLimit = parseInt(
          (req.query.limit as string) ?? "50",
          10,
        );
        const limit = Math.min(
          200,
          Math.max(1, Number.isFinite(parsedLimit) ? parsedLimit : 50),
        );
        const snap = await db
          .collection("restoreJobs")
          .orderBy("createdAt", "desc")
          .limit(limit)
          .get();
        const normalizeState = (raw: unknown): RestoreJobStateLabel => {
          if (
            typeof raw === "string" &&
            (RESTORE_JOB_STATES as readonly string[]).includes(raw)
          ) {
            return raw as RestoreJobStateLabel;
          }
          logger.warn(
            "restoreJobs row has malformed state — surfacing as 'unknown'",
            { raw },
          );
          return "unknown";
        };
        const jobs = snap.docs.map((doc) => {
          const data = doc.data() as Record<string, unknown>;
          const snapshot = (data.snapshot ?? {}) as {
            uid?: string;
            slug?: string;
          };
          return {
            jobId: typeof data.jobId === "string" ? data.jobId : doc.id,
            gatewayId:
              typeof data.gatewayId === "string" ? data.gatewayId : "",
            uid: typeof snapshot.uid === "string" ? snapshot.uid : "",
            slug: typeof snapshot.slug === "string" ? snapshot.slug : "",
            state: normalizeState(data.state),
            attempt:
              typeof data.attempt === "number" &&
              Number.isFinite(data.attempt) &&
              data.attempt >= 1
                ? data.attempt
                : 1,
            createdAt: toIso(data.createdAt),
            dispatchedAt: toIso(data.dispatchedAt),
            completedAt: toIso(data.completedAt),
            error: typeof data.error === "string" ? data.error : null,
          };
        });
        res.json({ jobs, generatedAt: new Date().toISOString() });
      } catch (e) {
        next(e);
      }
    },
  );

router.get(
    "/builds",
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const service = (req.query.service as string) || "octogee-gateway";
        if (!BUILDS_SERVICE_ALLOWLIST.has(service)) {
          res.status(400).json({
            error:
              "service must be one of the canonical Octogee gateway-pod images",
            allowed: [...BUILDS_SERVICE_ALLOWLIST],
            got: service,
          });
          return;
        }
        const parsedLimit = parseInt(
          (req.query.limit as string) ?? "30",
          10,
        );
        const limit = Math.min(
          100,
          Math.max(1, Number.isFinite(parsedLimit) ? parsedLimit : 30),
        );
        try {
          const builds = await deps.listGatewayBuilds({ service, limit });
          res.json({
            service,
            builds,
            generatedAt: new Date().toISOString(),
          });
        } catch (e) {
          logger.warn("artifact-registry list failed", {
            service,
            error: (e as Error)?.message,
          });
          res.status(502).json({
            error: (e as Error)?.message ?? "artifact-registry list failed",
            service,
          });
        }
      } catch (e) {
        next(e);
      }
    },
  );

router.get(
    "/operations",
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const limit = Math.min(
          100,
          Math.max(1, parseInt((req.query.limit as string) ?? "25", 10)),
        );
        const snap = await db
          .collection(GLM_OPERATIONS_COLLECTION)
          .orderBy("createdAt", "desc")
          .limit(limit)
          .get();
        const operations = snap.docs.map((doc) => ({
          id: doc.id,
          ...doc.data(),
        }));
        res.json({ operations, generatedAt: new Date().toISOString() });
      } catch (e) {
        next(e);
      }
    },
  );

  return router;
}
