

import {
  Router,
  type Request,
  type Response,
  type NextFunction,
} from "express";
import { type Firestore } from "firebase-admin/firestore";
import {
  GLM_GATEWAYS_COLLECTION,
  GLM_OPERATIONS_COLLECTION,
  GATEWAY_CLASSES,
  GATEWAY_IMAGE_PROFILES,
  GATEWAY_ID_REQUIREMENT,
  GATEWAY_PROFILES,
  OPERATOR_GATEWAY_RESERVATIONS_COLLECTION,
  defaultOperatorGatewayAccess,
  resolveUserGatewayShellState,
  OPERATOR_GATEWAY_LOCKED_SERVICE_ACCOUNT,
  isValidGatewayId,
  isGatewayClass,
  isGatewayProfile,
  operatorGatewayServiceAccountName,
  resolveGatewayClass,
  resolveGatewayImageProfile,
  resolveGatewayPersistence,
  type GatewayClass,
  type GatewayImageProfile,
  type GatewayProfile,
  type OperatorGatewayReservationSpec,
  type OperatorGatewayReservationRequest,
} from "@octogee/shared/types/glm";
import {
  SIZING_TIERS,
  isSizingTier,
  resolveSizingTier,
  type SizingTier,
} from "@octogee/shared/types/sizing";
import {
  SPOT_PRICE_MULTIPLIER,
  estimateGatewayMonthlyCost,
  type GatewayPricingMode,
} from "@octogee/shared/types/cost-estimator";
import { GATEWAY_UNREACHABLE_AFTER_MS } from "@octogee/shared/types/fleet-controller";
import { IMAGE_TAG_PATTERN } from "./image-tag.js";
import {
  findPendingActivationOperation,
  requestBuilderActivationLease,
} from "./builder-activation-lease.js";

export { resolveBuilderActivationPlan } from "./builder-activation-lease.js";

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
  reservation: ReturnType<typeof projectGatewayReservation>,
): {
  tier: SizingTier;
  resolvedFrom: "explicit" | "class-default" | "profile-default";
  resources: { requests: { cpu: string; memory: string }; limits: { cpu: string; memory: string } };
  capacity: { targetActiveBuilders: number; typicalBuilders: number };
  monthlyCostUsd: {
    compute: number;
    onDemandCompute: number;
    savings: number;
    pricingMode: GatewayPricingMode;
    perBuilderAtTarget: number;
    perBuilderAtTypical: number;
  };
} {
  const sizingTier =
    typeof glmDoc?.sizingTier === "string" && (SIZING_TIERS as readonly string[]).includes(glmDoc.sizingTier)
      ? (glmDoc.sizingTier as SizingTier)
      : undefined;
  const profile = isGatewayProfile(glmDoc?.profile) ? glmDoc.profile : undefined;
  const gatewayClass = resolveGatewayClass({
    gatewayClass: isGatewayClass(glmDoc?.gatewayClass) ? glmDoc.gatewayClass : undefined,
    profile,
    imageProfile: isGatewayProfile(glmDoc?.imageProfile) ? glmDoc.imageProfile : undefined,
  });
  const resolved = resolveSizingTier({ sizingTier, gatewayClass, profile });
  // Paused pods are scaled to 0 replicas → no node consumption → no compute
  // bill. Reflect that in both the per-gateway surface and the fleet roll-up
  // so the operator sees real cost, not nameplate.
  const isPaused = glmDoc?.desiredStatus === "paused";
  const cost = isPaused
    ? {
        computeUsd: 0,
        onDemandComputeUsd: 0,
        savingsUsd: 0,
        pricingMode: reservation.type,
        perBuilderAtTarget: 0,
        perBuilderAtTypical: 0,
      }
    : estimateGatewayMonthlyCost(resolved.tier, { pricingMode: reservation.type });
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
      onDemandCompute: cost.onDemandComputeUsd,
      savings: cost.savingsUsd,
      pricingMode: cost.pricingMode,
      perBuilderAtTarget: cost.perBuilderAtTarget,
      perBuilderAtTypical: cost.perBuilderAtTypical,
    },
  };
}

function normalizeGatewayProfile(profile: unknown): GatewayProfile {
  return profile === "operator" ? "operator" : "standard";
}

function normalizeGatewayClass(doc: GlmDoc | undefined): GatewayClass {
  return resolveGatewayClass({
    gatewayClass: isGatewayClass(doc?.gatewayClass) ? doc.gatewayClass : undefined,
    profile: isGatewayProfile(doc?.profile) ? doc.profile : undefined,
    imageProfile: isGatewayProfile(doc?.imageProfile) ? doc.imageProfile : undefined,
  });
}

function normalizeGatewayImageProfile(doc: GlmDoc | undefined): GatewayImageProfile {
  return resolveGatewayImageProfile({
    gatewayClass: isGatewayClass(doc?.gatewayClass) ? doc.gatewayClass : undefined,
    profile: isGatewayProfile(doc?.profile) ? doc.profile : undefined,
    imageProfile: isGatewayProfile(doc?.imageProfile) ? doc.imageProfile : undefined,
  });
}

function isTruthyQueryFlag(value: unknown): boolean {
  return value === "true" || value === "1";
}

// The K8s namespace this fleet runs in — scopes the Grafana deep-link to the env.
export function resolveFleetNamespace(env: NodeJS.ProcessEnv = process.env): string {
  const ns = env.K8S_NAMESPACE;
  return typeof ns === "string" && ns.length > 0 ? ns : "octogee";
}

type GlmDoc = Record<string, unknown>;
interface FirestoreDocLike { id: string; data(): GlmDoc }

function indexGlmDocs(docs: ReadonlyArray<FirestoreDocLike>): Map<string, GlmDoc> {
  const out = new Map<string, GlmDoc>();
  for (const doc of docs) out.set(doc.id, doc.data());
  return out;
}

function projectLastError(raw: unknown):
  | { slug?: string; message?: string; at: string | null }
  | null {
  if (!raw || typeof raw !== "object") return null;
  const e = raw as { slug?: string; message?: string; at?: unknown };
  return { slug: e.slug, message: e.message, at: toIso(e.at) };
}

function projectDesiredStatus(glmDoc: GlmDoc | undefined):
  | "running" | "paused" | "draining" | "retired" | null {
  const v = glmDoc?.desiredStatus;
  if (typeof v !== "string") return null;
  if (v === "running" || v === "paused" || v === "draining" || v === "retired") return v;
  return null;
}

function isPlainRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function stringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

type ProjectedGatewayStorage = {
  mode: "emptyDir" | "pvc";
  pvcName: string | null;
  size: string | null;
  storageClassName: string | null;
  accessModes: string[];
};

function emptyDirGatewayStorage(): ProjectedGatewayStorage {
  return {
    mode: "emptyDir",
    pvcName: null,
    size: null,
    storageClassName: null,
    accessModes: [],
  };
}

function pvcNameForGateway(
  gatewayId: string,
  persistence: Record<string, unknown>,
): string {
  if (typeof persistence.existingClaim === "string" && persistence.existingClaim.length > 0) {
    return persistence.existingClaim;
  }
  return `octogee-gateway-${gatewayId}-data`;
}

function projectGatewayStorage(
  gatewayId: string,
  glmDoc: GlmDoc | undefined,
): ProjectedGatewayStorage {
  const persistence = isPlainRecord(glmDoc?.persistence) ? glmDoc.persistence : undefined;
  if (persistence?.enabled !== true) return emptyDirGatewayStorage();
  return {
    mode: "pvc",
    pvcName: pvcNameForGateway(gatewayId, persistence),
    size: typeof persistence.size === "string" ? persistence.size : null,
    storageClassName:
      typeof persistence.storageClassName === "string"
        ? persistence.storageClassName
        : null,
    accessModes: stringArray(persistence.accessModes),
  };
}

