/**
 * Admin Fleet Router — shared Express factory for admin/fleet endpoints.
 *
 * Mounted by both workspace-api (today) and glm-controller (post-#PR), so
 * the admin Gateways tab keeps responding even when no gateway pods are
 * booted. Dependencies are injected; this file imports nothing from
 * either consumer.
 *
 * Spec: docs/architecture/GATEWAY-PLATFORM-SPEC.md §Gateway Lifecycle Manager.
 */
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
} from "../../shared/types/glm.js";

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
  /** Inline lite-delete path. Must tolerate `auth/user-not-found`. */
  deleteAuthUserTolerantOfMissing: (uid: string) => Promise<void>;
}

/** Fields workspace-api / glm-controller auth middleware put on req. */
type ActorRequest = Request & {
  uid?: string;
  user?: { email?: string | null };
};

const JOB_TTL_MS = 10 * 60_000;
const ERR_GATEWAY_NOT_FOUND = "gateway not found";
const GATEWAY_IMAGE_REPO_PREFIX =
  "us-central1-docker.pkg.dev/octogee/octogee/";
const IMAGE_TAG_PATTERN =
  /^[a-f0-9]{7,40}(-oc\d{4}\.\d+\.\d+(-\d+)?)?$/;
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
  "octogee-chat-proxy",
  "workspace-api",
]);