function gatewayComputeClassBase(): string {
  return resolveFleetNamespace() === "octogee-test"
    ? "octogee-gateway-test"
    : "octogee-gateway";
}

export function projectGatewayReservation(
  glmDoc: GlmDoc | undefined,
): {
  type: GatewayPricingMode;
  computeClass: string;
  priceMultiplier: number;
} {
  const explicitComputeClass =
    typeof glmDoc?.computeClass === "string" && glmDoc.computeClass.length > 0
      ? glmDoc.computeClass
      : null;
  const scheduling =
    glmDoc?.scheduling === "on-demand" || glmDoc?.scheduling === "spot"
      ? glmDoc.scheduling
      : "spot";
  const base = gatewayComputeClassBase();
  const computeClass = explicitComputeClass ?? (scheduling === "spot" ? `${base}-spot` : base);
  const type: GatewayPricingMode = computeClass.includes("spot") ? "spot" : "on-demand";
  return {
    type,
    computeClass,
    priceMultiplier: type === "spot" ? SPOT_PRICE_MULTIPLIER : 1,
  };
}

export function projectGatewaySummary(
  doc: FirestoreDocLike,
  glmDoc: GlmDoc | undefined,
  now: number,
): {
  gatewayId: string; status: string;
  desiredStatus: "running" | "paused" | "draining" | "retired" | null;
  imageTag: string | null; openclawVersion: string | null;
  mountedCustomers: unknown[];
  lastHeartbeatAt: string | null; heartbeatAgeMs: number | null;
  startedAt: string | null; uptimeMs: number | null;
  lastError: ReturnType<typeof projectLastError>;
  sizing: ReturnType<typeof resolveSizingForResponse>;
  storage: ReturnType<typeof projectGatewayStorage>;
  reservation: ReturnType<typeof projectGatewayReservation>;
  profile: GatewayProfile;
  gatewayClass: GatewayClass;
  imageProfile: GatewayImageProfile;
} {
  const data = doc.data();
  const gatewayId = typeof data.gatewayId === "string" ? data.gatewayId : doc.id;
  const reservation = projectGatewayReservation(glmDoc);
  return {
    gatewayId,
    status: typeof data.status === "string" ? data.status : "unknown",
    desiredStatus: projectDesiredStatus(glmDoc),
    imageTag: typeof data.version === "string" ? data.version : null,
    openclawVersion: typeof data.openclawVersion === "string" ? data.openclawVersion : null,
    mountedCustomers: Array.isArray(data.mountedCustomers) ? data.mountedCustomers : [],
    lastHeartbeatAt: toIso(data.lastHeartbeatAt),
    heartbeatAgeMs: ageMsOrNull(toMillis(data.lastHeartbeatAt), now),
    startedAt: toIso(data.startedAt),
    uptimeMs: ageMsOrNull(toMillis(data.startedAt), now),
    lastError: projectLastError(data.lastError),
    sizing: resolveSizingForResponse(glmDoc, reservation),
    storage: projectGatewayStorage(gatewayId, glmDoc),
    reservation,
    profile: normalizeGatewayProfile(glmDoc?.profile),
    gatewayClass: normalizeGatewayClass(glmDoc),
    imageProfile: normalizeGatewayImageProfile(glmDoc),
  };
}

function rollupFleetStats(
  gateways: ReadonlyArray<ReturnType<typeof projectGatewaySummary>>,
): {
  gateways: { total: number; ready: number; unreachable: number };
  customersMounted: number;
  fleetCost: {
    monthlyUsd: number;
    onDemandMonthlyUsd: number;
    savingsUsd: number;
    byTier: Record<string, {
      count: number;
      subtotalUsd: number;
      onDemandSubtotalUsd: number;
      spotCount: number;
      onDemandCount: number;
    }>;
  };
} {
  let ready = 0, unreachable = 0, customersMounted = 0, fleetMonthlyUsd = 0, fleetOnDemandUsd = 0;
  const byTier: Record<string, {
    count: number;
    subtotalUsd: number;
    onDemandSubtotalUsd: number;
    spotCount: number;
    onDemandCount: number;
  }> = {};
  for (const g of gateways) {
    // Derived reachability (replaces the deleted Cloud-Function "unreachable" writer):
    // a gateway whose heartbeat has aged out is unreachable, whatever its last
    // self-reported status said. See FLEET-RECONCILE-SPEC.
    const stale = g.heartbeatAgeMs != null && g.heartbeatAgeMs > GATEWAY_UNREACHABLE_AFTER_MS;
    if (stale) unreachable++;
    else if (g.status === "ready") ready++;
    customersMounted += g.mountedCustomers.length;
    fleetMonthlyUsd += g.sizing.monthlyCostUsd.compute;
    fleetOnDemandUsd += g.sizing.monthlyCostUsd.onDemandCompute;
    const entry = byTier[g.sizing.tier] ?? {
      count: 0,
      subtotalUsd: 0,
      onDemandSubtotalUsd: 0,
      spotCount: 0,
      onDemandCount: 0,
    };
    entry.count += 1;
    entry.subtotalUsd += g.sizing.monthlyCostUsd.compute;
    entry.onDemandSubtotalUsd += g.sizing.monthlyCostUsd.onDemandCompute;
    if (g.reservation.type === "spot") entry.spotCount += 1;
    else entry.onDemandCount += 1;
    byTier[g.sizing.tier] = entry;
  }
  return {
    gateways: { total: gateways.length, ready, unreachable },
    customersMounted,
    fleetCost: {
      monthlyUsd: fleetMonthlyUsd,
      onDemandMonthlyUsd: fleetOnDemandUsd,
      savingsUsd: Math.max(0, fleetOnDemandUsd - fleetMonthlyUsd),
      byTier,
    },
  };
}

const ERR_GATEWAY_NOT_FOUND = "gateway not found";
const GATEWAY_IMAGE_REPO_PREFIX =
  "us-central1-docker.pkg.dev/octogee/octogee/";
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

interface AddGatewayBody {
  gatewayId: string;
  imageRepository: string;
  imageTag: string;
  profile: string;
  gatewayClass: string;
  imageProfile: string;
  sizingTier: string;
  ownerUid: string;
  builderSlug: string;
}

interface AddGatewayCreate {
  gatewayId: string;
  imageRepository: string;
  imageTag: string;
  profile?: GatewayProfile;
  gatewayClass?: GatewayClass;
  imageProfile?: GatewayImageProfile;
  sizingTier?: SizingTier;
  ownerUid?: string;
  builderSlug?: string;
}

interface FulfillOperatorReservationBody {
  gatewayId: string;
  imageRepository: string;
  imageTag: string;
}

interface FulfillableOperatorReservation {
  uid: string;
  builderSlug: string;
  requestedSizingTier: SizingTier;
  requestedAt: number;
}

interface ActivatableOperatorReservation {
  uid: string;
  builderSlug: string;
  gatewayId: string;
}

interface AdminOperatorGatewayReservationSummary {
  uid: string;
  builderSlug: string | null;
  requestedSizingTier: SizingTier | null;
  status: string;
  billingStatus: string;
  currentGatewayId: string | null;
  currentGatewayProfile: GatewayProfile | null;
  gatewayId: string | null;
  operationId: string | null;
  requestedAt: string | null;
  updatedAt: string | null;
  provisioningStartedAt: string | null;
  provisioningStartedBy: string | null;
  activationOperationId: string | null;
  activationStartedAt: string | null;
  activationStartedBy: string | null;
  fulfilledAt: string | null;
  fulfilledByOperationId: string | null;
  readyToFulfill: boolean;
  fulfillBlockedReason: string | null;
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

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
}

interface RolloutBodyError {
  status: number;
  body: Record<string, unknown>;
}

interface RolloutBodyOk {
  imageTag: string;
  imageRepository: string | null;
  profile?: GatewayProfile;
  gatewayClass?: GatewayClass;
  imageProfile?: GatewayImageProfile;
}

// A PATCH may move a gateway between running/paused/draining, but NOT to
// "retired": that must run full teardown via DELETE (which creates the
// retire-gateway op). A bare PATCH to "retired" only flips desired state, and
// the reconciler would then remove the pod while stranding the PVC, both
// auth-token secrets, the GSA, and the Firestore records.
export function validateDesiredStatusPatch(
  desiredStatus: string,
):
  | { error: { status: number; body: { error: string; got?: string } } }
  | { ok: "running" | "paused" | "draining" } {
  if (desiredStatus === "retired") {
    return {
      error: {
        status: 400,
        body: {
          error:
            "retire a gateway via DELETE /gateways/:id (full teardown), not PATCH desiredStatus=retired",
        },
      },
    };
  }
  if (
    desiredStatus !== "running" &&
    desiredStatus !== "paused" &&
    desiredStatus !== "draining"
  ) {
    return {
      error: {
        status: 400,
        body: {
          error: "desiredStatus must be one of: running, paused, draining",
          got: desiredStatus,
        },
      },
    };
  }
  return { ok: desiredStatus };
}