const OP_KINDS = new Set([
  "add-gateway",
  "migrate-customer",
  "retire-gateway",
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
}

export function validateRolloutBody(
  body: Partial<{ imageTag: string; imageRepository: string }>,
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
  return {
    ok: {
      imageTag: body.imageTag,
      imageRepository: body.imageRepository ?? null,
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

/**
 * Mounts every admin /fleet/customer-lifecycle endpoint onto the supplied
 * router. The caller is responsible for `requireAdmin` — this factory is
 * deliberately middleware-agnostic so workspace-api and glm-controller
 * can each apply their own.
 *
 * Routing reality (Phase 1, this PR):
 *   - Fleet status reads + add/retire/rollout are routed to glm-controller
 *     by the umbrella Ingress so they survive a missing gateway pod.
 *   - Customer-lifecycle writes (`/customer/:uid/delete`,
 *     `/customers/:uid/{assign,migrate}`) are mounted here so glm-controller
 *     can serve them, but the Ingress still routes them to workspace-api
 *     today (GCE path matching can't disambiguate `/customer/:uid/delete`
 *     from `/customer/:uid` without a wildcard segment). The mount is
 *     forward-compat for the next ingress reshuffle once we collapse the
 *     remaining customer-detail routes onto Cowboy.
 *   - `/customers/by-slug/:slug` is unambiguous and routed to
 *     glm-controller in the umbrella Ingress.
 */
// eslint-disable-next-line max-lines-per-function -- factory mounts ~15 admin routes; splitting it would scatter the contract across files for no readability gain
export function addAdminFleetRoutes(
  router: Router,
  deps: FleetRouterDeps,
): Router {
  const { db, logger } = deps;

  // ── Admin delete customer ─────────────────────────────────────────────
  // Spec: docs/specs/ADMIN-DELETE-CUSTOMER-SPEC.md.
  router.post(
    "/customer/:uid/delete",
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const uid = req.params.uid;
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

  // ── Fleet Controller — list every gateway + restore-job aggregate ────
  router.get(
    "/gateways",
    async (_req: Request, res: Response, next: NextFunction) => {
      try {
        const [gwSnap, jobsSnap] = await Promise.all([
          db.collection("gateways").get(),
          db
            .collection("restoreJobs")
            .where("state", "in", ["pending", "dispatched", "running"])
            .get(),
        ]);

        const now = Date.now();
        const jobsByGateway = new Map<
          string,
          Array<{ id: string; data: Record<string, unknown> }>
        >();
        let mounting = 0;
        let staleJobs = 0;
        let pending = 0;

        for (const doc of jobsSnap.docs) {
          const data = doc.data() as Record<string, unknown>;
          const gid = typeof data.gatewayId === "string" ? data.gatewayId : "";
          const arr = jobsByGateway.get(gid) ?? [];
          arr.push({ id: doc.id, data });
          jobsByGateway.set(gid, arr);

          const state = data.state;
          if (state === "pending") pending++;
          if (state === "dispatched" || state === "running") {
            const ageMs =
              toMillis(data.dispatchedAt) ?? toMillis(data.createdAt);
            const isStale = ageMs != null && now - ageMs > JOB_TTL_MS;
            if (isStale) staleJobs++;
            else mounting++;
          }
        }

        const gateways = gwSnap.docs.map((doc) => {
          const data = doc.data() as Record<string, unknown>;
          const heartbeatAgeMs = ageMsOrNull(toMillis(data.lastHeartbeatAt), now);
          const uptimeMs = ageMsOrNull(toMillis(data.startedAt), now);
          const inFlightJobId =
            typeof data.inFlightJobId === "string" ? data.inFlightJobId : null;
          const ownJobs = jobsByGateway.get(doc.id) ?? [];
          const inFlightRaw = inFlightJobId
            ? ownJobs.find((j) => j.id === inFlightJobId)
            : null;
          const inFlightJob = inFlightRaw
            ? {
                jobId: inFlightRaw.id,
                slug: inFlightRaw.data.slug,
                state: inFlightRaw.data.state,
                ageMs: (() => {
                  const dispatchedMs =
                    toMillis(inFlightRaw.data.dispatchedAt) ??
                    toMillis(inFlightRaw.data.createdAt);
                  return dispatchedMs == null ? 0 : now - dispatchedMs;
                })(),
              }
            : null;
          const lastErrorRaw = data.lastError as
            | {
                jobId?: string;
                slug?: string;
                message?: string;
                at?: unknown;
              }
            | undefined;
          const lastError = lastErrorRaw
            ? {
                jobId: lastErrorRaw.jobId,
                slug: lastErrorRaw.slug,
                message: lastErrorRaw.message,
                at: toIso(lastErrorRaw.at),
              }
            : null;
          return {
            gatewayId:
              typeof data.gatewayId === "string" ? data.gatewayId : doc.id,
            status: typeof data.status === "string" ? data.status : "unknown",
            imageTag: typeof data.version === "string" ? data.version : null,
            openclawVersion:
              typeof data.openclawVersion === "string"
                ? data.openclawVersion
                : null,
            mountedCustomers: Array.isArray(data.mountedCustomers)
              ? data.mountedCustomers
              : [],
            lastHeartbeatAt: toIso(data.lastHeartbeatAt),
            heartbeatAgeMs,
            startedAt: toIso(data.startedAt),
            uptimeMs,
            inFlightJobId,
            inFlightJob,
            lastError,
          };
        });

        let ready = 0;
        let unreachable = 0;
        let customersMounted = 0;
        for (const g of gateways) {
          if (g.status === "ready") ready++;
          if (g.status === "unreachable") unreachable++;
          customersMounted += g.mountedCustomers.length;
        }

        res.json({
          gateways,
          stats: {
            gateways: { total: gateways.length, ready, unreachable },
            customersMounted,
            inFlight: { mounting, unmounting: 0, total: mounting },
            staleJobs,
            pendingPlacements: pending,
          },
          generatedAt: new Date().toISOString(),
        });
      } catch (e) {
        next(e);
      }
    },
  );

  // ── Customer distribution + placement ────────────────────────────────
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

  // ── Gateway drawer details ────────────────────────────────────────────
  router.get(
    "/gateways/:id/details",
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const id = req.params.id;
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

  // ── Assign a customer to a gateway ────────────────────────────────────
  router.post(
    "/customers/:uid/assign",
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const uid = req.params.uid;
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

  // ── GLM API: gateway create / patch / retire / rollout ───────────────
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
        const id = req.params.id;
        const body = req.body as Partial<{
          imageTag: string;
          desiredStatus: "running" | "draining" | "retired";
        }>;
        const update: Record<string, unknown> = {};
        if (typeof body.imageTag === "string" && body.imageTag.length > 0) {
          update.imageTag = body.imageTag;
        }
        if (body.desiredStatus !== undefined) {
          if (
            body.desiredStatus !== "running" &&
            body.desiredStatus !== "draining" &&
            body.desiredStatus !== "retired"
          ) {
            res.status(400).json({
              error:
                "desiredStatus must be one of: running, draining, retired",
              got: body.desiredStatus,
            });
            return;
          }
          update.desiredStatus = body.desiredStatus;
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
        const id = req.params.id;
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
        // Atomic: bind `desiredStatus=retired` and the retire-gateway
        // operation creation into one batch so a partial failure can't
        // leave the gateway in "draining-with-no-op" purgatory. Either
        // both writes land or neither does.
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
    "/gateways/:id/rollout",
    // eslint-disable-next-line complexity -- linear preflight after extraction (validateRolloutBody + findInFlightJobId): body validate → exists → no-op → in-flight → conflicting-op → write. Each guard's response shape is distinct.
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const id = req.params.id;
        const validation = validateRolloutBody(
          req.body as Partial<{ imageTag: string; imageRepository: string }>,
        );
        if ("error" in validation) {
          res.status(validation.error.status).json(validation.error.body);
          return;
        }
        const { imageTag, imageRepository } = validation.ok;

        const ref = db.collection(GLM_GATEWAYS_COLLECTION).doc(id);
        const snap = await ref.get();
        if (!snap.exists) {
          res
            .status(404)
            .json({ error: ERR_GATEWAY_NOT_FOUND, gatewayId: id });
          return;
        }
        const data = snap.data() as
          | { imageTag?: string; imageRepository?: string }
          | undefined;
        const targetRepo = imageRepository ?? data?.imageRepository ?? "";
        if (
          data?.imageTag === imageTag &&
          data.imageRepository === targetRepo
        ) {
          res.status(409).json({
            error: "gateway already on requested image — no-op rollout",
            gatewayId: id,
            imageTag,
            imageRepository: targetRepo,
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
        } = { gatewayId: id, imageTag };
        if (imageRepository) input.imageRepository = imageRepository;
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

  // ── Customer lookup + migration ───────────────────────────────────────
  router.get(
    "/customers/by-slug/:slug",
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const slug = req.params.slug;
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
        const uid = req.params.uid;
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

  // ── Kick a stuck restore job ──────────────────────────────────────────
  // Operator escape hatch for the rare case a customer sits in
  // "Dispatched" / "running" forever (e.g. gateway crashed mid-restore,
  // or — pre-PR #870 — Cloud Task delivered before app.listen()).
  // Marks the job as failed with `operator-kicked` and clears the
  // gateway's inFlightJobId so the controller's next reconcile tick
  // can claim a fresh job for the same customer.
  //
  // Transactional read-check-update: a concurrent gateway ack or
  // controller reconcile could flip the job to `done` or replace
  // `inFlightJobId` between our read and write; without a txn we'd
  // either overwrite a terminal state or stomp a fresh assignment.
  // Allowlist (not denylist) on state: any future state we don't
  // explicitly permit is rejected, so we never silently kick a job
  // we don't understand (e.g. "migrating", "quiescing").
  const KICKABLE_STATES = new Set(["pending", "dispatched", "running"]);
  router.post(
    "/restore-jobs/:jobId/kick",
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const jobId = req.params.jobId;
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
          // ── READS (must precede all writes per Firestore rules) ──
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

          // Read the gateway lock (if any) so we can decide-before-write
          // whether to clear it. Still inside the same txn, so a
          // concurrent reconcile can't sneak a fresh inFlightJobId
          // between our read and our write.
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

          // ── WRITES ──
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

  // ── Restore-job log ───────────────────────────────────────────────────
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

  // ── Builds (Artifact Registry) ───────────────────────────────────────
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

  // ── Operations log ────────────────────────────────────────────────────
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