// eslint-disable-next-line complexity -- Linear API validation keeps each field's error response local.
export function validateRolloutBody(
  body: Partial<{
    imageTag: string;
    imageRepository: string;
    profile: string;
    gatewayClass: string;
    imageProfile: string;
  }>,
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
    (typeof body.profile !== "string" || !isGatewayProfile(body.profile))
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
  if (
    body.gatewayClass != null &&
    (typeof body.gatewayClass !== "string" || !isGatewayClass(body.gatewayClass))
  ) {
    return {
      error: {
        status: 400,
        body: {
          error: `gatewayClass must be one of: ${GATEWAY_CLASSES.join(", ")}`,
          got: body.gatewayClass,
        },
      },
    };
  }
  if (
    body.imageProfile != null &&
    (typeof body.imageProfile !== "string" || !isGatewayProfile(body.imageProfile))
  ) {
    return {
      error: {
        status: 400,
        body: {
          error: `imageProfile must be one of: ${GATEWAY_IMAGE_PROFILES.join(", ")}`,
          got: body.imageProfile,
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
      ...(body.gatewayClass != null
        ? { gatewayClass: body.gatewayClass as GatewayClass }
        : {}),
      ...(body.imageProfile != null
        ? { imageProfile: body.imageProfile as GatewayImageProfile }
        : {}),
    },
  };
}

function validateAddGatewayRequiredFields(
  body: Partial<AddGatewayBody>,
): { error: RolloutBodyError } | {
  ok: Pick<
    AddGatewayCreate,
    "gatewayId" | "imageRepository" | "imageTag"
  >;
} {
  if (
    !isNonEmptyString(body.gatewayId) ||
    !isNonEmptyString(body.imageRepository) ||
    !isNonEmptyString(body.imageTag)
  ) {
    return {
      error: {
        status: 400,
        body: {
          error: "missing required fields",
          required: ["gatewayId", "imageRepository", "imageTag"],
        },
      },
    };
  }
  if (!isValidGatewayId(body.gatewayId)) {
    return {
      error: {
        status: 400,
        body: {
          error: GATEWAY_ID_REQUIREMENT,
          got: body.gatewayId,
        },
      },
    };
  }
  return {
    ok: {
      gatewayId: body.gatewayId,
      imageRepository: body.imageRepository,
      imageTag: body.imageTag,
    },
  };
}

function validateAddGatewayProfile(
  body: Partial<AddGatewayBody>,
): {
  error: RolloutBodyError;
} | {
  ok: {
    profile?: GatewayProfile;
    gatewayClass?: GatewayClass;
    imageProfile?: GatewayImageProfile;
  };
} {
  if (body.profile !== undefined && !isGatewayProfile(body.profile)) {
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
  if (body.gatewayClass !== undefined && !isGatewayClass(body.gatewayClass)) {
    return {
      error: {
        status: 400,
        body: {
          error: `gatewayClass must be one of: ${GATEWAY_CLASSES.join(", ")}`,
          got: body.gatewayClass,
        },
      },
    };
  }
  if (body.imageProfile !== undefined && !isGatewayProfile(body.imageProfile)) {
    return {
      error: {
        status: 400,
        body: {
          error: `imageProfile must be one of: ${GATEWAY_IMAGE_PROFILES.join(", ")}`,
          got: body.imageProfile,
        },
      },
    };
  }
  return {
    ok: {
      ...(body.profile ? { profile: body.profile as GatewayProfile } : {}),
      ...(body.gatewayClass ? { gatewayClass: body.gatewayClass as GatewayClass } : {}),
      ...(body.imageProfile ? { imageProfile: body.imageProfile as GatewayImageProfile } : {}),
    },
  };
}

function validateAddGatewaySizing(
  body: Partial<AddGatewayBody>,
): { error: RolloutBodyError } | { ok: { sizingTier?: SizingTier } } {
  if (
    body.sizingTier !== undefined &&
    !(SIZING_TIERS as readonly string[]).includes(body.sizingTier)
  ) {
    return {
      error: {
        status: 400,
        body: {
          error: `sizingTier must be one of: ${SIZING_TIERS.join(", ")}`,
          got: body.sizingTier,
        },
      },
    };
  }
  return {
    ok: body.sizingTier ? { sizingTier: body.sizingTier as SizingTier } : {},
  };
}

function validateAddGatewayOwnerFields(
  body: Partial<AddGatewayBody>,
  gatewayClass: GatewayClass,
): { error: RolloutBodyError } | {
  ok: { ownerUid?: string; builderSlug?: string };
} {
  if (body.ownerUid !== undefined && !isNonEmptyString(body.ownerUid)) {
    return {
      error: {
        status: 400,
        body: { error: "ownerUid must be a non-empty string" },
      },
    };
  }
  if (body.builderSlug !== undefined && !isNonEmptyString(body.builderSlug)) {
    return {
      error: {
        status: 400,
        body: { error: "builderSlug must be a non-empty string" },
      },
    };
  }
  if (
    (body.ownerUid !== undefined || body.builderSlug !== undefined) &&
    gatewayClass === "shared"
  ) {
    return {
      error: {
        status: 400,
        body: {
          error:
            "dedicated gateway ownership requires gatewayClass=builder or gatewayClass=operator",
        },
      },
    };
  }
  if (gatewayClass === "builder" && body.ownerUid === undefined) {
    return {
      error: {
        status: 400,
        body: { error: "builder gateway requires ownerUid" },
      },
    };
  }
  if (body.builderSlug !== undefined && body.ownerUid === undefined) {
    return {
      error: {
        status: 400,
        body: { error: "builderSlug requires ownerUid" },
      },
    };
  }
  return {
    ok: {
      ...(body.ownerUid ? { ownerUid: body.ownerUid } : {}),
      ...(body.builderSlug ? { builderSlug: body.builderSlug } : {}),
    },
  };
}

function validateAddGatewayRepository(
  imageRepository: string,
): RolloutBodyError | null {
  if (!isValidGatewayImageRepository(imageRepository)) {
    return {
      status: 400,
      body: {
        error:
          "imageRepository must be the canonical Octogee Artifact Registry repo",
        expectedPrefix: GATEWAY_IMAGE_REPO_PREFIX,
        got: imageRepository,
      },
    };
  }
  return null;
}

function validateAddGatewayBody(
  body: Partial<AddGatewayBody>,
): { error: RolloutBodyError } | { ok: AddGatewayCreate } {
  const required = validateAddGatewayRequiredFields(body);
  if ("error" in required) return required;
  const profile = validateAddGatewayProfile(body);
  if ("error" in profile) return profile;
  const gatewayClass = resolveGatewayClass(profile.ok);
  const sizing = validateAddGatewaySizing(body);
  if ("error" in sizing) return sizing;
  const owner = validateAddGatewayOwnerFields(
    body,
    gatewayClass,
  );
  if ("error" in owner) return owner;
  const repoError = validateAddGatewayRepository(required.ok.imageRepository);
  if (repoError) return { error: repoError };
  return {
    ok: {
      ...required.ok,
      ...profile.ok,
      gatewayClass,
      imageProfile: resolveGatewayImageProfile(profile.ok),
      ...sizing.ok,
      ...owner.ok,
    },
  };
}

function validateFulfillOperatorReservationBody(
  body: Partial<FulfillOperatorReservationBody>,
): { error: RolloutBodyError } | { ok: FulfillOperatorReservationBody } {
  const required = validateAddGatewayRequiredFields(body);
  if ("error" in required) return required;
  const repoError = validateAddGatewayRepository(required.ok.imageRepository);
  if (repoError) return { error: repoError };
  return { ok: required.ok };
}

function validateFulfillableOperatorReservation(
  uid: string,
  data: Record<string, unknown>,
): { error: RolloutBodyError } | { ok: FulfillableOperatorReservation } {
  if (data.uid !== uid) {
    return {
      error: {
        status: 409,
        body: { error: "reservation uid mismatch", uid, got: data.uid },
      },
    };
  }
  if (data.status !== "requested" || data.billingStatus !== "active") {
    return {
      error: {
        status: 409,
        body: {
          error: "operator gateway reservation is not ready for fulfillment",
          status: data.status,
          billingStatus: data.billingStatus,
        },
      },
    };
  }
  if (!isNonEmptyString(data.builderSlug)) {
    return {
      error: {
        status: 409,
        body: { error: "operator gateway reservation is missing builderSlug" },
      },
    };
  }
  if (!isSizingTier(data.requestedSizingTier)) {
    return {
      error: {
        status: 409,
        body: {
          error: "operator gateway reservation has invalid requestedSizingTier",
          requestedSizingTier: data.requestedSizingTier,
        },
      },
    };
  }
  if (typeof data.requestedAt !== "number" || !Number.isFinite(data.requestedAt)) {
    return {
      error: {
        status: 409,
        body: { error: "operator gateway reservation is missing requestedAt" },
      },
    };
  }
  return {
    ok: {
      uid,
      builderSlug: data.builderSlug,
      requestedSizingTier: data.requestedSizingTier,
      requestedAt: data.requestedAt,
    },
  };
}

function validateActivatableOperatorReservation(
  uid: string,
  data: Record<string, unknown>,
): { error: RolloutBodyError } | { ok: ActivatableOperatorReservation } {
  if (data.uid !== uid) {
    return {
      error: {
        status: 409,
        body: { error: "reservation uid mismatch", uid, got: data.uid },
      },
    };
  }
  if (data.status !== "provisioning") {
    return {
      error: {
        status: 409,
        body: {
          error: "operator gateway reservation is not ready for activation",
          status: data.status,
          billingStatus: data.billingStatus,
        },
      },
    };
  }
  if (data.billingStatus !== "active") {
    return {
      error: {
        status: 409,
        body: {
          error: "operator gateway reservation billing is not active",
          billingStatus: data.billingStatus,
        },
      },
    };
  }
  if (!isNonEmptyString(data.builderSlug)) {
    return {
      error: {
        status: 409,
        body: { error: "operator gateway reservation is missing builderSlug" },
      },
    };
  }
  if (!isNonEmptyString(data.gatewayId)) {
    return {
      error: {
        status: 409,
        body: { error: "operator gateway reservation is missing gatewayId" },
      },
    };
  }
  return {
    ok: {
      uid,
      builderSlug: data.builderSlug,
      gatewayId: data.gatewayId,
    },
  };
}

function normalizeReservationGatewayProfile(v: unknown): GatewayProfile | null {
  return typeof v === "string" &&
    (GATEWAY_PROFILES as readonly string[]).includes(v)
    ? (v as GatewayProfile)
    : null;
}

function fulfillBlockedReason(
  uid: string,
  data: Record<string, unknown>,
): string | null {
  if (data.uid !== uid) return "reservation uid mismatch";
  if (data.status !== "requested") return `status is ${String(data.status)}`;
  if (data.billingStatus !== "active") {
    return `billing is ${String(data.billingStatus)}`;
  }
  if (!isNonEmptyString(data.builderSlug)) return "missing builderSlug";
  if (!isSizingTier(data.requestedSizingTier)) return "invalid requestedSizingTier";
  if (typeof data.requestedAt !== "number" || !Number.isFinite(data.requestedAt)) {
    return "missing requestedAt";
  }
  return null;
}

function projectOperatorGatewayReservation(
  doc: FirestoreDocLike,
): AdminOperatorGatewayReservationSummary {
  const data = doc.data();
  const uid = isNonEmptyString(data.uid) ? data.uid : doc.id;
  const blockedReason = fulfillBlockedReason(uid, data);
  return {
    uid,
    builderSlug: isNonEmptyString(data.builderSlug) ? data.builderSlug : null,
    requestedSizingTier: isSizingTier(data.requestedSizingTier)
      ? data.requestedSizingTier
      : null,
    status: isNonEmptyString(data.status) ? data.status : "unknown",
    billingStatus: isNonEmptyString(data.billingStatus)
      ? data.billingStatus
      : "unknown",
    currentGatewayId: asStringOrNull(data.currentGatewayId),
    currentGatewayProfile: normalizeReservationGatewayProfile(
      data.currentGatewayProfile,
    ),
    gatewayId: asStringOrNull(data.gatewayId),
    operationId: asStringOrNull(data.operationId),
    requestedAt: toIso(data.requestedAt),
    updatedAt: toIso(data.updatedAt),
    provisioningStartedAt: toIso(data.provisioningStartedAt),
    provisioningStartedBy: asStringOrNull(data.provisioningStartedBy),
    activationOperationId: asStringOrNull(data.activationOperationId),
    activationStartedAt: toIso(data.activationStartedAt),
    activationStartedBy: asStringOrNull(data.activationStartedBy),
    fulfilledAt: toIso(data.fulfilledAt),
    fulfilledByOperationId: asStringOrNull(data.fulfilledByOperationId),
    readyToFulfill: blockedReason === null,
    fulfillBlockedReason: blockedReason,
  };
}

function readUserGatewayId(data: Record<string, unknown> | undefined): string | null {
  const provisioning =
    (data?.provisioning as Record<string, unknown> | undefined) ?? {};
  const openclaw =
    (provisioning.openclaw as Record<string, unknown> | undefined) ?? {};
  return asStringOrNull(openclaw.gatewayId);
}

function validateOperatorGatewayOwnership(opts: {
  uid: string;
  reservation: ActivatableOperatorReservation;
  gatewayData: Record<string, unknown>;
}): RolloutBodyError | null {
  if (resolveGatewayClass({
    gatewayClass: isGatewayClass(opts.gatewayData.gatewayClass)
      ? opts.gatewayData.gatewayClass
      : undefined,
    profile: isGatewayProfile(opts.gatewayData.profile)
      ? opts.gatewayData.profile
      : undefined,
    imageProfile: isGatewayProfile(opts.gatewayData.imageProfile)
      ? opts.gatewayData.imageProfile
      : undefined,
  }) !== "operator") {
    return {
      status: 409,
      body: {
        error: "reserved gateway is not operator class",
        gatewayId: opts.reservation.gatewayId,
        gatewayClass: opts.gatewayData.gatewayClass,
        profile: opts.gatewayData.profile,
      },
    };
  }
  if (opts.gatewayData.ownerUid !== opts.uid) {
    return {
      status: 409,
      body: {
        error: "reserved gateway owner does not match reservation uid",
        gatewayId: opts.reservation.gatewayId,
        ownerUid: opts.gatewayData.ownerUid,
      },
    };
  }
  if (opts.gatewayData.builderSlug !== opts.reservation.builderSlug) {
    return {
      status: 409,
      body: {
        error: "reserved gateway builderSlug does not match reservation",
        gatewayId: opts.reservation.gatewayId,
        builderSlug: opts.gatewayData.builderSlug,
      },
    };
  }
  return null;
}

function operatorReservationRank(
  reservation: AdminOperatorGatewayReservationSummary,
): number {
  if (reservation.readyToFulfill) return 0;
  if (reservation.status === "billing_pending" || reservation.billingStatus === "pending") {
    return 1;
  }
  if (reservation.status === "provisioning") return 2;
  if (reservation.status === "requested") return 3;
  if (reservation.status === "fulfilled") return 4;
  if (reservation.status === "cancelled") return 5;
  return 9;
}

function reservationSortMs(
  reservation: AdminOperatorGatewayReservationSummary,
): number {
  const parsed = Date.parse(
    reservation.updatedAt ?? reservation.requestedAt ?? "",
  );
  return Number.isFinite(parsed) ? parsed : 0;
}

function compareOperatorReservations(
  a: AdminOperatorGatewayReservationSummary,
  b: AdminOperatorGatewayReservationSummary,
): number {
  const rankDelta = operatorReservationRank(a) - operatorReservationRank(b);
  if (rankDelta !== 0) return rankDelta;
  return reservationSortMs(b) - reservationSortMs(a);
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

async function readMountedCustomers(db: Firestore, gatewayId: string): Promise<string[]> {
  const snap = await db.collection("gateways").doc(gatewayId).get();
  if (!snap.exists) return [];
  const data = snap.data() as { mountedCustomers?: unknown } | undefined;
  return Array.isArray(data?.mountedCustomers)
    ? (data!.mountedCustomers as unknown[]).filter((s): s is string => typeof s === "string")
    : [];
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

async function ensureGatewayCreateIsUnique(
  db: Firestore,
  body: Pick<AddGatewayCreate, "gatewayId">,
): Promise<{ error: RolloutBodyError } | { ok: true }> {
  const existing = await db
    .collection(GLM_GATEWAYS_COLLECTION)
    .doc(body.gatewayId)
    .get();
  if (existing.exists) {
    return {
      error: {
        status: 409,
        body: {
          error: "gateway already exists",
          gatewayId: body.gatewayId,
        },
      },
    };
  }

  return { ok: true };
}

async function resolveDedicatedGatewayOwner(opts: {
  db: Firestore;
  body: AddGatewayCreate;
  createdBy: string;
  now: number;
  workspaceSlugsForUser: FleetRouterDeps["workspaceSlugsForUser"];
}): Promise<
  | { error: RolloutBodyError }
  | {
      ok: {
        ownerUid?: string;
        builderSlug?: string;
        operatorReservation?: OperatorGatewayReservationSpec;
      };
    }
> {
  const { body } = opts;
  const gatewayClass = resolveGatewayClass(body);
  if (
    (gatewayClass !== "builder" && gatewayClass !== "operator") ||
    body.ownerUid === undefined
  ) {
    return { ok: {} };
  }

  const ownerSnap = await opts.db.collection("users").doc(body.ownerUid).get();
  if (!ownerSnap.exists) {
    return {
      error: {
        status: 404,
        body: {
          error: "owner user not found",
          ownerUid: body.ownerUid,
        },
      },
    };
  }

  const userData = (ownerSnap.data() ?? {}) as Record<string, unknown>;
  const builderSlug =
    body.builderSlug ?? resolveCustomerSlug(userData, opts.workspaceSlugsForUser);
  if (!builderSlug) {
    return {
      error: {
        status: 400,
        body: {
          error:
            "builderSlug is required when owner user has no resolvable workspace slug",
          ownerUid: body.ownerUid,
        },
      },
    };
  }

  return {
    ok: {
      ownerUid: body.ownerUid,
      builderSlug,
      ...(gatewayClass === "operator"
        ? {
            operatorReservation: {
              status: "reserved" as const,
              reservedAt: opts.now,
              reservedBy: opts.createdBy,
              billingStatus: "manual" as const,
            },
          }
        : {}),
    },
  };
}

function operatorGatewayDesiredStateFromReservation(opts: {
  body: FulfillOperatorReservationBody;
  reservation: FulfillableOperatorReservation;
  createdBy: string;
  now: number;
}): Record<string, unknown> {
  const profile: GatewayProfile = "operator";
  const gatewayClass: GatewayClass = "operator";
  const imageProfile: GatewayImageProfile = "operator";
  const persistence = resolveGatewayPersistence(profile, undefined);
  return {
    gatewayId: opts.body.gatewayId,
    imageRepository: opts.body.imageRepository,
    imageTag: opts.body.imageTag,
    desiredStatus: "running",
    createdBy: opts.createdBy,
    createdAt: opts.now,
    profile,
    gatewayClass,
    imageProfile,
    ...(persistence ? { persistence } : {}),
    operatorAccess: defaultOperatorGatewayAccess(opts.reservation.uid),
    serviceAccountName: operatorGatewayServiceAccountName(opts.body.gatewayId),
    serviceAccount: OPERATOR_GATEWAY_LOCKED_SERVICE_ACCOUNT,
    ownerUid: opts.reservation.uid,
    builderSlug: opts.reservation.builderSlug,
    sizingTier: opts.reservation.requestedSizingTier,
    operatorReservation: {
      status: "provisioning",
      reservedAt: opts.reservation.requestedAt,
      reservedBy: opts.reservation.uid,
      billingStatus: "active",
      billingVerifiedAt: opts.now,
    } satisfies OperatorGatewayReservationSpec,
  };
}

function addGatewayOperationRecord(opts: {
  createdBy: string;
  now: number;
  input: Record<string, unknown>;
}): Record<string, unknown> {
  const gatewayId =
    typeof opts.input.gatewayId === "string" ? opts.input.gatewayId : null;
  const inputUid = typeof opts.input.uid === "string" ? opts.input.uid : null;
  return {
    kind: "add-gateway",
    status: "pending",
    createdBy: opts.createdBy,
    createdAt: opts.now,
    startedAt: null,
    completedAt: null,
    input: opts.input,
    steps: [],
    ...(gatewayId !== null ? { gatewayId } : {}),
    ...(inputUid !== null ? { inputUid } : {}),
  };
}

export interface BuilderCandidate {
  uid: string;
  username: string;
  email: string;
  slug: string | null;
  assigned: boolean;
}

interface BuilderCandidateDoc {
  id: string;
  data: () => Record<string, unknown>;
}

// A builder is "assigned" — and therefore excluded from the operator-gateway picker —
// when any of three signals say a pet gateway already belongs to them:
//   1. they are the ownerUid (or a coOwnerUid) on a glmGateways desired-state doc,
//   2. an operatorGatewayReservations doc (id === uid) has a non-released status, or
//   3. their own user doc carries an operatorGatewayReservation with a non-released status.
// `released` is the only reservation status that frees the builder back up.
export function buildBuilderCandidates(opts: {
  approvedUsers: BuilderCandidateDoc[];
  glmGateways: BuilderCandidateDoc[];
  reservations: BuilderCandidateDoc[];
  workspaceSlugsForUser: FleetRouterDeps["workspaceSlugsForUser"];
}): BuilderCandidate[] {
  const assigned = new Set<string>();

  for (const doc of opts.glmGateways) {
    const data = doc.data();
    const ownerUid = asStringOrNull(data.ownerUid);
    if (ownerUid) assigned.add(ownerUid);
    if (Array.isArray(data.coOwnerUids)) {
      for (const co of data.coOwnerUids) {
        if (typeof co === "string" && co.length > 0) assigned.add(co);
      }
    }
  }

  for (const doc of opts.reservations) {
    const status = asStringOrNull(doc.data().status);
    if (status !== "released") assigned.add(doc.id);
  }

  const candidates = opts.approvedUsers.map((doc) => {
    const data = doc.data();
    const ownReservation =
      data.operatorGatewayReservation &&
      typeof data.operatorGatewayReservation === "object"
        ? (data.operatorGatewayReservation as { status?: unknown })
        : null;
    const ownStatus = asStringOrNull(ownReservation?.status);
    const isAssigned =
      assigned.has(doc.id) || (ownReservation !== null && ownStatus !== "released");
    return {
      uid: doc.id,
      username: asStringOrNull(data.username) ?? "",
      email: asStringOrNull(data.email) ?? "",
      slug: resolveCustomerSlug(data, opts.workspaceSlugsForUser),
      assigned: isAssigned,
    };
  });

  candidates.sort((a, b) =>
    (a.username || a.email).localeCompare(b.username || b.email, undefined, {
      sensitivity: "base",
    }),
  );
  return candidates;
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
        const [gwSnap, glmSnap] = await Promise.all([
          db.collection("gateways").get(),
          db.collection(GLM_GATEWAYS_COLLECTION).get(),
        ]);
        const glmByGatewayId = indexGlmDocs(glmSnap.docs);
        const now = Date.now();
        const gateways = gwSnap.docs.map((doc) =>
          projectGatewaySummary(doc, glmByGatewayId.get(doc.id), now),
        );
        res.json({
          gateways,
          stats: rollupFleetStats(gateways),
          namespace: resolveFleetNamespace(),
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

router.get(
    "/builder-candidates",
    async (_req: Request, res: Response, next: NextFunction) => {
      try {
        const [usersSnap, glmSnap, reservationsSnap] = await Promise.all([
          db.collection("users").where("approved", "==", true).get(),
          db.collection(GLM_GATEWAYS_COLLECTION).get(),
          db.collection(OPERATOR_GATEWAY_RESERVATIONS_COLLECTION).get(),
        ]);
        const candidates = buildBuilderCandidates({
          approvedUsers: usersSnap.docs,
          glmGateways: glmSnap.docs,
          reservations: reservationsSnap.docs,
          workspaceSlugsForUser: deps.workspaceSlugsForUser,
        });
        res.json({ candidates, generatedAt: new Date().toISOString() });
      } catch (e) {
        next(e);
      }
    },
  );

router.get(
    "/operator-gateway-reservations",
    async (_req: Request, res: Response, next: NextFunction) => {
      try {
        const snap = await db
          .collection(OPERATOR_GATEWAY_RESERVATIONS_COLLECTION)
          .get();
        const reservations = snap.docs
          .map(projectOperatorGatewayReservation)
          .sort(compareOperatorReservations);
        res.json({
          reservations,
          generatedAt: new Date().toISOString(),
        });
      } catch (e) {
        next(e);
      }
    },
  );

router.post(
    "/operator-gateway-reservations/:uid/activate",
    // eslint-disable-next-line complexity -- activation is a single transactional admin boundary with several explicit guard responses; splitting would hide the order of safety checks.
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const uid = req.params.uid as string;
        const actor = req as ActorRequest;
        const createdBy = actor.uid ?? "unknown";
        const now = Date.now();

        const reservationRef = db
          .collection(OPERATOR_GATEWAY_RESERVATIONS_COLLECTION)
          .doc(uid);
        const [reservationSnap, userSnap] = await Promise.all([
          reservationRef.get(),
          db.collection("users").doc(uid).get(),
        ]);
        if (!reservationSnap.exists) {
          res.status(404).json({
            error: "operator gateway reservation not found",
            uid,
          });
          return;
        }
        if (!userSnap.exists) {
          res.status(404).json({ error: "owner user not found", uid });
          return;
        }

        const reservationData = reservationSnap.data() as Record<string, unknown>;
        const userData = userSnap.data() as Record<string, unknown> | undefined;
        const currentGatewayId = readUserGatewayId(userData);
        if (
          reservationData.status === "fulfilled" &&
          currentGatewayId === reservationData.gatewayId
        ) {
          res.status(200).json({
            uid,
            gatewayId: reservationData.gatewayId,
            status: "fulfilled",
            alreadyActive: true,
          });
          return;
        }

        const reservation = validateActivatableOperatorReservation(
          uid,
          reservationData,
        );
        if ("error" in reservation) {
          res.status(reservation.error.status).json(reservation.error.body);
          return;
        }

        const [targetDesiredSnap, targetHeartbeatSnap, pendingOpsSnap] =
          await Promise.all([
            db
              .collection(GLM_GATEWAYS_COLLECTION)
              .doc(reservation.ok.gatewayId)
              .get(),
            db.collection("gateways").doc(reservation.ok.gatewayId).get(),
            db
              .collection(GLM_OPERATIONS_COLLECTION)
              .where("status", "in", ["pending", "running"])
              .get(),
          ]);
        if (!targetDesiredSnap.exists) {
          res.status(404).json({
            error: "reserved gateway desired state not found",
            gatewayId: reservation.ok.gatewayId,
          });
          return;
        }
        const ownershipError = validateOperatorGatewayOwnership({
          uid,
          reservation: reservation.ok,
          gatewayData: targetDesiredSnap.data() as Record<string, unknown>,
        });
        if (ownershipError) {
          res.status(ownershipError.status).json(ownershipError.body);
          return;
        }
        if (!targetHeartbeatSnap.exists) {
          res.status(409).json({
            error: "reserved gateway has not reported ready yet",
            gatewayId: reservation.ok.gatewayId,
            status: "missing",
          });
          return;
        }
        const targetStatus = (
          targetHeartbeatSnap.data() as Record<string, unknown> | undefined
        )?.status;
        if (targetStatus !== "ready") {
          res.status(409).json({
            error: "reserved gateway not ready",
            gatewayId: reservation.ok.gatewayId,
            status: targetStatus ?? "unknown",
          });
          return;
        }

        if (currentGatewayId === reservation.ok.gatewayId) {
          const fulfilledUpdate = {
            status: "fulfilled" as const,
            fulfilledAt: now,
            fulfilledByOperationId:
              asStringOrNull(reservationData.activationOperationId) ??
              asStringOrNull(reservationData.operationId) ??
              "already-active",
            updatedAt: now,
          };
          const batch = db.batch();
          batch.update(reservationRef, fulfilledUpdate);
          batch.update(db.collection("users").doc(uid), {
            "operatorGatewayReservation.status": "fulfilled",
            "operatorGatewayReservation.fulfilledAt": fulfilledUpdate.fulfilledAt,
            "operatorGatewayReservation.fulfilledByOperationId":
              fulfilledUpdate.fulfilledByOperationId,
            "operatorGatewayReservation.updatedAt": now,
          });
          await batch.commit();
          res.status(200).json({
            uid,
            gatewayId: reservation.ok.gatewayId,
            status: "fulfilled",
            alreadyActive: true,
          });
          return;
        }

        const existingActivation = findPendingActivationOperation(
          pendingOpsSnap.docs,
          uid,
          reservation.ok.gatewayId,
          "operator-gateway-reservation",
        );
        if (existingActivation) {
          res.status(409).json({
            error: "operator gateway activation is already running",
            uid,
            gatewayId: reservation.ok.gatewayId,
            operationId: existingActivation.id,
            kind: existingActivation.kind,
          });
          return;
        }

        const opRef = db.collection(GLM_OPERATIONS_COLLECTION).doc();
        const operationId = opRef.id;
        const operationInput = {
          uid,
          toGatewayId: reservation.ok.gatewayId,
          source: "operator-gateway-reservation",
          operatorReservationUid: uid,
          builderSlug: reservation.ok.builderSlug,
        };
        const reservationUpdate: Partial<OperatorGatewayReservationRequest> = {
          activationOperationId: operationId,
          activationStartedAt: now,
          activationStartedBy: createdBy,
          updatedAt: now,
        };

        const batch = db.batch();
        batch.set(opRef, {
          kind: "migrate-customer",
          status: "pending",
          createdBy,
          createdAt: now,
          startedAt: null,
          completedAt: null,
          input: operationInput,
          steps: [],
          gatewayId: reservation.ok.gatewayId,
          inputUid: uid,
        });
        batch.update(reservationRef, reservationUpdate);
        batch.update(db.collection("users").doc(uid), {
          "operatorGatewayReservation.activationOperationId": operationId,
          "operatorGatewayReservation.activationStartedAt": now,
          "operatorGatewayReservation.activationStartedBy": createdBy,
          "operatorGatewayReservation.updatedAt": now,
        });
        await batch.commit();

        res.status(202).json({
          uid,
          gatewayId: reservation.ok.gatewayId,
          operationId,
          status: "activating",
        });
      } catch (e) {
        next(e);
      }
    },
  );

router.post(
    "/customers/:uid/assign",
    // eslint-disable-next-line complexity -- linear request validation and one repair fast-path; each branch returns its own operator-facing response.
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
              provisioning?: { openclaw?: { gatewayId?: string; gatewayProfile?: unknown } };
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
        const glmSnap = await db.collection(GLM_GATEWAYS_COLLECTION).doc(body.gatewayId).get();
        const shellState = resolveUserGatewayShellState(
          glmSnap.exists ? glmSnap.data() : undefined,
          uid,
        );
        const gatewayProfile = shellState.gatewayProfile;
        if (currentGid === body.gatewayId) {
          if (normalizeGatewayProfile(userData.provisioning?.openclaw?.gatewayProfile) !== gatewayProfile) {
            await db
              .collection("users")
              .doc(uid)
              .update({
                "provisioning.openclaw.gatewayProfile": gatewayProfile,
                "provisioning.openclaw.shellsEnabled": shellState.shellsEnabled,
              });
            res.status(200).json({ uid, gatewayId: body.gatewayId, gatewayProfile, repaired: true });
            return;
          }
          res.status(409).json({
            error: "user already assigned to that gateway — no-op",
            uid,
            gatewayId: body.gatewayId,
            gatewayProfile,
          });
          return;
        }
        await db
          .collection("users")
          .doc(uid)
          .update({
            "provisioning.openclaw.gatewayId": body.gatewayId,
            "provisioning.openclaw.gatewayProfile": gatewayProfile,
            "provisioning.openclaw.shellsEnabled": shellState.shellsEnabled,
          });
        res.status(202).json({ uid, gatewayId: body.gatewayId, gatewayProfile });
      } catch (e) {
        next(e);
      }
    },
  );

router.post(
    "/customers/:uid/activation-lease",
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const uid = req.params.uid as string;
        const actor = req as ActorRequest;
        const createdBy = actor.uid ?? "unknown";
        const now = Date.now();
        const body = req.body as Partial<{
          gatewayClass: string;
          reason: string;
        }>;
        let requestedGatewayClass: "builder" | "operator" | null = "builder";
        if (body.gatewayClass === "operator") {
          requestedGatewayClass = "operator";
        } else if (
          body.gatewayClass !== undefined &&
          body.gatewayClass !== "builder"
        ) {
          requestedGatewayClass = null;
        }
        if (requestedGatewayClass === null) {
          res.status(400).json({
            error: "gatewayClass must be builder or operator",
            got: body.gatewayClass,
          });
          return;
        }

        const result = await requestBuilderActivationLease({
          db,
          uid,
          requestedGatewayClass,
          createdBy,
          reason: typeof body.reason === "string" && body.reason.length > 0
            ? body.reason
            : "builder-activity",
          workspaceSlugsForUser: deps.workspaceSlugsForUser,
          now,
        });
        res.status(result.statusCode).json(result.body);
      } catch (e) {
        next(e);
      }
    },
  );

router.post(
    "/operator-gateway-reservations/:uid/fulfill",
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const uid = req.params.uid as string;
        const actor = req as ActorRequest;
        const createdBy = actor.uid ?? "unknown";
        const now = Date.now();

        const parsed = validateFulfillOperatorReservationBody(
          req.body as Partial<FulfillOperatorReservationBody>,
        );
        if ("error" in parsed) {
          res.status(parsed.error.status).json(parsed.error.body);
          return;
        }
        const body = parsed.ok;

        const reservationRef = db
          .collection(OPERATOR_GATEWAY_RESERVATIONS_COLLECTION)
          .doc(uid);
        const [reservationSnap, userSnap] = await Promise.all([
          reservationRef.get(),
          db.collection("users").doc(uid).get(),
        ]);
        if (!reservationSnap.exists) {
          res.status(404).json({
            error: "operator gateway reservation not found",
            uid,
          });
          return;
        }
        if (!userSnap.exists) {
          res.status(404).json({ error: "owner user not found", uid });
          return;
        }

        const reservation = validateFulfillableOperatorReservation(
          uid,
          reservationSnap.data() as Record<string, unknown>,
        );
        if ("error" in reservation) {
          res.status(reservation.error.status).json(reservation.error.body);
          return;
        }

        const uniqueness = await ensureGatewayCreateIsUnique(db, body);
        if ("error" in uniqueness) {
          res.status(uniqueness.error.status).json(uniqueness.error.body);
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

        const opRef = db.collection(GLM_OPERATIONS_COLLECTION).doc();
        const operationId = opRef.id;
        const operationInput = {
          uid,
          gatewayId: body.gatewayId,
          imageTag: body.imageTag,
          profile: "operator",
          gatewayClass: "operator",
          imageProfile: "operator",
          sizingTier: reservation.ok.requestedSizingTier,
          builderSlug: reservation.ok.builderSlug,
          source: "operator-gateway-reservation",
        };
        const reservationUpdate: Partial<OperatorGatewayReservationRequest> = {
          status: "provisioning",
          gatewayId: body.gatewayId,
          operationId,
          provisioningStartedAt: now,
          provisioningStartedBy: createdBy,
          updatedAt: now,
        };

        const batch = db.batch();
        batch.set(
          db.collection(GLM_GATEWAYS_COLLECTION).doc(body.gatewayId),
          operatorGatewayDesiredStateFromReservation({
            body,
            reservation: reservation.ok,
            createdBy,
            now,
          }),
        );
        batch.set(
          opRef,
          addGatewayOperationRecord({
            createdBy,
            now,
            input: operationInput,
          }),
        );
        batch.update(reservationRef, reservationUpdate);
        batch.update(db.collection("users").doc(uid), {
          "operatorGatewayReservation.status": "provisioning",
          "operatorGatewayReservation.gatewayId": body.gatewayId,
          "operatorGatewayReservation.operationId": operationId,
          "operatorGatewayReservation.provisioningStartedAt": now,
          "operatorGatewayReservation.provisioningStartedBy": createdBy,
          "operatorGatewayReservation.updatedAt": now,
        });
        await batch.commit();

        res.status(202).json({
          uid,
          gatewayId: body.gatewayId,
          operationId,
          status: "provisioning",
        });
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
        const actor = req as ActorRequest;
        const createdBy = actor.uid ?? "unknown";
        const now = Date.now();

        const parsed = validateAddGatewayBody(req.body as Partial<AddGatewayBody>);
        if ("error" in parsed) {
          res.status(parsed.error.status).json(parsed.error.body);
          return;
        }
        const body = parsed.ok;

        const uniqueness = await ensureGatewayCreateIsUnique(db, body);
        if ("error" in uniqueness) {
          res.status(uniqueness.error.status).json(uniqueness.error.body);
          return;
        }

        const owner = await resolveDedicatedGatewayOwner({
          db,
          body,
          createdBy,
          now,
          workspaceSlugsForUser: deps.workspaceSlugsForUser,
        });
        if ("error" in owner) {
          res.status(owner.error.status).json(owner.error.body);
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
        const gatewayClass = resolveGatewayClass(body);
        const imageProfile = resolveGatewayImageProfile(body);
        const persistence = resolveGatewayPersistence(imageProfile, undefined);
        const operatorDefaults =
          gatewayClass === "operator"
            ? {
                operatorAccess: defaultOperatorGatewayAccess(owner.ok.ownerUid),
                serviceAccountName: operatorGatewayServiceAccountName(body.gatewayId),
                serviceAccount: OPERATOR_GATEWAY_LOCKED_SERVICE_ACCOUNT,
              }
            : {};
        await db
          .collection(GLM_GATEWAYS_COLLECTION)
          .doc(body.gatewayId)
          .set({
            gatewayId: body.gatewayId,
            imageRepository: body.imageRepository,
            imageTag: body.imageTag,
            desiredStatus: "running",
            createdBy,
            createdAt: now,
            ...(body.profile ? { profile: body.profile } : {}),
            gatewayClass,
            ...(imageProfile !== "standard" ? { imageProfile } : {}),
            ...(persistence ? { persistence } : {}),
            ...operatorDefaults,
            ...owner.ok,
            ...(body.sizingTier ? { sizingTier: body.sizingTier } : {}),
          });
        const operationId = await createOperation(db, {
          kind: "add-gateway",
          createdBy,
          input: {
            gatewayId: body.gatewayId,
            imageTag: body.imageTag,
            ...(body.profile ? { profile: body.profile } : {}),
            gatewayClass,
            ...(imageProfile !== "standard" ? { imageProfile } : {}),
            ...(body.sizingTier ? { sizingTier: body.sizingTier } : {}),
            ...(owner.ok.ownerUid ? { ownerUid: owner.ok.ownerUid } : {}),
            ...(owner.ok.builderSlug ? { builderSlug: owner.ok.builderSlug } : {}),
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
          const v = validateDesiredStatusPatch(body.desiredStatus);
          if ("error" in v) {
            res.status(v.error.status).json(v.error.body);
            return;
          }
          update.desiredStatus = v.ok;
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
        // A direct imageTag write on a MOUNTED gateway is refused by the
        // reconciler (it would drop live sessions), but it still poisons desired
        // state so a later rollout no-ops. Route image changes through the
        // blue/green rollout op instead. Empty gateways may still be set directly.
        if (update.imageTag !== undefined) {
          const mounted = await readMountedCustomers(db, id);
          if (mounted.length > 0) {
            res.status(409).json({
              error:
                "cannot set imageTag directly on a gateway with mounted customers — roll it via POST /api/admin/gateways/:id/rollout (blue/green)",
              gatewayId: id,
              mountedCustomers: mounted,
            });
            return;
          }
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
        const retainData = isTruthyQueryFlag(req.query.retainData);
        const retainServiceAccount = isTruthyQueryFlag(req.query.retainServiceAccount);
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
            | { mountedCustomers?: unknown }
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
          input: {
            gatewayId: id,
            ...(retainData ? { retainData: true } : {}),
            ...(retainServiceAccount ? { retainServiceAccount: true } : {}),
          },
          steps: [],
          gatewayId: id,
        });
        await batch.commit();
        res.status(202).json({ gatewayId: id, operationId, retainData, retainServiceAccount });
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
          input: { gatewayId: id },
        });
        res.status(202).json({ gatewayId: id, operationId });
      } catch (e) {
        next(e);
      }
    },
  );

  router.post(
    "/gateways/:id/rollout",
    // eslint-disable-next-line complexity -- linear preflight: body validate → exists → no-op → conflicting-op → write. Each guard's response shape is distinct.
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const id = req.params.id as string;
        const validation = validateRolloutBody(
          req.body as Partial<{
            imageTag: string;
            imageRepository: string;
            profile: string;
            gatewayClass: string;
            imageProfile: string;
          }>,
        );
        if ("error" in validation) {
          res.status(validation.error.status).json(validation.error.body);
          return;
        }
        const { imageTag, imageRepository, profile, gatewayClass, imageProfile } = validation.ok;

        const ref = db.collection(GLM_GATEWAYS_COLLECTION).doc(id);
        const snap = await ref.get();
        if (!snap.exists) {
          res
            .status(404)
            .json({ error: ERR_GATEWAY_NOT_FOUND, gatewayId: id });
          return;
        }
        const data = snap.data() as
          | {
              imageTag?: string;
              imageRepository?: string;
              profile?: string;
              gatewayClass?: string;
              imageProfile?: string;
            }
          | undefined;
        const targetRepo = imageRepository ?? data?.imageRepository ?? "";
        const currentProfile = isGatewayProfile(data?.profile) ? data.profile : "standard";
        const currentGatewayClass = normalizeGatewayClass(data);
        const currentImageProfile = normalizeGatewayImageProfile(data);
        const targetProfile = profile ?? currentProfile;
        const targetGatewayClass = gatewayClass ?? currentGatewayClass;
        const targetImageProfile = imageProfile ?? profile ?? currentImageProfile;
        if (
          data?.imageTag === imageTag &&
          data.imageRepository === targetRepo &&
          targetProfile === currentProfile &&
          targetGatewayClass === currentGatewayClass &&
          targetImageProfile === currentImageProfile
        ) {
          res.status(409).json({
            error: "gateway already on requested image — no-op rollout",
            gatewayId: id,
            imageTag,
            imageRepository: targetRepo,
            profile: targetProfile,
            gatewayClass: targetGatewayClass,
            imageProfile: targetImageProfile,
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
          gatewayClass?: GatewayClass;
          imageProfile?: GatewayImageProfile;
        } = { gatewayId: id, imageTag };
        if (imageRepository) input.imageRepository = imageRepository;
        if (profile) input.profile = profile;
        if (gatewayClass) input.gatewayClass = gatewayClass;
        if (imageProfile) input.imageProfile = imageProfile;
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
