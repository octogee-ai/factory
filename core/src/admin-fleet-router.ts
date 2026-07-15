

import {
  Router,
  type Request,
  type Response,
  type NextFunction,
} from "express";
import { FieldValue, type Firestore, type Transaction } from "firebase-admin/firestore";
import {
  GLM_GATEWAYS_COLLECTION,
  GLM_OPERATIONS_COLLECTION,
  GATEWAY_CLASSES,
  GATEWAY_IMAGE_PROFILES,
  GATEWAY_PROFILES,
  NEW_GATEWAY_ID_REQUIREMENT,
  OPERATOR_GATEWAY_RESERVATIONS_COLLECTION,
  defaultOperatorGatewayAccess,
  resolveUserGatewayShellState,
  OPERATOR_GATEWAY_LOCKED_SERVICE_ACCOUNT,
  isValidNewGatewayId,
  isGatewayClass,
  isGatewayProfile,
  operatorGatewayServiceAccountName,
  resolveGatewayClass,
  resolveGatewayImageProfile,
  deriveGatewayIdentity,
  type GatewayClass,
  type GatewayImageProfile,
  type GatewayProfile,
  type GatewayServiceAccountSpec,
  type OperatorGatewayAccessSpec,
  type OperatorGatewayReservationSpec,
  type OperatorGatewayReservationRequest,
} from "@octogee/shared/types/glm";
import { GATEWAYS_COLLECTION } from "@octogee/shared/types/fleet-controller";
import {
  GATEWAY_ASSIGNMENTS_SUBCOLLECTION,
  GATEWAY_RELEASES_SUBCOLLECTION,
  commitPlacementAtomic,
  isReleasePayload,
  releasePayloadHash,
  isGatewayDesiredDoc,
  isGatewayLegacyBackfill,
  isRevisionRealizationDoc,
  revisionIdForRelease,
  rootReferencedRevisionIds,
  type AssignmentDoc,
  type AssignmentState,
  type GatewayDoc,
  type GatewayLifecycleStatus,
  type PlacementFirestore,
  type ReleaseDoc,
  type ReleasePayload,
  type RevisionRealizationDoc,
} from "@octogee/shared/types/gateway-releases";
import { parseAssignmentDoc, readAssignmentDocsForGateway } from "./assignment-doc.js";
import {
  GATEWAY_CONFIG_SCHEMA_VERSION,
  gatewayArtifactFromReleasePayload,
  isGatewayMutableConfigForGateway,
  type GatewayArtifact,
  type GatewayMutableConfig,
} from "./gateway-live-release.js";
import { projectReleaseHistory } from "./gateway-release-history.js";
import {
  resolveOnboardingPlacementForUid,
  type OnboardingOrchestratorConfig,
} from "@octogee/shared/types/orchestrator-placement";
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
import { resolveUidForSlug } from "./assigned-roster.js";
import {
  GatewayRetirementConflictError,
  claimGatewayRetirementAtomic,
  hasGatewayRetirementConfigObligation,
} from "./gateway-retirement-claim.js";

export { resolveBuilderActivationPlan } from "./builder-activation-lease.js";

export interface FleetLogger {
  info: (msg: string, meta?: Record<string, unknown>) => void;
  warn: (msg: string, meta?: Record<string, unknown>) => void;
}

export type GatewayPodDiagnosticsStatus = "ready" | "not-ready" | "missing" | "unknown";

function rejectPersistenceInBody(body: Record<string, unknown>): {
  status: number;
  body: Record<string, string>;
} | null {
  if (body.persistence === undefined) return null;
  return {
    status: 400,
    body: {
      error:
        "persistence specs are rejected — all gateways are Spot + emptyDir; PVC-backed gateways are dropped",
    },
  };
}

export interface GatewayPodDiagnostic {
  name: string;
  phase: string;
  readyContainers: number;
  totalContainers: number;
  restarts: number;
  reason: string | null;
  nodeName: string | null;
  ageMs: number | null;
}

export interface GatewayPodDiagnostics {
  status: GatewayPodDiagnosticsStatus;
  totalPods: number;
  readyPods: number;
  totalRestarts: number;
  pods: GatewayPodDiagnostic[];
  error?: string;
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
  readGatewayPodDiagnostics?: (gatewayId: string) => Promise<GatewayPodDiagnostics>;
  
  deleteAuthUserTolerantOfMissing: (uid: string) => Promise<void>;
  dedicatedGatewayIdleDefaultMs?: number;
  dedicatedGatewayIdleSweepMs?: number;
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
type DurableGatewayRoot = GatewayDoc & GatewayMutableConfig;

interface DurableGatewayRuntime {
  root: DurableGatewayRoot;
  revision: RevisionRealizationDoc | null;
  heartbeat: GlmDoc | null;
}

const FLEET_RUNTIME_CONFIG_DOC_PATH = "config/orchestrator";
export const DEDICATED_GATEWAY_IDLE_DEFAULT_MS = 30 * 60 * 1000;
const DEDICATED_GATEWAY_IDLE_SWEEP_MS_DEFAULT = 60_000;

export interface DedicatedGatewayIdleSettings {
  configuredMs: number | null;
  defaultMs: number;
  effectiveMs: number;
  sweepMs: number;
  disabled: boolean;
}

export interface FleetRuntimeSettings {
  dedicatedGatewayIdle: DedicatedGatewayIdleSettings;
}

type AdminOnboardingDriftState =
  | "healthy"
  | "pointer-drift"
  | "assigned-not-mounted"
  | "mounted-orphan"
  | "missing-gateway"
  | "in-flight";

type AdminOnboardingPlacementWarningCode =
  | "default-gateway-missing"
  | "default-gateway-retired"
  | "default-gateway-not-shared"
  | "override-gateway-missing"
  | "pointer-drift"
  | "assigned-not-mounted"
  | "mounted-orphan"
  | "migration-in-flight";

interface AdminOnboardingPlacementWarning {
  code: AdminOnboardingPlacementWarningCode;
  message: string;
  severity: "info" | "warning" | "error";
  gatewayId?: string;
  uid?: string;
  slug?: string;
  operationId?: string;
}

interface AdminOnboardingLatestOperation {
  id: string;
  kind: string;
  status: string;
  gatewayId: string | null;
  inputUid: string | null;
  createdAt: number | null;
  startedAt: number | null;
  completedAt: number | null;
  error?: string;
  input: Record<string, unknown>;
}

type AdminGatewayDesiredStatus = "running" | "paused" | "draining" | "retired";

interface AdminOnboardingOverrideSummary {
  uid: string;
  gatewayId: string;
  username: string;
  email: string;
  slug: string | null;
  currentGatewayId: string | null;
}

interface AdminOnboardingGatewaySummary {
  gatewayId: string;
  gatewayClass: GatewayClass;
  desiredStatus: AdminGatewayDesiredStatus | null;
  status: string | null;
  imageTag: string | null;
  openclawVersion: string | null;
  assignableAsDefault: boolean;
  defaultTarget: boolean;
  assignedCount: number;
  mountedCount: number;
  driftCount: number;
  warnings: AdminOnboardingPlacementWarning[];
  lastOperation: AdminOnboardingLatestOperation | null;
}

interface AdminOnboardingCustomerProjection {
  uid: string;
  username: string;
  email: string;
  slug: string | null;
  overrideGatewayId: string | null;
  policyTargetGatewayId: string | null;
  assignedGatewayId: string | null;
  mountedGatewayId: string | null;
  provisioningStatus: string | null;
  driftState: AdminOnboardingDriftState;
  // Durable roster truth from gateways/{gw}/assignments/{uid} (PR7). null when
  // the customer has no assignment doc (legacy/un-backfilled gateway) — the
  // client falls back to derivation only in that case.
  rosterState: AssignmentState | null;
  rosterRevisionId: string | null;
  rosterEpoch: number | null;
  warnings: AdminOnboardingPlacementWarning[];
  latestOperation: AdminOnboardingLatestOperation | null;
}

interface AdminOnboardingPlacementResponse {
  config: {
    defaultGatewayId: string | null;
    overrides: Record<string, string>;
  };
  overrides: AdminOnboardingOverrideSummary[];
  gateways: AdminOnboardingGatewaySummary[];
  customers: AdminOnboardingCustomerProjection[];
  driftSummary: Record<AdminOnboardingDriftState, number>;
  warnings: AdminOnboardingPlacementWarning[];
  generatedAt: string;
}

function normalizedNonNegativeInt(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}

function idleDefaultMs(value: number | undefined): number {
  return normalizedNonNegativeInt(value) ?? DEDICATED_GATEWAY_IDLE_DEFAULT_MS;
}

export function projectDedicatedGatewayIdleSettings(
  docData: Record<string, unknown> | undefined,
  defaultMs: number | undefined,
  sweepMs: number | undefined,
): DedicatedGatewayIdleSettings {
  const resolvedDefaultMs = idleDefaultMs(defaultMs);
  const configuredMs = normalizedNonNegativeInt(docData?.dedicatedGatewayIdleMs);
  const effectiveMs = configuredMs ?? resolvedDefaultMs;
  return {
    configuredMs,
    defaultMs: resolvedDefaultMs,
    effectiveMs,
    sweepMs: normalizedNonNegativeInt(sweepMs) ?? DEDICATED_GATEWAY_IDLE_SWEEP_MS_DEFAULT,
    disabled: effectiveMs === 0,
  };
}

export function parseDedicatedGatewayIdlePatch(
  body: Record<string, unknown>,
):
  | { ok: number | null }
  | { error: { status: number; body: { error: string; got?: unknown } } } {
  if (!Object.prototype.hasOwnProperty.call(body, "dedicatedGatewayIdleMs")) {
    return {
      error: {
        status: 400,
        body: { error: "dedicatedGatewayIdleMs is required" },
      },
    };
  }
  const value = body.dedicatedGatewayIdleMs;
  if (value === null) return { ok: null };
  if (normalizedNonNegativeInt(value) === null) {
    return {
      error: {
        status: 400,
        body: {
          error: "dedicatedGatewayIdleMs must be a non-negative integer number, or null to reset",
          got: value,
        },
      },
    };
  }
  return { ok: value as number };
}

function normalizeStringMap(value: unknown): Record<string, string> {
  if (!isPlainRecord(value)) return {};
  const out: Record<string, string> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (key.length > 0 && typeof raw === "string" && raw.length > 0) {
      out[key] = raw;
    }
  }
  return out;
}

function normalizeOnboardingRuntimeConfig(
  data: Record<string, unknown> | undefined,
): OnboardingOrchestratorConfig {
  return {
    defaultGatewayId: asStringOrNull(data?.defaultGatewayId) ?? "",
    overrides: normalizeStringMap(data?.overrides),
  };
}

async function readOnboardingRuntimeConfig(
  deps: FleetRouterDeps,
): Promise<OnboardingOrchestratorConfig> {
  const snap = await deps.db.doc(FLEET_RUNTIME_CONFIG_DOC_PATH).get();
  const data = snap.exists ? (snap.data() as Record<string, unknown> | undefined) : undefined;
  return normalizeOnboardingRuntimeConfig(data);
}

function validatePlacementGateway(
  gatewayId: string,
  gatewaysById: ReadonlyMap<string, DurableGatewayRoot>,
): { status: number; body: { error: string; gatewayId: string } } | null {
  const gateway = gatewaysById.get(gatewayId);
  if (!gateway) {
    return {
      status: 400,
      body: { error: "placement gateway desired state not found", gatewayId },
    };
  }
  if (gateway.desiredStatus === "retired") {
    return {
      status: 400,
      body: { error: "placement gateway must not be retired", gatewayId },
    };
  }
  if (gateway.gatewayClass !== "shared") {
    return {
      status: 400,
      body: { error: "placement gateway must be a shared gateway", gatewayId },
    };
  }
  return null;
}

function parsePlacementPatch(
  body: Record<string, unknown>,
  gatewaysById: ReadonlyMap<string, DurableGatewayRoot>,
):
  | { ok: { defaultGatewayId: string } }
  | { error: { status: number; body: Record<string, unknown> } } {
  const defaultGatewayId = asStringOrNull(body.defaultGatewayId);
  if (!defaultGatewayId) {
    return { error: { status: 400, body: { error: "defaultGatewayId is required" } } };
  }
  const gatewayError = validatePlacementGateway(defaultGatewayId, gatewaysById);
  if (gatewayError) return { error: gatewayError };
  return { ok: { defaultGatewayId } };
}

function readUserOpenclaw(data: Record<string, unknown>): Record<string, unknown> {
  const provisioning =
    (data.provisioning as Record<string, unknown> | undefined) ?? {};
  return (provisioning.openclaw as Record<string, unknown> | undefined) ?? {};
}

function readProvisioningStatus(data: Record<string, unknown>): string | null {
  const provisioning =
    (data.provisioning as Record<string, unknown> | undefined) ?? {};
  return asStringOrNull(provisioning.status) ?? asStringOrNull(readUserOpenclaw(data).status);
}

function shapeOnboardingOperation(
  id: string,
  data: Record<string, unknown>,
): AdminOnboardingLatestOperation {
  return {
    id,
    kind: asStringOrNull(data.kind) ?? "unknown",
    status: asStringOrNull(data.status) ?? "unknown",
    gatewayId: asStringOrNull(data.gatewayId),
    inputUid: asStringOrNull(data.inputUid),
    createdAt: coerceNumberOrNull(data.createdAt),
    startedAt: coerceNumberOrNull(data.startedAt),
    completedAt: coerceNumberOrNull(data.completedAt),
    ...(typeof data.error === "string" ? { error: data.error } : {}),
    input: isPlainRecord(data.input) ? data.input : {},
  };
}

function latestOperation(
  operations: ReadonlyArray<AdminOnboardingLatestOperation>,
  predicate: (operation: AdminOnboardingLatestOperation) => boolean,
): AdminOnboardingLatestOperation | null {
  return operations
    .filter(predicate)
    .sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))[0] ?? null;
}

function operationUid(operation: AdminOnboardingLatestOperation): string | null {
  return asStringOrNull(operation.input.uid) ?? asStringOrNull(operation.inputUid);
}

function operationTouchesGateway(
  operation: AdminOnboardingLatestOperation,
  gatewayId: string,
): boolean {
  return (
    operation.gatewayId === gatewayId ||
    operation.input.gatewayId === gatewayId ||
    operation.input.fromGatewayId === gatewayId ||
    operation.input.toGatewayId === gatewayId
  );
}

function isInFlightOperation(operation: AdminOnboardingLatestOperation | null): boolean {
  return operation?.status === "pending" || operation?.status === "running";
}

function mountedGatewayBySlug(
  gatewayById: ReadonlyMap<string, GlmDoc>,
): Map<string, string> {
  const out = new Map<string, string>();
  for (const [gatewayId, runtime] of gatewayById) {
    const hb = effectiveHeartbeatDoc(gatewayId, runtime)?.data();
    if (!hb) continue;
    for (const slug of readMountedSlugs(hb)) {
      out.set(slug, gatewayId);
    }
  }
  return out;
}

function shouldIncludeOnboardingCustomer(input: {
  uid: string;
  data: Record<string, unknown>;
  config: OnboardingOrchestratorConfig;
}): boolean {
  return (
    asStringOrNull(input.data.username) !== null ||
    readUserGatewayId(input.data) !== null ||
    Boolean(input.config.overrides?.[input.uid])
  );
}

// eslint-disable-next-line complexity -- Warning projection intentionally enumerates each drift state with its distinct operator message.
function userPlacementWarnings(input: {
  uid: string;
  slug: string | null;
  assignedGatewayId: string | null;
  mountedGatewayId: string | null;
  policyTargetGatewayId: string | null;
  driftState: AdminOnboardingDriftState;
  latestOperation: AdminOnboardingLatestOperation | null;
}): AdminOnboardingPlacementWarning[] {
  const warnings: AdminOnboardingPlacementWarning[] = [];
  if (input.driftState === "pointer-drift") {
    warnings.push({
      code: "pointer-drift",
      severity: "warning",
      uid: input.uid,
      slug: input.slug ?? undefined,
      gatewayId: input.assignedGatewayId ?? undefined,
      message: `${input.slug ?? input.uid} is assigned to ${input.assignedGatewayId ?? "none"} but policy targets ${input.policyTargetGatewayId ?? "none"}`,
    });
  }
  if (input.driftState === "assigned-not-mounted") {
    warnings.push({
      code: "assigned-not-mounted",
      severity: "warning",
      uid: input.uid,
      slug: input.slug ?? undefined,
      gatewayId: input.assignedGatewayId ?? undefined,
      message: `${input.slug ?? input.uid} is assigned to ${input.assignedGatewayId ?? "none"} but is not mounted there`,
    });
  }
  if (input.driftState === "mounted-orphan") {
    warnings.push({
      code: "mounted-orphan",
      severity: "warning",
      uid: input.uid,
      slug: input.slug ?? undefined,
      gatewayId: input.mountedGatewayId ?? undefined,
      message: `${input.slug ?? input.uid} is mounted on ${input.mountedGatewayId ?? "none"} but assigned to ${input.assignedGatewayId ?? "none"}`,
    });
  }
  if (input.driftState === "in-flight" && input.latestOperation) {
    warnings.push({
      code: "migration-in-flight",
      severity: "info",
      uid: input.uid,
      slug: input.slug ?? undefined,
      operationId: input.latestOperation.id,
      message: `${input.latestOperation.kind} ${input.latestOperation.id} is ${input.latestOperation.status}`,
    });
  }
  return warnings;
}

// eslint-disable-next-line complexity -- Drift classification is a prioritized decision table.
function driftStateForCustomer(input: {
  assignedGatewayId: string | null;
  mountedGatewayId: string | null;
  policyTargetGatewayId: string | null;
  latestOperation: AdminOnboardingLatestOperation | null;
  glmByGatewayId: Map<string, GlmDoc>;
}): AdminOnboardingDriftState {
  if (isInFlightOperation(input.latestOperation)) return "in-flight";
  const assignedGateway = input.assignedGatewayId
    ? input.glmByGatewayId.get(input.assignedGatewayId)
    : undefined;
  const assignedGatewayClass = assignedGateway ? normalizeGatewayClass(assignedGateway) : "shared";
  if (
    input.assignedGatewayId &&
    input.mountedGatewayId === input.assignedGatewayId &&
    assignedGatewayClass !== "shared"
  ) {
    return "healthy";
  }
  if (
    input.policyTargetGatewayId &&
    (!input.glmByGatewayId.has(input.policyTargetGatewayId) ||
      projectDesiredStatus(input.glmByGatewayId.get(input.policyTargetGatewayId)) === "retired")
  ) {
    return "missing-gateway";
  }
  if (
    input.assignedGatewayId &&
    input.policyTargetGatewayId &&
    input.assignedGatewayId !== input.policyTargetGatewayId
  ) {
    return "pointer-drift";
  }
  if (
    input.mountedGatewayId &&
    input.assignedGatewayId &&
    input.mountedGatewayId !== input.assignedGatewayId
  ) {
    return "mounted-orphan";
  }
  if (input.mountedGatewayId && !input.assignedGatewayId) return "mounted-orphan";
  if (
    input.assignedGatewayId &&
    input.mountedGatewayId !== input.assignedGatewayId
  ) {
    return "assigned-not-mounted";
  }
  return "healthy";
}

function buildCustomerPlacementProjection(input: {
  uid: string;
  data: Record<string, unknown>;
  config: OnboardingOrchestratorConfig;
  mountedBySlug: Map<string, string>;
  operations: ReadonlyArray<AdminOnboardingLatestOperation>;
  glmByGatewayId: Map<string, GlmDoc>;
  assignmentByUid: Map<string, AssignmentDoc>;
}): AdminOnboardingCustomerProjection {
  const slug = resolveCustomerSlug(input.data, (userData) =>
    asStringOrNull(userData.username) ? [asStringOrNull(userData.username)!] : [],
  );
  const assignedGatewayId = readUserGatewayId(input.data);
  const decision = resolveOnboardingPlacementForUid(input.uid, input.config);
  const mountedGatewayId = slug ? input.mountedBySlug.get(slug) ?? null : null;
  const latestOp = latestOperation(
    input.operations,
    (operation: AdminOnboardingLatestOperation) => operationUid(operation) === input.uid,
  );
  const driftState = driftStateForCustomer({
    assignedGatewayId,
    mountedGatewayId,
    policyTargetGatewayId: decision.gatewayId,
    latestOperation: latestOp,
    glmByGatewayId: input.glmByGatewayId,
  });
  const warnings = userPlacementWarnings({
    uid: input.uid,
    slug,
    assignedGatewayId,
    mountedGatewayId,
    policyTargetGatewayId: decision.gatewayId,
    driftState,
    latestOperation: latestOp,
  });
  const assignment = input.assignmentByUid.get(input.uid) ?? null;
  return {
    uid: input.uid,
    username: asStringOrNull(input.data.username) ?? "",
    email: asStringOrNull(input.data.email) ?? "",
    slug,
    overrideGatewayId: input.config.overrides?.[input.uid] ?? null,
    policyTargetGatewayId: decision.gatewayId,
    assignedGatewayId,
    mountedGatewayId,
    provisioningStatus: readProvisioningStatus(input.data),
    driftState,
    rosterState: assignment ? assignment.state : null,
    rosterRevisionId: assignment ? assignment.revisionId : null,
    rosterEpoch: assignment ? assignment.epoch : null,
    warnings,
    latestOperation: latestOp,
  };
}

function countBy<T extends string | null>(
  items: ReadonlyArray<AdminOnboardingCustomerProjection>,
  key: (item: AdminOnboardingCustomerProjection) => T,
): Record<Exclude<T, null>, number> {
  const out = {} as Record<Exclude<T, null>, number>;
  for (const item of items) {
    const value = key(item);
    if (value === null) continue;
    out[value as Exclude<T, null>] = (out[value as Exclude<T, null>] ?? 0) + 1;
  }
  return out;
}

function indexAssignmentDocs(
  docs: ReadonlyArray<FirestoreDocLike>,
): Map<string, AssignmentDoc> {
  const byUid = new Map<string, AssignmentDoc>();
  for (const doc of docs) {
    const parsed = parseAssignmentDoc(doc.id, doc.data());
    if (parsed) byUid.set(parsed.uid, parsed);
  }
  return byUid;
}

function buildOnboardingPlacementResponse(opts: {
  config: OnboardingOrchestratorConfig;
  glmDocs: ReadonlyArray<FirestoreDocLike>;
  gatewayDocs: ReadonlyArray<FirestoreDocLike>;
  userDocs: ReadonlyArray<FirestoreDocLike>;
  operationDocs: ReadonlyArray<FirestoreDocLike>;
  assignmentDocs: ReadonlyArray<FirestoreDocLike>;
}): AdminOnboardingPlacementResponse {
  const glmByGatewayId = indexAdminGatewayRuntimeDocs({
    gatewayDocs: opts.gatewayDocs,
    glmDocs: opts.glmDocs,
  });
  const heartbeatByGatewayId = indexFirestoreDocs(opts.gatewayDocs);
  const usersById = indexFirestoreDocs(opts.userDocs);
  const assignmentByUid = indexAssignmentDocs(opts.assignmentDocs);
  const gatewayOverrides = opts.config.overrides ?? {};
  const operations = opts.operationDocs.map((doc) =>
    shapeOnboardingOperation(doc.id, doc.data()),
  );
  const mountedBySlug = mountedGatewayBySlug(glmByGatewayId);
  const customers = opts.userDocs
    .filter((doc) =>
      shouldIncludeOnboardingCustomer({
        uid: doc.id,
        data: doc.data(),
        config: opts.config,
      }),
    )
    .map((doc) =>
      buildCustomerPlacementProjection({
        uid: doc.id,
        data: doc.data(),
        config: opts.config,
        mountedBySlug,
        operations,
        glmByGatewayId,
        assignmentByUid,
      }),
    )
    .sort((a, b) =>
      (a.slug ?? a.username ?? a.email ?? a.uid).localeCompare(
        b.slug ?? b.username ?? b.email ?? b.uid,
        undefined,
        { sensitivity: "base" },
      ),
    );

  const mountedCountsByGateway = countBy(customers, (customer) => customer.mountedGatewayId);
  const assignedCountsByGateway = countBy(customers, (customer) => customer.assignedGatewayId);
  const driftCountsByGateway: Record<string, number> = {};
  for (const customer of customers) {
    if (customer.driftState === "healthy") continue;
    const touchedGatewayIds = new Set(
      [
        customer.policyTargetGatewayId,
        customer.assignedGatewayId,
        customer.mountedGatewayId,
      ].filter((gatewayId): gatewayId is string => typeof gatewayId === "string"),
    );
    for (const gatewayId of touchedGatewayIds) {
      driftCountsByGateway[gatewayId] = (driftCountsByGateway[gatewayId] ?? 0) + 1;
    }
  }
  const driftSummary: Record<AdminOnboardingDriftState, number> = {
    healthy: 0,
    "pointer-drift": 0,
    "assigned-not-mounted": 0,
    "mounted-orphan": 0,
    "missing-gateway": 0,
    "in-flight": 0,
  };
  for (const customer of customers) driftSummary[customer.driftState] += 1;

  const gatewayIds = new Set([
    ...glmByGatewayId.keys(),
    ...heartbeatByGatewayId.keys(),
    ...Object.values(gatewayOverrides),
    ...customers.flatMap((customer) =>
      [
        customer.policyTargetGatewayId,
        customer.assignedGatewayId,
        customer.mountedGatewayId,
      ].filter((gatewayId): gatewayId is string => typeof gatewayId === "string"),
    ),
  ]);
  const gateways = [...gatewayIds].sort().map((gatewayId) => {
    const glmDoc = glmByGatewayId.get(gatewayId);
    const heartbeat = effectiveHeartbeatDoc(gatewayId, glmDoc)?.data();
    const desiredStatus = projectDesiredStatus(glmDoc);
    const gatewayClass = normalizeGatewayClass(glmDoc);
    const warnings = customers
      .filter((customer) =>
        [
          customer.policyTargetGatewayId,
          customer.assignedGatewayId,
          customer.mountedGatewayId,
        ].includes(gatewayId),
      )
      .flatMap((customer) => customer.warnings);
    return {
      gatewayId,
      gatewayClass,
      desiredStatus,
      status: asStringOrNull(heartbeat?.status),
      imageTag: projectImageTag(heartbeat ?? {}, glmDoc),
      openclawVersion: projectOpenclawVersion(heartbeat ?? {}, glmDoc),
      assignableAsDefault:
        Boolean(glmDoc) && gatewayClass === "shared" && desiredStatus !== "retired",
      defaultTarget: opts.config.defaultGatewayId === gatewayId,
      assignedCount: assignedCountsByGateway[gatewayId] ?? 0,
      mountedCount: mountedCountsByGateway[gatewayId] ?? 0,
      driftCount: driftCountsByGateway[gatewayId] ?? 0,
      warnings,
      lastOperation: latestOperation(operations, (operation) =>
        operationTouchesGateway(operation, gatewayId),
      ),
    };
  });

  const overrides = Object.entries(gatewayOverrides)
    .map(([uid, gatewayId]) => {
      const userData = usersById.get(uid)?.data() ?? {};
      return {
        uid,
        gatewayId,
        username: asStringOrNull(userData.username) ?? "",
        email: asStringOrNull(userData.email) ?? "",
        slug: resolveCustomerSlug(userData, (data) =>
          asStringOrNull(data.username) ? [asStringOrNull(data.username)!] : [],
        ),
        currentGatewayId: readUserGatewayId(userData),
      };
    })
    .sort((a, b) =>
      (a.username || a.email || a.uid).localeCompare(
        b.username || b.email || b.uid,
        undefined,
        { sensitivity: "base" },
      ),
    );

  const warnings: AdminOnboardingPlacementWarning[] = [];
  const defaultGatewayId = opts.config.defaultGatewayId || null;
  if (defaultGatewayId) {
    const glmDoc = glmByGatewayId.get(defaultGatewayId);
    if (!glmDoc) {
      warnings.push({
        code: "default-gateway-missing",
        severity: "error",
        gatewayId: defaultGatewayId,
        message: `Default gateway ${defaultGatewayId} has no desired state`,
      });
    } else if (projectDesiredStatus(glmDoc) === "retired") {
      warnings.push({
        code: "default-gateway-retired",
        severity: "error",
        gatewayId: defaultGatewayId,
        message: `Default gateway ${defaultGatewayId} is retired`,
      });
    } else if (normalizeGatewayClass(glmDoc) !== "shared") {
      warnings.push({
        code: "default-gateway-not-shared",
        severity: "warning",
        gatewayId: defaultGatewayId,
        message: `Default gateway ${defaultGatewayId} is not a shared gateway`,
      });
    }
  } else {
    warnings.push({
      code: "default-gateway-missing",
      severity: "error",
      message: "No default onboarding gateway is configured",
    });
  }
  for (const [uid, gatewayId] of Object.entries(gatewayOverrides)) {
    if (glmByGatewayId.has(gatewayId)) continue;
    warnings.push({
      code: "override-gateway-missing",
      severity: "error",
      uid,
      gatewayId,
      message: `Override for ${uid} points at missing gateway ${gatewayId}`,
    });
  }
  for (const customer of customers) warnings.push(...customer.warnings);

  return {
    config: {
      defaultGatewayId,
      overrides: gatewayOverrides,
    },
    overrides,
    gateways,
    customers,
    driftSummary,
    warnings,
    generatedAt: new Date().toISOString(),
  };
}

async function readAdminOnboardingPlacementResponse(
  deps: FleetRouterDeps,
): Promise<AdminOnboardingPlacementResponse> {
  const [config, glmSnap, gatewaySnap, usersSnap, operationsSnap, assignmentSnap] =
    await Promise.all([
      readOnboardingRuntimeConfig(deps),
      deps.db.collection(GLM_GATEWAYS_COLLECTION).get(),
      deps.db.collection("gateways").get(),
      deps.db.collection("users").get(),
      deps.db
        .collection(GLM_OPERATIONS_COLLECTION)
        .orderBy("createdAt", "desc")
        .limit(200)
        .get(),
      // One collection-group read pulls every gateways/{gw}/assignments/{uid}
      // across the fleet — the durable roster the panel reads (PR7).
      deps.db.collectionGroup(GATEWAY_ASSIGNMENTS_SUBCOLLECTION).get(),
    ]);
  return buildOnboardingPlacementResponse({
    config,
    glmDocs: glmSnap.docs,
    gatewayDocs: gatewaySnap.docs,
    userDocs: usersSnap.docs,
    operationDocs: operationsSnap.docs,
    assignmentDocs: assignmentSnap.docs,
  });
}

async function readFleetRuntimeSettings(deps: FleetRouterDeps): Promise<FleetRuntimeSettings> {
  const snap = await deps.db.doc(FLEET_RUNTIME_CONFIG_DOC_PATH).get();
  const data = snap.exists ? (snap.data() as Record<string, unknown> | undefined) : undefined;
  return {
    dedicatedGatewayIdle: projectDedicatedGatewayIdleSettings(
      data,
      deps.dedicatedGatewayIdleDefaultMs,
      deps.dedicatedGatewayIdleSweepMs,
    ),
  };
}

function indexGlmDocs(docs: ReadonlyArray<FirestoreDocLike>): Map<string, GlmDoc> {
  const out = new Map<string, GlmDoc>();
  for (const doc of docs) out.set(doc.id, doc.data());
  return out;
}

function indexFirestoreDocs(docs: ReadonlyArray<FirestoreDocLike>): Map<string, FirestoreDocLike> {
  const out = new Map<string, FirestoreDocLike>();
  for (const doc of docs) out.set(doc.id, doc);
  return out;
}

function indexDurableGatewayRoots(
  docs: ReadonlyArray<FirestoreDocLike>,
): Map<string, DurableGatewayRoot> {
  const out = new Map<string, DurableGatewayRoot>();
  for (const doc of docs) {
    const root = asDurableGatewayRoot(doc.data(), doc.id);
    if (root) out.set(doc.id, root);
  }
  return out;
}

function projectDurableGatewayRuntime(
  root: DurableGatewayRoot,
  revision: RevisionRealizationDoc | null,
): GlmDoc {
  if (!revision) return { ...root, gateway: root.gatewayId };
  return {
    ...root,
    gateway: root.gatewayId,
    imageRepository: revision.helm.imageRepository,
    imageTag: revision.helm.imageTag,
    heartbeat: revision.heartbeat,
    lastError: revision.lastError,
  };
}

// The admin surface is addressed by the durable gateway identity. Runtime
// observations belong only to the root's exact live revision; legacy bare GLM
// docs remain a display fallback solely while a root is genuinely absent.
function indexAdminGatewayRuntimeDocs(input: {
  gatewayDocs: ReadonlyArray<FirestoreDocLike>;
  glmDocs: ReadonlyArray<FirestoreDocLike>;
}): Map<string, GlmDoc> {
  const rawGlmById = indexGlmDocs(input.glmDocs);
  const rootsById = indexDurableGatewayRoots(input.gatewayDocs);
  const gatewayDocIds = new Set(input.gatewayDocs.map((doc) => doc.id));
  const out = new Map<string, GlmDoc>();
  for (const [gatewayId, root] of rootsById) {
    const revision = root.liveRevisionId
      ? exactLiveRevision(root, rawGlmById.get(root.liveRevisionId))
      : null;
    out.set(gatewayId, projectDurableGatewayRuntime(root, revision));
  }
  for (const [gatewayId, glmDoc] of rawGlmById) {
    if (gatewayDocIds.has(gatewayId) || isRevisionRealizationDoc(glmDoc)) continue;
    out.set(gatewayId, glmDoc);
  }
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

function requestedGatewayStatus(
  desiredStatus: ReturnType<typeof projectDesiredStatus>,
): string {
  if (desiredStatus === "running") return "booting";
  if (desiredStatus === "paused") return "paused";
  if (desiredStatus === "draining") return "draining";
  return "unknown";
}

function openclawVersionFromImageTag(imageTag: unknown): string | null {
  if (typeof imageTag !== "string") return null;
  const match = imageTag.match(/^[0-9a-f]{7,40}-oc(.+)$/u);
  return match?.[1] ?? null;
}

function projectOpenclawVersion(data: GlmDoc, glmDoc: GlmDoc | undefined): string | null {
  if (typeof data.openclawVersion === "string" && data.openclawVersion !== "unknown") {
    return data.openclawVersion;
  }
  return openclawVersionFromImageTag(glmDoc?.imageTag);
}

function projectImageTag(data: GlmDoc, glmDoc: GlmDoc | undefined): string | null {
  if (typeof data.version === "string") return data.version;
  return typeof glmDoc?.imageTag === "string" ? glmDoc.imageTag : null;
}

function syntheticGatewayDoc(id: string): FirestoreDocLike {
  return { id, data: () => ({ gatewayId: id }) };
}

function effectiveHeartbeatDoc(
  gatewayId: string,
  glmDoc: GlmDoc | undefined,
): FirestoreDocLike | undefined {
  const hb = glmDoc?.heartbeat;
  if (isPlainRecord(hb) && Object.keys(hb).length > 0) {
    const lastError = isPlainRecord(glmDoc?.lastError) ? glmDoc.lastError : undefined;
    return {
      id: gatewayId,
      data: () => ({ gatewayId, ...hb, ...(lastError ? { lastError } : {}) }),
    };
  }
  return undefined;
}

function shouldProjectDesiredOnlyGateway(glmDoc: GlmDoc | undefined): boolean {
  const desiredStatus = projectDesiredStatus(glmDoc);
  return desiredStatus !== null && desiredStatus !== "retired";
}

function isPlainRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function asDurableGatewayRoot(
  data: unknown,
  gatewayId: string,
): DurableGatewayRoot | null {
  if (
    !isGatewayDesiredDoc(data) ||
    data.gatewayId !== gatewayId ||
    !isGatewayMutableConfigForGateway(data, gatewayId)
  ) {
    return null;
  }
  return data as DurableGatewayRoot;
}

function hasDurableGatewayRootMarkers(data: unknown): boolean {
  if (!isPlainRecord(data)) return false;
  return [
    "latestRelease",
    "desiredRelease",
    "liveRelease",
    "liveRevisionId",
    "trafficRevisionId",
    "configSchemaVersion",
  ].some((field) => Object.prototype.hasOwnProperty.call(data, field));
}

function exactLiveRevision(
  root: DurableGatewayRoot,
  data: unknown,
): RevisionRealizationDoc | null {
  if (
    !root.liveRevisionId ||
    typeof root.liveRelease !== "number" ||
    !isRevisionRealizationDoc(data) ||
    data.revisionId !== root.liveRevisionId ||
    data.gateway !== root.gatewayId ||
    data.release !== root.liveRelease
  ) {
    return null;
  }
  return data;
}

function runtimeHeartbeat(revision: RevisionRealizationDoc | null): GlmDoc | null {
  return revision && isPlainRecord(revision.heartbeat) ? revision.heartbeat : null;
}

async function readDurableGatewayRuntime(
  db: Firestore,
  gatewayId: string,
): Promise<DurableGatewayRuntime | null> {
  const rootSnap = await db.collection(GATEWAYS_COLLECTION).doc(gatewayId).get();
  const root = rootSnap.exists ? asDurableGatewayRoot(rootSnap.data(), gatewayId) : null;
  if (!root) return null;
  if (!root.liveRevisionId || typeof root.liveRelease !== "number") {
    return { root, revision: null, heartbeat: null };
  }
  const revisionSnap = await db
    .collection(GLM_GATEWAYS_COLLECTION)
    .doc(root.liveRevisionId)
    .get();
  const revision = revisionSnap.exists ? exactLiveRevision(root, revisionSnap.data()) : null;
  return { root, revision, heartbeat: runtimeHeartbeat(revision) };
}

async function readGatewayRegistrationReadiness(
  db: Firestore,
  gatewayId: string,
): Promise<{ registered: boolean; status: string | null }> {
  const runtime = await readDurableGatewayRuntime(db, gatewayId);
  return {
    registered: runtime !== null,
    status:
      runtime?.root.desiredStatus === "running"
        ? asStringOrNull(runtime.heartbeat?.status)
        : null,
  };
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

// All gateways are Spot + emptyDir (#1932); the PVC path is deleted end-to-end
// (GATEWAY-RELEASES-SPEC). Storage is always projected as emptyDir.
function projectGatewayStorage(
  _gatewayId: string,
  _glmDoc: GlmDoc | undefined,
): ProjectedGatewayStorage {
  return emptyDirGatewayStorage();
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
  gatewayId: string; gateway: string; status: string;
  desiredStatus: AdminGatewayDesiredStatus | null;
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
  const desiredStatus = projectDesiredStatus(glmDoc);
  const reservation = projectGatewayReservation(glmDoc);
  return {
    gatewayId,
    gateway: deriveGatewayIdentity(gatewayId, glmDoc?.gateway),
    status: typeof data.status === "string" ? data.status : requestedGatewayStatus(desiredStatus),
    desiredStatus,
    imageTag: projectImageTag(data, glmDoc),
    openclawVersion: projectOpenclawVersion(data, glmDoc),
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
const ERR_GATEWAY_OPERATION_IN_FLIGHT =
  "another operation is already pending or running for this gateway";
const ERR_OWNER_USER_NOT_FOUND = "owner user not found";
const OP_KIND_MIGRATE_CUSTOMER = "migrate-customer";
const GATEWAY_IMAGE_REPO_PREFIX =
  "us-central1-docker.pkg.dev/octogee/octogee/";
const BUILDS_SERVICE_ALLOWLIST = new Set([
  "octogee-gateway",
  "gateway-edge",
]);

const OP_KINDS = new Set([
  "add-gateway",
  OP_KIND_MIGRATE_CUSTOMER,
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
    | typeof OP_KIND_MIGRATE_CUSTOMER
    | "retire-gateway"
    | "retire-revision"
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
  if (!isValidNewGatewayId(body.gatewayId)) {
    return {
      error: {
        status: 400,
        body: {
          error: NEW_GATEWAY_ID_REQUIREMENT,
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
  const artifactError = validateArtifact(required.ok);
  if (artifactError) return { error: artifactError };
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
  const artifactError = validateArtifact(required.ok);
  if (artifactError) return { error: artifactError };
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
  const slug = userSlug(data) || null;
  const gid =
    typeof openclaw.gatewayId === "string" ? openclaw.gatewayId : null;
  const username = typeof data.username === "string" ? data.username : "";
  const email = typeof data.email === "string" ? data.email : "";

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
  if (typeof openclaw.slug === "string") return openclaw.slug;
  return typeof data.username === "string" ? data.username : "";
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

async function projectGatewaySummaryWithDiagnostics(
  deps: FleetRouterDeps,
  doc: FirestoreDocLike,
  glmDoc: GlmDoc | undefined,
  now: number,
): Promise<ReturnType<typeof projectGatewaySummary> & {
  podDiagnostics: GatewayPodDiagnostics | null;
}> {
  const summary = projectGatewaySummary(doc, glmDoc, now);
  if (!deps.readGatewayPodDiagnostics) {
    return { ...summary, podDiagnostics: null };
  }
  try {
    return {
      ...summary,
      podDiagnostics: await deps.readGatewayPodDiagnostics(summary.gatewayId),
    };
  } catch (e) {
    deps.logger.warn("gateway pod diagnostics failed", {
      gatewayId: summary.gatewayId,
      error: (e as Error)?.message ?? String(e),
    });
    return {
      ...summary,
      podDiagnostics: {
        status: "unknown",
        totalPods: 0,
        readyPods: 0,
        totalRestarts: 0,
        pods: [],
        error: (e as Error)?.message ?? "pod diagnostics failed",
      },
    };
  }
}

function operationGatewayId(input: Record<string, unknown>): string | null {
  for (const field of ["gatewayId", "toGatewayId", "fromGatewayId"]) {
    const value = input[field];
    if (typeof value === "string") return value;
  }
  return null;
}

async function createOperation(
  db: Firestore,
  opts: NewOperationInput,
): Promise<string> {
  const ref = await db.collection(GLM_OPERATIONS_COLLECTION).add(
    operationDoc(opts, Date.now()),
  );
  return ref.id;
}

function operationDoc(
  opts: NewOperationInput,
  createdAt: number,
): Record<string, unknown> {
  const gatewayId = operationGatewayId(opts.input);
  const inputUid =
    typeof opts.input.uid === "string" ? opts.input.uid : null;
  return {
    kind: opts.kind,
    status: "pending",
    createdBy: opts.createdBy,
    createdAt,
    startedAt: null,
    completedAt: null,
    input: opts.input,
    steps: [],
    ...(gatewayId !== null ? { gatewayId } : {}),
    ...(inputUid !== null ? { inputUid } : {}),
  };
}

async function readGatewayDoc(
  db: Firestore,
  gatewayId: string,
): Promise<GatewayDoc | null> {
  const snap = await db.collection(GATEWAYS_COLLECTION).doc(gatewayId).get();
  if (!snap.exists) return null;
  return asDurableGatewayRoot(snap.data(), gatewayId);
}

async function readRelease(
  db: Firestore,
  gatewayId: string,
  release: number,
): Promise<ReleaseDoc | null> {
  const snap = await db
    .collection(GATEWAYS_COLLECTION)
    .doc(gatewayId)
    .collection(GATEWAY_RELEASES_SUBCOLLECTION)
    .doc(String(release))
    .get();
  if (!snap.exists) return null;
  return snap.data() as ReleaseDoc;
}

function asReleaseArtifactPayload(artifact: GatewayArtifact): ReleasePayload {
  return { ...artifact } as ReleasePayload;
}

function artifactFromRelease(release: ReleaseDoc): GatewayArtifact | null {
  if (!isReleasePayload(release.payload)) return null;
  return gatewayArtifactFromReleasePayload(release.payload);
}

function currentArtifactPatch(
  artifact: GatewayArtifact,
  patch: ArtifactPatchInput,
): GatewayArtifact {
  return {
    imageRepository: patch.imageRepository ?? artifact.imageRepository,
    imageTag: patch.imageTag ?? artifact.imageTag,
  };
}

function sameArtifact(left: GatewayArtifact, right: GatewayArtifact): boolean {
  return (
    left.imageRepository === right.imageRepository &&
    left.imageTag === right.imageTag
  );
}

interface InitialGatewayReleaseArgs {
  gatewayId: string;
  config: GatewayMutableConfig;
  artifact: GatewayArtifact;
  createdBy: string;
  now: number;
  desiredStatus: GatewayLifecycleStatus;
  validateAdditional?: (transaction: Transaction) => Promise<void>;
  writeAdditional?: (transaction: Transaction) => void;
}

function initialGatewayReleaseDocuments(args: InitialGatewayReleaseArgs): {
  gatewayDoc: GatewayDoc & GatewayMutableConfig;
  releaseDoc: ReleaseDoc;
} {
  const gatewayDoc: GatewayDoc & GatewayMutableConfig = {
    gatewayId: args.gatewayId,
    createdAt: args.now,
    createdBy: args.createdBy,
    updatedAt: args.now,
    updatedBy: args.createdBy,
    latestRelease: 1,
    desiredRelease: 1,
    liveRelease: null,
    liveRevisionId: null,
    trafficRevisionId: null,
    desiredStatus: args.desiredStatus,
    roll: null,
    legacyBackfill: null,
    ...args.config,
  };
  const payload = asReleaseArtifactPayload(args.artifact);
  const releaseDoc: ReleaseDoc = {
    gatewayId: args.gatewayId,
    release: 1,
    createdAt: args.now,
    createdBy: args.createdBy,
    sourceRelease: null,
    note: null,
    payloadHash: releasePayloadHash(payload),
    payload,
  };
  return { gatewayDoc, releaseDoc };
}

class InitialGatewayReleaseConflictError extends Error {
  constructor(readonly gatewayId: string) {
    super(`gateway ${gatewayId} already exists`);
  }
}

class InitialGatewayReleaseRequestError extends Error {
  constructor(
    readonly status: number,
    readonly body: Record<string, unknown>,
  ) {
    super(typeof body.error === "string" ? body.error : "initial gateway release rejected");
  }
}

async function writeInitialGatewayRelease(
  db: Firestore,
  args: InitialGatewayReleaseArgs,
): Promise<void> {
  const gwRef = db.collection(GATEWAYS_COLLECTION).doc(args.gatewayId);
  const relRef = gwRef.collection(GATEWAY_RELEASES_SUBCOLLECTION).doc("1");
  const { gatewayDoc, releaseDoc } = initialGatewayReleaseDocuments(args);
  await db.runTransaction(async (txn) => {
    const existing = await txn.get(gwRef);
    const relExisting = await txn.get(relRef);
    await args.validateAdditional?.(txn);
    if (existing.exists || relExisting.exists) {
      throw new InitialGatewayReleaseConflictError(args.gatewayId);
    }
    txn.set(gwRef, gatewayDoc as unknown as Record<string, unknown>, { merge: true });
    txn.set(relRef, releaseDoc as unknown as Record<string, unknown>);
    args.writeAdditional?.(txn);
  });
}

async function appendGatewayRelease(
  db: Firestore,
  args: {
    gateway: GatewayDoc;
    artifact: GatewayArtifact;
    createdBy: string;
    now: number;
    sourceRelease: number | null;
    note: string | null;
  },
): Promise<{ release: number; operationId: string | null }> {
  const gwRef = db.collection(GATEWAYS_COLLECTION).doc(args.gateway.gatewayId);
  const operationRef = db.collection(GLM_OPERATIONS_COLLECTION).doc();
  return db.runTransaction(async (txn) => {
    const snap = await txn.get(gwRef);
    const current = asDurableGatewayRoot(snap.data(), args.gateway.gatewayId);
    if (!current) {
      throw new InvalidGatewayRootError(args.gateway.gatewayId);
    }
    if (current.desiredStatus === "retired" || current.retirementClaim != null) {
      throw new GatewayRetirementConflictError(
        `gateway ${args.gateway.gatewayId} has a current retirement claim`,
      );
    }
    if (current.latestRelease !== args.gateway.latestRelease) {
      throw new StaleGatewayReleaseError(
        args.gateway.gatewayId,
        args.gateway.latestRelease,
        current.latestRelease,
      );
    }
    const activeOperations = await txn.get(
      db
        .collection(GLM_OPERATIONS_COLLECTION)
        .where("status", "in", ["pending", "running"]),
    );
    const migrationConflict = activeOperations.docs.find((doc) => {
      const operation = doc.data() as Record<string, unknown>;
      if (operation.kind !== OP_KIND_MIGRATE_CUSTOMER) return false;
      const input = isPlainRecord(operation.input) ? operation.input : {};
      const durable = isPlainRecord(operation.customerMigrationV2)
        ? operation.customerMigrationV2
        : {};
      return [
        input.fromGatewayId,
        input.toGatewayId,
        durable.sourceGatewayId,
        durable.targetGatewayId,
      ].includes(args.gateway.gatewayId);
    });
    if (migrationConflict) {
      throw new GatewayMigrationInFlightError(args.gateway.gatewayId, migrationConflict.id);
    }
    const release = current.latestRelease + 1;
    const relRef = gwRef.collection(GATEWAY_RELEASES_SUBCOLLECTION).doc(String(release));
    const relExisting = await txn.get(relRef);
    if (relExisting.exists) {
      throw new Error(
        `appendGatewayRelease: gateways/${args.gateway.gatewayId}/releases/${release} already exists — refusing to overwrite immutable history`,
      );
    }
    const payload = asReleaseArtifactPayload(args.artifact);
    const releaseDoc: ReleaseDoc = {
      gatewayId: args.gateway.gatewayId,
      release,
      createdAt: args.now,
      createdBy: args.createdBy,
      sourceRelease: args.sourceRelease,
      note: args.note,
      payloadHash: releasePayloadHash(payload),
      payload,
    };
    txn.set(relRef, releaseDoc as unknown as Record<string, unknown>);
    txn.update(gwRef, {
      latestRelease: release,
      desiredRelease: release,
      updatedAt: args.now,
      updatedBy: args.createdBy,
    });
    txn.set(
      operationRef,
      operationDoc(
        {
          kind: "rollout",
          createdBy: args.createdBy,
          input: rolloutOpInputFromArtifact(args.gateway.gatewayId, args.artifact),
        },
        args.now,
      ),
    );
    return { release, operationId: operationRef.id };
  });
}

class StaleGatewayReleaseError extends Error {
  constructor(
    readonly gatewayId: string,
    readonly expectedRelease: number,
    readonly actualRelease: number,
  ) {
    super(
      `gateway ${gatewayId} changed while this release was being cut ` +
        `(expected ${expectedRelease}, found ${actualRelease})`,
    );
  }
}

class InvalidGatewayRootError extends Error {
  constructor(readonly gatewayId: string) {
    super(`gateway ${gatewayId} durable root is invalid`);
  }
}

class GatewayMigrationInFlightError extends Error {
  constructor(
    readonly gatewayId: string,
    readonly operationId: string,
  ) {
    super(`customer migration is in flight for gateway ${gatewayId}`);
  }
}

function respondReleaseWriteConflict(res: Response, error: unknown): boolean {
  if (error instanceof GatewayRetirementConflictError) {
    res.status(409).json({ error: error.message });
    return true;
  }
  if (error instanceof GatewayMigrationInFlightError) {
    res.status(409).json({
      error: error.message,
      gatewayId: error.gatewayId,
      operationId: error.operationId,
      kind: OP_KIND_MIGRATE_CUSTOMER,
    });
    return true;
  }
  if (error instanceof InvalidGatewayRootError) {
    res.status(409).json({ error: error.message, gatewayId: error.gatewayId });
    return true;
  }
  if (error instanceof StaleGatewayReleaseError) {
    res.status(409).json({
      error: error.message,
      gatewayId: error.gatewayId,
      expectedRelease: error.expectedRelease,
      actualRelease: error.actualRelease,
    });
    return true;
  }
  return false;
}

function rolloutOpInputFromArtifact(
  gatewayId: string,
  artifact: GatewayArtifact,
): Record<string, unknown> {
  return {
    gatewayId,
    imageTag: artifact.imageTag,
    imageRepository: artifact.imageRepository,
  };
}

const GATEWAY_MUTABLE_CONFIG_FIELDS = [
  "profile",
  "gatewayClass",
  "imageProfile",
  "sizingTier",
  "computeClass",
  "gcpProject",
  "gatewayContainerSecurityContext",
  "serviceAccountName",
  "serviceAccount",
  "operatorAccess",
  "ownerUid",
  "coOwnerUids",
  "builderSlug",
  "openclawOverrides",
  "modelBrokerLimits",
  "preemption",
] as const satisfies ReadonlyArray<keyof Omit<GatewayMutableConfig, "configSchemaVersion">>;

type ArtifactPatchInput = Partial<Pick<GatewayArtifact, "imageRepository" | "imageTag">>;

function mutableConfigPatchFromBody(body: Record<string, unknown>): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  for (const field of GATEWAY_MUTABLE_CONFIG_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(body, field)) patch[field] = body[field];
  }
  return patch;
}

function artifactPatchFromBody(
  body: Record<string, unknown>,
): { error: RolloutBodyError } | { ok: ArtifactPatchInput } {
  const configFields = GATEWAY_MUTABLE_CONFIG_FIELDS.filter((field) =>
    Object.prototype.hasOwnProperty.call(body, field),
  );
  if (configFields.length > 0) {
    return {
      error: {
        status: 400,
        body: {
          error: "gateway configuration is mutable; update it with PATCH /api/admin/gateways/:id",
          fields: configFields,
        },
      },
    };
  }
  if (Object.prototype.hasOwnProperty.call(body, "byosub")) {
    return {
      error: {
        status: 400,
        body: {
          error: "byosub credentials are user-scoped and cannot be stored in a release",
          fields: ["byosub"],
        },
      },
    };
  }
  const unsupportedFields = Object.keys(body).filter(
    (field) => field !== "imageRepository" && field !== "imageTag",
  );
  if (unsupportedFields.length > 0) {
    return {
      error: {
        status: 400,
        body: {
          error: "release accepts only imageRepository and imageTag",
          fields: unsupportedFields,
        },
      },
    };
  }
  if (body.imageRepository === undefined && body.imageTag === undefined) {
    return { error: { status: 400, body: { error: "release requires imageRepository or imageTag" } } };
  }
  if (body.imageRepository !== undefined && typeof body.imageRepository !== "string") {
    return { error: { status: 400, body: { error: "imageRepository must be a string" } } };
  }
  if (body.imageTag !== undefined && typeof body.imageTag !== "string") {
    return { error: { status: 400, body: { error: "imageTag must be a string" } } };
  }
  return {
    ok: {
      ...(typeof body.imageRepository === "string" ? { imageRepository: body.imageRepository } : {}),
      ...(typeof body.imageTag === "string" ? { imageTag: body.imageTag } : {}),
    },
  };
}

function validateArtifact(artifact: GatewayArtifact): RolloutBodyError | null {
  if (!isValidGatewayImageRepository(artifact.imageRepository)) {
    return {
      status: 400,
      body: {
        error: "imageRepository must be the canonical Octogee Artifact Registry repo",
        expectedPrefix: GATEWAY_IMAGE_REPO_PREFIX,
        got: artifact.imageRepository,
      },
    };
  }
  if (!IMAGE_TAG_PATTERN.test(artifact.imageTag)) {
    return {
      status: 400,
      body: {
        error:
          "imageTag must be a lowercase hex SHA (7–40 chars) or pinned bundle (e.g. abc1234-oc2026.5.2)",
        got: artifact.imageTag,
      },
    };
  }
  return null;
}

async function validateGatewayConfigOwner(
  db: Firestore,
  previous: GatewayMutableConfig,
  next: GatewayMutableConfig,
): Promise<RolloutBodyError | null> {
  if (next.gatewayClass !== "builder" && next.gatewayClass !== "operator") {
    return null;
  }
  const candidates = new Set<string>();
  if (next.ownerUid && next.ownerUid !== previous.ownerUid) {
    candidates.add(next.ownerUid);
  }
  for (const uid of next.coOwnerUids) {
    if (!previous.coOwnerUids.includes(uid)) candidates.add(uid);
  }
  for (const uid of candidates) {
    const snap = await db.collection("users").doc(uid).get();
    if (!snap.exists) {
      return { status: 404, body: { error: ERR_OWNER_USER_NOT_FOUND, ownerUid: uid } };
    }
  }
  return null;
}

function buildCreateGatewayConfig(args: {
  body: AddGatewayCreate;
  gatewayClass: GatewayClass;
  imageProfile: GatewayImageProfile;
  ownerUid?: string;
  builderSlug?: string;
  operatorAccess?: OperatorGatewayAccessSpec;
  serviceAccountName?: string;
  serviceAccount?: GatewayServiceAccountSpec;
}): GatewayMutableConfig {
  return {
    configSchemaVersion: GATEWAY_CONFIG_SCHEMA_VERSION,
    profile: args.body.profile ?? null,
    gatewayClass: args.gatewayClass,
    imageProfile: args.imageProfile,
    sizingTier: args.body.sizingTier ?? null,
    computeClass: null,
    gcpProject: null,
    gatewayContainerSecurityContext: null,
    serviceAccountName: args.serviceAccountName ?? null,
    serviceAccount: args.serviceAccount ?? null,
    operatorAccess: args.operatorAccess ?? null,
    ownerUid: args.ownerUid ?? null,
    coOwnerUids: [],
    builderSlug: args.builderSlug ?? null,
    openclawOverrides: null,
    modelBrokerLimits: null,
    preemption: null,
  };
}

function buildCreateArtifact(body: AddGatewayCreate): GatewayArtifact {
  return {
    imageRepository: body.imageRepository,
    imageTag: body.imageTag,
  };
}

async function recordRolloutRelease(
  db: Firestore,
  args: { gateway: GatewayDoc; patch: ArtifactPatchInput; createdBy: string },
): Promise<{ release?: number; operationId: string }> {
  const { gateway } = args;
  const prev = await readRelease(db, gateway.gatewayId, gateway.latestRelease);
  if (!prev) {
    throw new Error(`gateway ${gateway.gatewayId} has no current release payload`);
  }
  const previousArtifact = artifactFromRelease(prev);
  if (!previousArtifact) {
    throw new Error(`gateway ${gateway.gatewayId} has an invalid current release artifact`);
  }
  const artifact = currentArtifactPatch(previousArtifact, args.patch);
  if (sameArtifact(previousArtifact, artifact)) {
    return {
      operationId: await createOperation(db, {
        kind: "rollout",
        createdBy: args.createdBy,
        input: rolloutOpInputFromArtifact(gateway.gatewayId, artifact),
      }),
    };
  }
  const appended = await appendGatewayRelease(db, {
    gateway,
    artifact,
    createdBy: args.createdBy,
    now: Date.now(),
    sourceRelease: gateway.latestRelease,
    note: null,
  });
  return { release: appended.release, operationId: appended.operationId! };
}

async function readRolloutCurrentConfig(
  db: Firestore,
  gatewayId: string,
): Promise<{
  gateway: GatewayDoc;
  artifact: GatewayArtifact;
} | null> {
  const gateway = await readGatewayDoc(db, gatewayId);
  if (!gateway) return null;
  const release = await readRelease(db, gatewayId, gateway.latestRelease);
  const artifact = release ? artifactFromRelease(release) : null;
  if (!artifact) throw new Error(`gateway ${gatewayId} has no current release artifact`);
  return { gateway, artifact };
}

function buildDurableGatewayPatch(args: {
  gatewayId: string;
  current: GatewayMutableConfig;
  body: Record<string, unknown>;
}):
  | { error: RolloutBodyError }
  | { ok: { patch: Record<string, unknown>; config: GatewayMutableConfig } } {
  const artifactFields = ["imageRepository", "imageTag"].filter((field) =>
    Object.prototype.hasOwnProperty.call(args.body, field),
  );
  if (artifactFields.length > 0) {
    return {
      error: {
        status: 409,
        body: {
          error: "image artifacts are immutable releases; use POST /api/admin/gateways/:id/releases",
          fields: artifactFields,
        },
      },
    };
  }
  if (Object.prototype.hasOwnProperty.call(args.body, "byosub")) {
    return {
      error: {
        status: 400,
        body: { error: "gateway credential references are user-scoped and cannot be patched here" },
      },
    };
  }
  const configPatch = mutableConfigPatchFromBody(args.body);
  const patch: Record<string, unknown> = { ...configPatch };
  if (args.body.desiredStatus !== undefined) {
    if (typeof args.body.desiredStatus !== "string") {
      return { error: { status: 400, body: { error: "desiredStatus must be a string" } } };
    }
    const desired = validateDesiredStatusPatch(args.body.desiredStatus);
    if ("error" in desired) return { error: desired.error };
    if (desired.ok === "draining") {
      return {
        error: {
          status: 400,
          body: { error: "durable gateway desiredStatus must be running or paused" },
        },
      };
    }
    patch.desiredStatus = desired.ok;
  }
  if (Object.keys(patch).length === 0) {
    return { error: { status: 400, body: { error: "no updatable fields provided" } } };
  }
  const config = { ...args.current, ...configPatch } as GatewayMutableConfig;
  if (!isGatewayMutableConfigForGateway(config, args.gatewayId)) {
    return {
      error: {
        status: 400,
        body: { error: "invalid durable gateway configuration", gatewayId: args.gatewayId },
      },
    };
  }
  return { ok: { patch, config } };
}

async function findConflictingGatewayOp(
  db: Firestore,
  gatewayId: string,
): Promise<{ id: string; kind: string | null } | null> {
  const pendingOps = await db
    .collection(GLM_OPERATIONS_COLLECTION)
    .where("status", "in", ["pending", "running"])
    .get();
  const conflicting = pendingOps.docs.find((d) => {
    const opData = d.data() as { input?: { gatewayId?: string } } | undefined;
    return opData?.input?.gatewayId === gatewayId;
  });
  if (!conflicting) return null;
  return {
    id: conflicting.id,
    kind: (conflicting.data() as { kind?: string } | undefined)?.kind ?? null,
  };
}

type RollbackReleaseResolution =
  | { error: RolloutBodyError }
  | {
      ok: {
        gateway: GatewayDoc;
        target: ReleaseDoc;
        artifact: GatewayArtifact;
        release: number;
        note: string;
      };
    };

async function resolveRollbackRelease(args: {
  db: Firestore;
  gatewayId: string;
  requestedRelease: string | string[] | undefined;
  body: Record<string, unknown>;
}): Promise<RollbackReleaseResolution> {
  const release = Number(args.requestedRelease);
  if (
    typeof args.requestedRelease !== "string" ||
    !Number.isInteger(release) ||
    release < 1
  ) {
    return {
      error: {
        status: 400,
        body: { error: "release must be a positive integer", got: args.requestedRelease },
      },
    };
  }
  const gateway = await readGatewayDoc(args.db, args.gatewayId);
  if (!gateway) {
    return {
      error: {
        status: 404,
        body: { error: ERR_GATEWAY_NOT_FOUND, gatewayId: args.gatewayId },
      },
    };
  }
  if (gateway.desiredStatus === "retired") {
    return {
      error: {
        status: 409,
        body: {
          error: "cannot cut a release for a retired gateway",
          gatewayId: args.gatewayId,
        },
      },
    };
  }
  const target = await readRelease(args.db, args.gatewayId, release);
  if (!target) {
    return {
      error: {
        status: 404,
        body: { error: "release not found", gatewayId: args.gatewayId, release },
      },
    };
  }
  const previous = await readRelease(args.db, args.gatewayId, gateway.latestRelease);
  if (!previous) {
    return {
      error: {
        status: 409,
        body: {
          error: "gateway has no current release artifact",
          gatewayId: args.gatewayId,
          latestRelease: gateway.latestRelease,
        },
      },
    };
  }
  const artifact = artifactFromRelease(target);
  const previousArtifact = artifactFromRelease(previous);
  if (!artifact || !previousArtifact) {
    return {
      error: {
        status: 409,
        body: {
          error: "gateway release artifact is malformed",
          gatewayId: args.gatewayId,
        },
      },
    };
  }
  if (sameArtifact(artifact, previousArtifact)) {
    return {
      error: {
        status: 409,
        body: {
          error: "gateway is already on release artifact — no-op rollback",
          gatewayId: args.gatewayId,
          release: gateway.latestRelease,
        },
      },
    };
  }
  const conflicting = await findConflictingGatewayOp(args.db, args.gatewayId);
  if (conflicting) {
    return {
      error: {
        status: 409,
        body: {
          error: ERR_GATEWAY_OPERATION_IN_FLIGHT,
          gatewayId: args.gatewayId,
          operationId: conflicting.id,
          kind: conflicting.kind,
        },
      },
    };
  }
  return {
    ok: {
      gateway,
      target,
      artifact,
      release,
      note:
        typeof args.body.note === "string"
          ? args.body.note
          : `rollback to release ${release}`,
    },
  };
}

async function ensureGatewayCreateIsUnique(
  db: Firestore,
  body: Pick<AddGatewayCreate, "gatewayId">,
): Promise<{ error: RolloutBodyError } | { ok: true }> {
  const [legacy, durable] = await Promise.all([
    db.collection(GLM_GATEWAYS_COLLECTION).doc(body.gatewayId).get(),
    db.collection(GATEWAYS_COLLECTION).doc(body.gatewayId).get(),
  ]);
  if (legacy.exists || durable.exists) {
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
          error: ERR_OWNER_USER_NOT_FOUND,
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

function operatorGatewayInitialReleaseFromReservation(opts: {
  body: FulfillOperatorReservationBody;
  reservation: FulfillableOperatorReservation;
  createdBy: string;
  now: number;
}): InitialGatewayReleaseArgs {
  return {
    gatewayId: opts.body.gatewayId,
    createdBy: opts.createdBy,
    now: opts.now,
    desiredStatus: "running",
    artifact: {
      imageRepository: opts.body.imageRepository,
      imageTag: opts.body.imageTag,
    },
    config: {
      configSchemaVersion: GATEWAY_CONFIG_SCHEMA_VERSION,
      profile: "operator",
      gatewayClass: "operator",
      imageProfile: "operator",
      sizingTier: opts.reservation.requestedSizingTier,
      computeClass: null,
      gcpProject: null,
      gatewayContainerSecurityContext: null,
      serviceAccountName: operatorGatewayServiceAccountName(opts.body.gatewayId),
      serviceAccount: OPERATOR_GATEWAY_LOCKED_SERVICE_ACCOUNT,
      operatorAccess: defaultOperatorGatewayAccess(opts.reservation.uid),
      ownerUid: opts.reservation.uid,
      coOwnerUids: [],
      builderSlug: opts.reservation.builderSlug,
      openclawOverrides: null,
      modelBrokerLimits: null,
      preemption: null,
    },
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

export function buildBuilderCandidates(opts: {
  users: BuilderCandidateDoc[];
  gatewayRoots: BuilderCandidateDoc[];
  reservations: BuilderCandidateDoc[];
  workspaceSlugsForUser: FleetRouterDeps["workspaceSlugsForUser"];
}): BuilderCandidate[] {
  const assigned = new Set<string>();

  for (const doc of opts.gatewayRoots) {
    const root = asDurableGatewayRoot(doc.data(), doc.id);
    if (!root) continue;
    const ownerUid = asStringOrNull(root.ownerUid);
    if (ownerUid) assigned.add(ownerUid);
    if (Array.isArray(root.coOwnerUids)) {
      for (const co of root.coOwnerUids) {
        if (typeof co === "string" && co.length > 0) assigned.add(co);
      }
    }
  }

  for (const doc of opts.reservations) {
    const status = asStringOrNull(doc.data().status);
    if (status !== "released") assigned.add(doc.id);
  }

  const candidates = opts.users.map((doc) => {
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
        const [gwSnap, glmSnap, settings] = await Promise.all([
          db.collection("gateways").get(),
          db.collection(GLM_GATEWAYS_COLLECTION).get(),
          readFleetRuntimeSettings(deps),
        ]);
        const glmByGatewayId = indexAdminGatewayRuntimeDocs({
          gatewayDocs: gwSnap.docs,
          glmDocs: glmSnap.docs,
        });
        const gatewayIds = new Set(glmByGatewayId.keys());
        const now = Date.now();
        const gateways = await Promise.all(
          [...gatewayIds].flatMap((gatewayId) => {
            const glmDoc = glmByGatewayId.get(gatewayId);
            if (projectDesiredStatus(glmDoc) === "retired") return [];
            const doc = effectiveHeartbeatDoc(gatewayId, glmDoc);
            if (!doc && !shouldProjectDesiredOnlyGateway(glmDoc)) return [];
            return [
              projectGatewaySummaryWithDiagnostics(
                deps,
                doc ?? syntheticGatewayDoc(gatewayId),
                glmDoc,
                now,
              ),
            ];
          }),
        );
        res.json({
          gateways,
          stats: rollupFleetStats(gateways),
          settings,
          namespace: resolveFleetNamespace(),
          generatedAt: new Date().toISOString(),
        });
      } catch (e) {
        next(e);
      }
    },
  );

router.patch(
    "/fleet-settings",
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const parsed = parseDedicatedGatewayIdlePatch(req.body as Record<string, unknown>);
        if ("error" in parsed) {
          res.status(parsed.error.status).json(parsed.error.body);
          return;
        }
        const actor = req as ActorRequest;
        await db.doc(FLEET_RUNTIME_CONFIG_DOC_PATH).set(
          {
            dedicatedGatewayIdleMs: parsed.ok,
            dedicatedGatewayIdleUpdatedAt: Date.now(),
            dedicatedGatewayIdleUpdatedBy: actor.uid ?? "unknown",
          },
          { merge: true },
        );
        res.json({ settings: await readFleetRuntimeSettings(deps) });
      } catch (e) {
        next(e);
      }
    },
  );

router.get(
    "/onboarding-placement",
    async (_req: Request, res: Response, next: NextFunction) => {
      try {
        res.json(await readAdminOnboardingPlacementResponse(deps));
      } catch (e) {
        next(e);
      }
    },
  );

router.patch(
    "/onboarding-placement",
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const gatewaySnap = await db.collection(GATEWAYS_COLLECTION).get();
        const parsed = parsePlacementPatch(
          req.body as Record<string, unknown>,
          indexDurableGatewayRoots(gatewaySnap.docs),
        );
        if ("error" in parsed) {
          res.status(parsed.error.status).json(parsed.error.body);
          return;
        }
        const actor = req as ActorRequest;
        await db.doc(FLEET_RUNTIME_CONFIG_DOC_PATH).set(
          {
            defaultGatewayId: parsed.ok.defaultGatewayId,
            placementUpdatedAt: Date.now(),
            placementUpdatedBy: actor.uid ?? "unknown",
          },
          { merge: true },
        );
        res.json(await readAdminOnboardingPlacementResponse(deps));
      } catch (e) {
        next(e);
      }
    },
  );

router.put(
    "/onboarding-placement/overrides/by-slug/:slug",
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const slug = req.params.slug as string;
        const gatewayId = asStringOrNull((req.body as Record<string, unknown>).gatewayId);
        if (!gatewayId) {
          res.status(400).json({ error: "gatewayId is required" });
          return;
        }
        const gatewaySnap = await db.collection(GATEWAYS_COLLECTION).get();
        const gatewayError = validatePlacementGateway(
          gatewayId,
          indexDurableGatewayRoots(gatewaySnap.docs),
        );
        if (gatewayError) {
          res.status(gatewayError.status).json(gatewayError.body);
          return;
        }
        const uid = await resolveUidForSlug(db, slug);
        if (!uid) {
          res.status(404).json({ error: "builder slug not found", slug });
          return;
        }
        const config = await readOnboardingRuntimeConfig(deps);
        const actor = req as ActorRequest;
        await db.doc(FLEET_RUNTIME_CONFIG_DOC_PATH).set(
          {
            overrides: { ...(config.overrides ?? {}), [uid]: gatewayId },
            placementUpdatedAt: Date.now(),
            placementUpdatedBy: actor.uid ?? "unknown",
          },
          { merge: true },
        );
        res.json(await readAdminOnboardingPlacementResponse(deps));
      } catch (e) {
        next(e);
      }
    },
  );

router.put(
    "/onboarding-placement/overrides/:uid",
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const uid = req.params.uid as string;
        const gatewayId = asStringOrNull((req.body as Record<string, unknown>).gatewayId);
        if (!gatewayId) {
          res.status(400).json({ error: "gatewayId is required" });
          return;
        }
        const [gatewaySnap, userSnap, config] = await Promise.all([
          db.collection(GATEWAYS_COLLECTION).get(),
          db.collection("users").doc(uid).get(),
          readOnboardingRuntimeConfig(deps),
        ]);
        const gatewayError = validatePlacementGateway(
          gatewayId,
          indexDurableGatewayRoots(gatewaySnap.docs),
        );
        if (gatewayError) {
          res.status(gatewayError.status).json(gatewayError.body);
          return;
        }
        if (!userSnap.exists) {
          res.status(404).json({ error: "user not found", uid });
          return;
        }
        const actor = req as ActorRequest;
        await db.doc(FLEET_RUNTIME_CONFIG_DOC_PATH).set(
          {
            overrides: { ...(config.overrides ?? {}), [uid]: gatewayId },
            placementUpdatedAt: Date.now(),
            placementUpdatedBy: actor.uid ?? "unknown",
          },
          { merge: true },
        );
        res.json(await readAdminOnboardingPlacementResponse(deps));
      } catch (e) {
        next(e);
      }
    },
  );

router.delete(
    "/onboarding-placement/overrides/:uid",
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const uid = req.params.uid as string;
        const config = await readOnboardingRuntimeConfig(deps);
        const nextOverrides = { ...(config.overrides ?? {}) };
        delete nextOverrides[uid];
        const actor = req as ActorRequest;
        await db.doc(FLEET_RUNTIME_CONFIG_DOC_PATH).set(
          {
            overrides: nextOverrides,
            placementUpdatedAt: Date.now(),
            placementUpdatedBy: actor.uid ?? "unknown",
          },
          { merge: true },
        );
        res.json(await readAdminOnboardingPlacementResponse(deps));
      } catch (e) {
        next(e);
      }
    },
  );

  router.post(
    "/gateway-migrations/bulk",
    // eslint-disable-next-line complexity, sonarjs/cognitive-complexity -- Linear admin repair route validates input, adopts existing ops, or enqueues one result per uid.
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const body = req.body as Partial<{
          uids: unknown;
          toGatewayId: unknown;
          targetGatewayId: unknown;
          sourceGatewayId: unknown;
        }>;
        const uids = Array.isArray(body.uids)
          ? body.uids.filter((uid): uid is string => typeof uid === "string" && uid.length > 0)
          : [];
        const toGatewayId = asStringOrNull(body.toGatewayId) ?? asStringOrNull(body.targetGatewayId);
        const sourceGatewayId = asStringOrNull(body.sourceGatewayId);
        if (!toGatewayId) {
          res.status(400).json({ error: "toGatewayId is required" });
          return;
        }
        if (uids.length === 0) {
          res.status(400).json({ error: "uids must contain at least one uid" });
          return;
        }

        // Registration is either doc; readiness comes from the relocated
        // glmGateways/{id}.heartbeat (cutover step 2), not the flat status.
        const target = await readGatewayRegistrationReadiness(db, toGatewayId);
        if (!target.registered) {
          res.status(404).json({ error: "target gateway not registered", gatewayId: toGatewayId });
          return;
        }
        if (target.status !== "ready") {
          res.status(409).json({
            error: "target gateway not ready",
            gatewayId: toGatewayId,
            status: target.status ?? "unknown",
          });
          return;
        }

        const pendingOps = await db
          .collection(GLM_OPERATIONS_COLLECTION)
          .where("status", "in", ["pending", "running"])
          .get();
        const actor = req as ActorRequest;
        const createdBy = actor.uid ?? "unknown";
        const enqueued: Array<{ uid: string; operationId: string }> = [];
        const adopted: Array<{ uid: string; operationId: string }> = [];
        const rejected: Array<{ uid: string; reason: string; currentGatewayId?: string | null }> = [];

        for (const uid of [...new Set(uids)]) {
          const userSnap = await db.collection("users").doc(uid).get();
          if (!userSnap.exists) {
            rejected.push({ uid, reason: "user-not-found" });
            continue;
          }
          const userData = userSnap.data() as Record<string, unknown> | undefined;
          const currentGatewayId = readUserGatewayId(userData);
          const builderSlug = userData
            ? resolveCustomerSlug(userData, deps.workspaceSlugsForUser)
            : null;
          if (currentGatewayId === toGatewayId) {
            rejected.push({ uid, reason: "already-on-target", currentGatewayId });
            continue;
          }
          if (sourceGatewayId && currentGatewayId !== sourceGatewayId) {
            rejected.push({ uid, reason: "source-gateway-mismatch", currentGatewayId });
            continue;
          }
          const existing = pendingOps.docs.find((doc) => {
            const data = doc.data() as Record<string, unknown>;
            const input = isPlainRecord(data.input) ? data.input : {};
            return (
              data.kind === OP_KIND_MIGRATE_CUSTOMER &&
              (data.inputUid === uid || input.uid === uid) &&
              input.toGatewayId === toGatewayId
            );
          });
          if (existing) {
            adopted.push({ uid, operationId: existing.id });
            continue;
          }
          const operationId = await createOperation(db, {
            kind: OP_KIND_MIGRATE_CUSTOMER,
            createdBy,
            input: {
              uid,
              ...(builderSlug ? { builderSlug } : {}),
              ...(currentGatewayId ? { fromGatewayId: currentGatewayId } : {}),
              toGatewayId,
              source: "admin-bulk-repair",
            },
          });
          enqueued.push({ uid, operationId });
        }

        res.status(202).json({
          targetGatewayId: toGatewayId,
          sourceGatewayId: sourceGatewayId ?? null,
          enqueued,
          adopted,
          rejected,
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
        const [gwSnap, glmSnap, usersSnap] = await Promise.all([
          db.collection("gateways").get(),
          db.collection(GLM_GATEWAYS_COLLECTION).get(),
          db.collection("users").get(),
        ]);

        const legacyById = indexFirestoreDocs(gwSnap.docs);
        const glmById = indexAdminGatewayRuntimeDocs({
          gatewayDocs: gwSnap.docs,
          glmDocs: glmSnap.docs,
        });
        const gateways = new Map<
          string,
          {
            status: string;
            mountedCustomers: Set<string>;
            mountedCount: number;
          }
        >();
        for (const gatewayId of new Set([...glmById.keys(), ...legacyById.keys()])) {
          const hb = effectiveHeartbeatDoc(gatewayId, glmById.get(gatewayId))?.data();
          const mounted = [...readMountedSlugs(hb)];
          gateways.set(gatewayId, {
            status: typeof hb?.status === "string" ? hb.status : "unknown",
            mountedCustomers: new Set(mounted),
            mountedCount: mounted.length,
          });
        }

        const assignedByGateway = new Map<string, number>();
        const mountedByGateway = new Map<string, number>();
        const pendingPlacements: PendingPlacement[] = [];
        let totalBuilders = 0;
        let assigned = 0;
        let unassigned = 0;
        let mounted = 0;

        for (const doc of usersSnap.docs) {
          const data = doc.data() as Record<string, unknown>;
          if (!userSlug(data)) continue;
          totalBuilders++;
          const placement = classifyUserPlacement(
            doc.id,
            data,
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
            totalBuilders,
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
        const [runtime, usersSnap, opsSnap] = await Promise.all([
          readDurableGatewayRuntime(db, id),
          db.collection("users").get(),
          db
            .collection(GLM_OPERATIONS_COLLECTION)
            .where("gatewayId", "==", id)
            .limit(50)
            .get(),
        ]);
        if (!runtime) {
          res
            .status(404)
            .json({ error: ERR_GATEWAY_NOT_FOUND, gatewayId: id });
          return;
        }
        const mountedSlugs = readMountedSlugs(runtime.heartbeat ?? {});

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
        const [usersSnap, gatewaySnap, reservationsSnap] = await Promise.all([
          db.collection("users").get(),
          db.collection(GATEWAYS_COLLECTION).get(),
          db.collection(OPERATOR_GATEWAY_RESERVATIONS_COLLECTION).get(),
        ]);
        const candidates = buildBuilderCandidates({
          users: usersSnap.docs,
          gatewayRoots: gatewaySnap.docs,
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
        const userRef = db.collection("users").doc(uid);
        const [reservationSnap, userSnap] = await Promise.all([
          reservationRef.get(),
          userRef.get(),
        ]);
        if (!reservationSnap.exists) {
          res.status(404).json({
            error: "operator gateway reservation not found",
            uid,
          });
          return;
        }
        if (!userSnap.exists) {
          res.status(404).json({ error: ERR_OWNER_USER_NOT_FOUND, uid });
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

        const [target, pendingOpsSnap] = await Promise.all([
          readDurableGatewayRuntime(db, reservation.ok.gatewayId),
          db
            .collection(GLM_OPERATIONS_COLLECTION)
            .where("status", "in", ["pending", "running"])
            .get(),
        ]);
        if (!target) {
          res.status(404).json({
            error: "reserved gateway desired state not found",
            gatewayId: reservation.ok.gatewayId,
          });
          return;
        }
        const ownershipError = validateOperatorGatewayOwnership({
          uid,
          reservation: reservation.ok,
          gatewayData: target.root as unknown as Record<string, unknown>,
        });
        if (ownershipError) {
          res.status(ownershipError.status).json(ownershipError.body);
          return;
        }
        if (target.root.desiredStatus === "retired") {
          res.status(409).json({
            error: "reserved gateway is retired",
            gatewayId: reservation.ok.gatewayId,
          });
          return;
        }
        const reservedHb = target.heartbeat;
        if (!reservedHb) {
          res.status(409).json({
            error: "reserved gateway has not reported ready yet",
            gatewayId: reservation.ok.gatewayId,
            status: "missing",
          });
          return;
        }
        const targetStatus = asStringOrNull(reservedHb.status);
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
          ...(currentGatewayId ? { fromGatewayId: currentGatewayId } : {}),
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
          kind: OP_KIND_MIGRATE_CUSTOMER,
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
        const userData = (userSnap.data() ?? {}) as {
          provisioning?: { openclaw?: { gatewayId?: string; gatewayProfile?: unknown } };
        };
        const target = await readDurableGatewayRuntime(db, body.gatewayId);
        if (!target) {
          res.status(404).json({
            error: ERR_GATEWAY_NOT_FOUND,
            gatewayId: body.gatewayId,
          });
          return;
        }
        if (target.root.desiredStatus !== "running") {
          res.status(409).json({
            error: "target gateway not ready",
            gatewayId: body.gatewayId,
            status: target.root.desiredStatus,
          });
          return;
        }
        const targetStatus = asStringOrNull(target.heartbeat?.status);
        if (targetStatus !== "ready") {
          res.status(409).json({
            error: "target gateway not ready",
            gatewayId: body.gatewayId,
            status: targetStatus ?? "unknown",
          });
          return;
        }
        const currentGid = userData.provisioning?.openclaw?.gatewayId;
        const shellState = resolveUserGatewayShellState(
          {
            gatewayClass: target.root.gatewayClass,
            profile: target.root.profile ?? undefined,
            imageProfile: target.root.imageProfile,
            ownerUid: target.root.ownerUid ?? undefined,
            coOwnerUids: target.root.coOwnerUids,
            operatorAccess: target.root.operatorAccess ?? undefined,
          },
          uid,
        );
        const gatewayProfile = shellState.gatewayProfile;
        // Mirror AND the revision assignment doc commit together
        // (commitPlacementAtomic): on a backfilled gateway the customer gets a
        // serving assignment on the resolved revision instead of being left a
        // gap user; a legacy gateway keeps the mirror-only update byte-for-byte.
        const slug =
          resolveCustomerSlug(userData as Record<string, unknown>, deps.workspaceSlugsForUser);
        if (!slug) {
          res.status(409).json({
            error: "customer has no canonical slug",
            uid,
          });
          return;
        }
        const placement = await commitPlacementAtomic(db as unknown as PlacementFirestore, {
          uid,
          slug,
          gatewayId: body.gatewayId,
          source: "repair",
          now: Date.now(),
          assignmentWrite: currentGid === body.gatewayId ? "create-if-missing" : "upsert",
          mirrorPatch: {
            "provisioning.openclaw.gatewayId": body.gatewayId,
            "provisioning.openclaw.gatewayProfile": gatewayProfile,
            "provisioning.openclaw.shellsEnabled": shellState.shellsEnabled,
          },
        });
        if (placement.kind === "rejected") {
          res.status(409).json({
            error: `target revision not placeable: ${placement.reason}`,
            gatewayId: body.gatewayId,
            reason: placement.reason,
          });
          return;
        }
        res.status(currentGid === body.gatewayId ? 200 : 202).json({
          uid,
          gatewayId: body.gatewayId,
          gatewayProfile,
          ...(currentGid === body.gatewayId ? { repaired: true } : {}),
        });
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
        const userRef = db.collection("users").doc(uid);
        const [reservationSnap, userSnap] = await Promise.all([
          reservationRef.get(),
          userRef.get(),
        ]);
        if (!reservationSnap.exists) {
          res.status(404).json({
            error: "operator gateway reservation not found",
            uid,
          });
          return;
        }
        if (!userSnap.exists) {
          res.status(404).json({ error: ERR_OWNER_USER_NOT_FOUND, uid });
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
        const initial = operatorGatewayInitialReleaseFromReservation({
          body,
          reservation: reservation.ok,
          createdBy,
          now,
        });
        try {
          await writeInitialGatewayRelease(db, {
            ...initial,
            validateAdditional: async (transaction) => {
              const [currentReservationSnap, currentUserSnap] = await Promise.all([
                transaction.get(reservationRef),
                transaction.get(userRef),
              ]);
              if (!currentReservationSnap.exists) {
                throw new InitialGatewayReleaseRequestError(404, {
                  error: "operator gateway reservation not found",
                  uid,
                });
              }
              if (!currentUserSnap.exists) {
                throw new InitialGatewayReleaseRequestError(404, {
                  error: ERR_OWNER_USER_NOT_FOUND,
                  uid,
                });
              }
              const currentReservation = validateFulfillableOperatorReservation(
                uid,
                currentReservationSnap.data() as Record<string, unknown>,
              );
              if ("error" in currentReservation) {
                throw new InitialGatewayReleaseRequestError(
                  currentReservation.error.status,
                  currentReservation.error.body,
                );
              }
              if (
                currentReservation.ok.builderSlug !== reservation.ok.builderSlug ||
                currentReservation.ok.requestedSizingTier !== reservation.ok.requestedSizingTier ||
                currentReservation.ok.requestedAt !== reservation.ok.requestedAt
              ) {
                throw new InitialGatewayReleaseRequestError(409, {
                  error: "operator gateway reservation changed during fulfillment",
                  uid,
                });
              }
            },
            writeAdditional: (transaction) => {
              transaction.set(
                opRef,
                addGatewayOperationRecord({
                  createdBy,
                  now,
                  input: operationInput,
                }),
              );
              transaction.update(reservationRef, reservationUpdate);
              transaction.update(userRef, {
                "operatorGatewayReservation.status": "provisioning",
                "operatorGatewayReservation.gatewayId": body.gatewayId,
                "operatorGatewayReservation.operationId": operationId,
                "operatorGatewayReservation.provisioningStartedAt": now,
                "operatorGatewayReservation.provisioningStartedBy": createdBy,
                "operatorGatewayReservation.updatedAt": now,
              });
            },
          });
        } catch (e) {
          if (e instanceof InitialGatewayReleaseConflictError) {
            res.status(409).json({
              error: "gateway already exists",
              gatewayId: e.gatewayId,
            });
            return;
          }
          if (e instanceof InitialGatewayReleaseRequestError) {
            res.status(e.status).json(e.body);
            return;
          }
          throw e;
        }

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

        const persistenceError = rejectPersistenceInBody(
          (req.body ?? {}) as Record<string, unknown>,
        );
        if (persistenceError) {
          res.status(persistenceError.status).json(persistenceError.body);
          return;
        }
        if (Object.prototype.hasOwnProperty.call(req.body ?? {}, "byosub")) {
          res.status(400).json({
            error: "gateway credential references are user-scoped and cannot be created here",
          });
          return;
        }

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
        const ownerRuntimeDefaults: { operatorAccess?: OperatorGatewayAccessSpec } =
          gatewayClass === "builder" || gatewayClass === "operator"
            ? {
                operatorAccess: defaultOperatorGatewayAccess(owner.ok.ownerUid),
              }
            : {};
        const operatorDefaults: {
          serviceAccountName?: string;
          serviceAccount?: GatewayServiceAccountSpec;
        } =
          gatewayClass === "operator"
            ? {
                serviceAccountName: operatorGatewayServiceAccountName(body.gatewayId),
                serviceAccount: OPERATOR_GATEWAY_LOCKED_SERVICE_ACCOUNT,
              }
            : {};
        try {
          await writeInitialGatewayRelease(db, {
            gatewayId: body.gatewayId,
            createdBy,
            now,
            desiredStatus: "running",
            config: buildCreateGatewayConfig({
              body,
              gatewayClass,
              imageProfile,
              ownerUid: owner.ok.ownerUid,
              builderSlug: owner.ok.builderSlug,
              operatorAccess: ownerRuntimeDefaults.operatorAccess,
              serviceAccountName: operatorDefaults.serviceAccountName,
              serviceAccount: operatorDefaults.serviceAccount,
            }),
            artifact: buildCreateArtifact(body),
          });
        } catch (e) {
          if (e instanceof InitialGatewayReleaseConflictError) {
            res.status(409).json({
              error: "gateway already exists",
              gatewayId: e.gatewayId,
            });
            return;
          }
          throw e;
        }
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
        const body = (req.body ?? {}) as Record<string, unknown>;
        const rootRef = db.collection(GATEWAYS_COLLECTION).doc(id);
        const rootSnap = await rootRef.get();
        const rootData = rootSnap.exists
          ? (rootSnap.data() as Record<string, unknown> | undefined)
          : undefined;
        if (!rootSnap.exists) {
          res.status(404).json({ error: ERR_GATEWAY_NOT_FOUND, gatewayId: id });
          return;
        }
        const root = asDurableGatewayRoot(rootData, id);
        if (!root) {
          const invalidRoot = hasDurableGatewayRootMarkers(rootData);
          res
            .status(invalidRoot ? 409 : 404)
            .json({
              error: invalidRoot ? "gateway durable root is invalid" : ERR_GATEWAY_NOT_FOUND,
              gatewayId: id,
            });
          return;
        }
        const built = buildDurableGatewayPatch({
          gatewayId: id,
          current: root,
          body,
        });
        if ("error" in built) {
          res.status(built.error.status).json(built.error.body);
          return;
        }
        const ownerError = await validateGatewayConfigOwner(db, root, built.ok.config);
        if (ownerError) {
          res.status(ownerError.status).json(ownerError.body);
          return;
        }
        const updatedBy = (req as ActorRequest).uid ?? "unknown";
        const patchResult = await db.runTransaction(async (txn) => {
          const currentSnap = await txn.get(rootRef);
          const currentData = currentSnap.exists
            ? (currentSnap.data() as Record<string, unknown> | undefined)
            : undefined;
          const current = asDurableGatewayRoot(currentData, id);
          if (!current) return { ok: false as const, error: ERR_GATEWAY_NOT_FOUND };
          if (current.desiredStatus === "retired" || current.retirementClaim != null) {
            return {
              ok: false as const,
              error: "gateway has a current retirement claim",
            };
          }
          txn.update(rootRef, {
            ...built.ok.patch,
            updatedAt: Date.now(),
            updatedBy,
          });
          return { ok: true as const };
        });
        if (!patchResult.ok) {
          res.status(409).json({ error: patchResult.error, gatewayId: id });
          return;
        }
        res.status(202).json({ gatewayId: id, updated: Object.keys(built.ok.patch) });
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
        const runtime = await readDurableGatewayRuntime(db, id);
        if (!runtime) {
          res
            .status(404)
            .json({ error: ERR_GATEWAY_NOT_FOUND, gatewayId: id });
          return;
        }
        if (runtime.root.liveRevisionId && !runtime.revision) {
          res.status(409).json({
            error: "gateway live revision telemetry is unavailable",
            gatewayId: id,
            revisionId: runtime.root.liveRevisionId,
          });
          return;
        }
        if (runtime.root.roll) {
          res.status(409).json({
            error: "gateway has an unfinished release roll and config obligation",
            gatewayId: id,
            operationId: runtime.root.roll.operationId,
          });
          return;
        }
        if (hasGatewayRetirementConfigObligation(runtime.heartbeat?.configStatus)) {
          res.status(409).json({
            error: "gateway live revision has an active config-control obligation",
            gatewayId: id,
            revisionId: runtime.root.liveRevisionId,
          });
          return;
        }
        // Refuse synchronously while any customer is still assigned — the
        // controller's retire arm enforces the same gate, but a 409 here spares
        // the operator a marked-retired-then-blocked gateway.
        const assignments = await readAssignmentDocsForGateway(db, id);
        if (assignments.length > 0) {
          res.status(409).json({
            error:
              "gateway still has assigned customers; migrate them off before retiring",
            gatewayId: id,
            assignedCustomers: assignments.map((a) => a.slug),
          });
          return;
        }
        const mounted = [...readMountedSlugs(runtime.heartbeat ?? undefined)];
        if (mounted.length > 0) {
          res.status(409).json({
            error:
              "gateway still has mounted customers; migrate them off before retiring",
            gatewayId: id,
            mountedCustomers: mounted,
          });
          return;
        }

        const opRef = db.collection(GLM_OPERATIONS_COLLECTION).doc();
        const operationId = opRef.id;
        const createdAt = Date.now();
        try {
          await claimGatewayRetirementAtomic({
            db,
            gatewayId: id,
            operationId,
            operation: {
              kind: "retire-gateway",
              status: "pending",
              createdBy,
              createdAt,
              startedAt: null,
              completedAt: null,
              input: {
                gatewayId: id,
                ...(retainData ? { retainData: true } : {}),
                ...(retainServiceAccount ? { retainServiceAccount: true } : {}),
              },
              steps: [],
              gatewayId: id,
            },
            now: createdAt,
            updatedBy: createdBy,
          });
        } catch (error) {
          if (error instanceof GatewayRetirementConflictError) {
            res.status(409).json({ error: error.message, gatewayId: id });
            return;
          }
          throw error;
        }
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
        const gateway = await readGatewayDoc(db, id);
        if (!gateway) {
          res
            .status(404)
            .json({ error: ERR_GATEWAY_NOT_FOUND, gatewayId: id });
          return;
        }
        if (gateway.desiredStatus === "retired") {
          res.status(409).json({ error: "cannot restart a retired gateway", gatewayId: id });
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
            error: ERR_GATEWAY_OPERATION_IN_FLIGHT,
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

  // Recovery visibility: every assignment pointing at a revision the durable
  // root no longer references (live/traffic/roll/desired). Such customers can
  // never be settled by a roll — they are reset to pending placement via
  // /customers/:uid/unassign, which recognizes the same stranded condition.
  router.get(
    "/gateways/:id/stranded-assignments",
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const id = req.params.id as string;
        const gateway = await readGatewayDoc(db, id);
        if (!gateway) {
          res.status(404).json({ error: ERR_GATEWAY_NOT_FOUND, gatewayId: id });
          return;
        }
        const referenced = rootReferencedRevisionIds(gateway);
        const snap = await db
          .collection(GATEWAYS_COLLECTION)
          .doc(id)
          .collection(GATEWAY_ASSIGNMENTS_SUBCOLLECTION)
          .get();
        const stranded: Array<{
          uid: string;
          slug: string;
          revisionId: string;
          state: AssignmentState;
          epoch: number;
        }> = [];
        const malformed: string[] = [];
        for (const doc of snap.docs) {
          const assignment = parseAssignmentDoc(
            doc.id,
            doc.data() as Record<string, unknown> | undefined,
          );
          if (!assignment || assignment.gatewayId !== id) {
            malformed.push(doc.id);
            continue;
          }
          if (referenced.has(assignment.revisionId)) continue;
          stranded.push({
            uid: assignment.uid,
            slug: assignment.slug,
            revisionId: assignment.revisionId,
            state: assignment.state,
            epoch: assignment.epoch,
          });
        }
        res.json({ gatewayId: id, stranded, malformed });
      } catch (e) {
        next(e);
      }
    },
  );

  async function guardedRetireRefusal(
    firestore: Firestore,
    id: string,
    revisionId: string,
    revisionData: RevisionRealizationDoc,
  ): Promise<{ status: number; body: Record<string, unknown> } | null> {
    if (revisionData.lifecycle === "retired") {
      return {
        status: 409,
        body: { error: "revision is already retired", gatewayId: id, revisionId },
      };
    }
    const mounted = [
      ...readMountedSlugs(
        isPlainRecord(revisionData.heartbeat) ? revisionData.heartbeat : undefined,
      ),
    ];
    if (mounted.length > 0) {
      return {
        status: 409,
        body: {
          error: "revision still reports mounted customers",
          gatewayId: id,
          revisionId,
          mounted,
        },
      };
    }
    const assignments = await readAssignmentDocsForGateway(firestore, id);
    const uids = assignments
      .filter((assignment) => assignment.revisionId === revisionId)
      .map((assignment) => assignment.uid);
    if (uids.length > 0) {
      return {
        status: 409,
        body: {
          error:
            "assignments still reference this revision — reset them to pending placement (or migrate them) first",
          gatewayId: id,
          revisionId,
          uids,
        },
      };
    }
    const pendingOps = await firestore
      .collection(GLM_OPERATIONS_COLLECTION)
      .where("status", "in", ["pending", "running"])
      .get();
    const conflicting = pendingOps.docs.find((d) => {
      const opData = d.data() as { input?: { gatewayId?: string } } | undefined;
      return opData?.input?.gatewayId === id;
    });
    if (conflicting) {
      return {
        status: 409,
        body: {
          error: ERR_GATEWAY_OPERATION_IN_FLIGHT,
          gatewayId: id,
          operationId: conflicting.id,
          kind: (conflicting.data() as { kind?: string } | undefined)?.kind ?? null,
        },
      };
    }
    return null;
  }

  // Recovery-only, revision-scoped retire of a TRUE ORPHAN (r4 class): a
  // revision the durable root no longer references with zero assignments and
  // zero mounts. Enqueues a retire-revision op; Cowboy's handler re-validates
  // every guard at claim time and performs the helm uninstall + tombstone +
  // revision-doc retire. Never touches the gateway root or other revisions.
  router.post(
    "/gateways/:id/revisions/:revisionId/retire",
    // eslint-disable-next-line complexity -- linear guard ladder; each refusal returns its own operator-facing response.
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const id = req.params.id as string;
        const revisionId = req.params.revisionId as string;
        // Operator break-glass: skip the referenced/mounted/assignment/in-flight
        // guards. The handler nukes a still-referenced revision (helm uninstall
        // only — the renderer re-creates it) and fully retires an unreferenced one.
        const breakGlass =
          (req.body as { breakGlass?: unknown } | undefined)?.breakGlass === true;
        const releaseSuffix = revisionId.startsWith(`${id}-r`)
          ? revisionId.slice(id.length + 2)
          : "";
        if (!/^[1-9]\d*$/u.test(releaseSuffix)) {
          res.status(400).json({
            error: "revisionId is not a revision of this gateway",
            gatewayId: id,
            revisionId,
          });
          return;
        }
        const gateway = await readGatewayDoc(db, id);
        if (!gateway) {
          res.status(404).json({ error: ERR_GATEWAY_NOT_FOUND, gatewayId: id });
          return;
        }
        if (isGatewayLegacyBackfill(gateway.legacyBackfill)) {
          res.status(409).json({
            error: "legacy backfill bridge is active — resolve it before revision recovery",
            gatewayId: id,
          });
          return;
        }
        if (!breakGlass && rootReferencedRevisionIds(gateway).has(revisionId)) {
          res.status(409).json({
            error: "revision is referenced by the durable root (live/traffic/roll/desired)",
            gatewayId: id,
            revisionId,
          });
          return;
        }
        const revisionSnap = await db
          .collection(GLM_GATEWAYS_COLLECTION)
          .doc(revisionId)
          .get();
        const revisionData = revisionSnap.exists ? revisionSnap.data() : undefined;
        if (
          !isRevisionRealizationDoc(revisionData) ||
          revisionData.gateway !== id ||
          revisionData.revisionId !== revisionId ||
          revisionId !== revisionIdForRelease(id, revisionData.release)
        ) {
          res.status(404).json({
            error: "revision not found for this gateway",
            gatewayId: id,
            revisionId,
          });
          return;
        }
        if (!breakGlass) {
          const refusal = await guardedRetireRefusal(db, id, revisionId, revisionData);
          if (refusal) {
            res.status(refusal.status).json(refusal.body);
            return;
          }
        }
        const actor = req as ActorRequest;
        const operationId = await createOperation(db, {
          kind: "retire-revision",
          createdBy: actor.uid ?? "unknown",
          input: { gatewayId: id, revisionId, ...(breakGlass ? { breakGlass: true } : {}) },
        });
        res.status(202).json({
          gatewayId: id,
          revisionId,
          operationId,
          ...(breakGlass ? { breakGlass: true } : {}),
        });
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
        if (profile || gatewayClass || imageProfile) {
          res.status(400).json({
            error: "gateway configuration is mutable; update it with PATCH /api/admin/gateways/:id",
            fields: [
              ...(profile ? ["profile"] : []),
              ...(gatewayClass ? ["gatewayClass"] : []),
              ...(imageProfile ? ["imageProfile"] : []),
            ],
          });
          return;
        }

        const current = await readRolloutCurrentConfig(db, id);
        if (!current) {
          res
            .status(404)
            .json({ error: ERR_GATEWAY_NOT_FOUND, gatewayId: id });
          return;
        }
        const rolloutGateway = current.gateway;
        if (rolloutGateway?.desiredStatus === "retired") {
          res.status(409).json({
            error: "cannot roll out a retired gateway",
            gatewayId: id,
          });
          return;
        }
        const artifact = currentArtifactPatch(current.artifact, {
          imageTag,
          ...(imageRepository ? { imageRepository } : {}),
        });
        if (sameArtifact(current.artifact, artifact)) {
          res.status(409).json({
            error: "gateway already on requested image — no-op rollout",
            gatewayId: id,
            imageTag,
            imageRepository: artifact.imageRepository,
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
            error: ERR_GATEWAY_OPERATION_IN_FLIGHT,
            gatewayId: id,
            operationId: conflicting.id,
            kind:
              (conflicting.data() as { kind?: string } | undefined)?.kind ??
              null,
          });
          return;
        }

        const actor = req as ActorRequest;
        const patch: ArtifactPatchInput = { imageTag };
        if (imageRepository) patch.imageRepository = imageRepository;
        let recorded: { release?: number; operationId: string };
        try {
          recorded = await recordRolloutRelease(db, {
            gateway: rolloutGateway,
            patch,
            createdBy: actor.uid ?? "unknown",
          });
        } catch (e) {
          if (respondReleaseWriteConflict(res, e)) return;
          throw e;
        }
        res
          .status(202)
          .json({ gatewayId: id, operationId: recorded.operationId, ...(recorded.release ? { release: recorded.release } : {}) });
      } catch (e) {
        next(e);
      }
    },
  );

  router.get(
    "/gateways/:id/releases",
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const id = req.params.id as string;
        const gateway = await readGatewayDoc(db, id);
        if (!gateway) {
          res.status(404).json({ error: ERR_GATEWAY_NOT_FOUND, gatewayId: id });
          return;
        }
        const snap = await db
          .collection(GATEWAYS_COLLECTION)
          .doc(id)
          .collection(GATEWAY_RELEASES_SUBCOLLECTION)
          .orderBy("release", "desc")
          .get();
        const docs = snap.docs.map((d) => d.data() as ReleaseDoc);
        const history = projectReleaseHistory({ gateway, releases: docs });
        const payloadByRelease = new Map(docs.map((r) => [r.release, r.payload]));
        const releases = history.map((entry) => ({
          ...entry,
          payload: payloadByRelease.get(entry.release) ?? null,
        }));
        res.json({
          gatewayId: id,
          latestRelease: gateway.latestRelease,
          desiredRelease: gateway.desiredRelease,
          liveRelease: gateway.liveRelease,
          releases,
        });
      } catch (e) {
        next(e);
      }
    },
  );

  router.post(
    "/gateways/:id/releases",
    // eslint-disable-next-line complexity
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const id = req.params.id as string;
        const actor = req as ActorRequest;
        const createdBy = actor.uid ?? "unknown";
        const now = Date.now();
        const body = (req.body ?? {}) as Record<string, unknown>;

        const gateway = await readGatewayDoc(db, id);
        if (!gateway) {
          res.status(404).json({ error: ERR_GATEWAY_NOT_FOUND, gatewayId: id });
          return;
        }
        if (gateway.desiredStatus === "retired") {
          res.status(409).json({
            error: "cannot cut a release for a retired gateway",
            gatewayId: id,
          });
          return;
        }
        const persistenceError = rejectPersistenceInBody(body);
        if (persistenceError) {
          res.status(persistenceError.status).json(persistenceError.body);
          return;
        }
        const patch = artifactPatchFromBody(body);
        if ("error" in patch) {
          res.status(patch.error.status).json(patch.error.body);
          return;
        }
        const prev = await readRelease(db, id, gateway.latestRelease);
        if (!prev) {
          res.status(409).json({
            error: "gateway has no release artifact to base a new release on",
            gatewayId: id,
            latestRelease: gateway.latestRelease,
          });
          return;
        }
        const previousArtifact = artifactFromRelease(prev);
        if (!previousArtifact) {
          res.status(409).json({
            error: "gateway has an invalid current release artifact",
            gatewayId: id,
            latestRelease: gateway.latestRelease,
          });
          return;
        }
        const artifact = currentArtifactPatch(previousArtifact, patch.ok);
        const validation = validateArtifact(artifact);
        if (validation) {
          res.status(validation.status).json(validation.body);
          return;
        }
        if (sameArtifact(previousArtifact, artifact)) {
          res.status(409).json({
            error: "release artifact is identical to the current release — no-op",
            gatewayId: id,
            release: gateway.latestRelease,
          });
          return;
        }
        const conflicting = await findConflictingGatewayOp(db, id);
        if (conflicting) {
          res.status(409).json({
            error: ERR_GATEWAY_OPERATION_IN_FLIGHT,
            gatewayId: id,
            operationId: conflicting.id,
            kind: conflicting.kind,
          });
          return;
        }
        const note = typeof body.note === "string" ? body.note : null;
        let appended: { release: number; operationId: string | null };
        try {
          appended = await appendGatewayRelease(db, {
            gateway,
            artifact,
            createdBy,
            now,
            sourceRelease: gateway.latestRelease,
            note,
          });
        } catch (e) {
          if (respondReleaseWriteConflict(res, e)) return;
          throw e;
        }
        res.status(202).json({ gatewayId: id, ...appended });
      } catch (e) {
        next(e);
      }
    },
  );

  router.post(
    "/gateways/:id/releases/:n/rollback",
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const id = req.params.id as string;
        const actor = req as ActorRequest;
        const createdBy = actor.uid ?? "unknown";
        const now = Date.now();
        const body = (req.body ?? {}) as Record<string, unknown>;
        const resolved = await resolveRollbackRelease({
          db,
          gatewayId: id,
          requestedRelease: req.params.n,
          body,
        });
        if ("error" in resolved) {
          res.status(resolved.error.status).json(resolved.error.body);
          return;
        }
        const { gateway, artifact, release, note } = resolved.ok;
        let appended: { release: number; operationId: string | null };
        try {
          appended = await appendGatewayRelease(db, {
            gateway,
            artifact,
            createdBy,
            now,
            sourceRelease: release,
            note,
          });
        } catch (e) {
          if (respondReleaseWriteConflict(res, e)) return;
          throw e;
        }
        res
          .status(202)
          .json({ gatewayId: id, ...appended, rolledBackFrom: release });
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

  async function findInFlightMigrateOp(
    uid: string,
  ): Promise<{ id: string } | null> {
    const opsSnap = await db
      .collection(GLM_OPERATIONS_COLLECTION)
      .where("inputUid", "==", uid)
      .get();
    const doc = opsSnap.docs.find((d) => {
      const data = d.data() as { kind?: unknown; status?: unknown };
      return (
        data.kind === OP_KIND_MIGRATE_CUSTOMER &&
        (data.status === "pending" || data.status === "running")
      );
    });
    return doc ? { id: doc.id } : null;
  }

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
        const inFlight = await findInFlightMigrateOp(uid);
        if (inFlight) {
          res.status(409).json({
            error:
              "a migration for this customer is already pending or running",
            operationId: inFlight.id,
            uid,
          });
          return;
        }
        // Registration is either doc; readiness comes from the relocated
        // glmGateways/{id}.heartbeat (cutover step 2).
        const target = await readGatewayRegistrationReadiness(db, body.to);
        if (!target.registered) {
          res.status(404).json({
            error: "target gateway not registered",
            gatewayId: body.to,
          });
          return;
        }
        if (target.status !== "ready") {
          res.status(409).json({
            error: "target gateway not ready",
            gatewayId: body.to,
            status: target.status ?? "unknown",
          });
          return;
        }
        const userSnap = await db.collection("users").doc(uid).get();
        const userData = userSnap.data() as Record<string, unknown> | undefined;
        const currentGatewayId = readUserGatewayId(userData);
        const builderSlug = userData
          ? resolveCustomerSlug(userData, deps.workspaceSlugsForUser)
          : null;
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
          kind: OP_KIND_MIGRATE_CUSTOMER,
          createdBy,
          input: {
            uid,
            ...(builderSlug ? { builderSlug } : {}),
            ...(currentGatewayId ? { fromGatewayId: currentGatewayId } : {}),
            toGatewayId: body.to,
          },
        });
        res.status(202).json({ operationId });
      } catch (e) {
        next(e);
      }
    },
  );

  // Clears the customer's gateway placement so they land in pending-placement:
  // deletes gateways/{gw}/assignments/{uid} AND clears the user mirror fields in
  // ONE transaction (same all-or-nothing discipline as commitCutoverAtomic). The
  // guard runs INSIDE that transaction — it re-reads the in-flight migrate ops
  // (a migrate enqueued between check and commit conflicts the txn's query read
  // and retries) and the assignment doc's durable `state`, refusing (409) if a
  // migrate op is pending/running OR the durable roster state is not "serving"
  // (a terminal failed roll can leave the customer quiescing with no live op).
  // Never destructive beyond the placement: the user + workspace stay put.
  router.post(
    "/customers/:uid/unassign",
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const uid = req.params.uid as string;
        const outcome = await db.runTransaction<{
          status: number;
          body: Record<string, unknown>;
          from?: string;
        }>(async (txn) => {
          const userRef = db.collection("users").doc(uid);
          const userSnap = await txn.get(userRef);
          if (!userSnap.exists) {
            return { status: 404, body: { error: "user not found", uid } };
          }
          const currentGatewayId = readUserGatewayId(
            userSnap.data() as Record<string, unknown> | undefined,
          );
          if (!currentGatewayId) {
            return { status: 409, body: { error: "customer is already unassigned", uid } };
          }
          const assignmentRef = db
            .collection(GATEWAYS_COLLECTION)
            .doc(currentGatewayId)
            .collection(GATEWAY_ASSIGNMENTS_SUBCOLLECTION)
            .doc(uid);
          const assignmentSnap = await txn.get(assignmentRef);
          const opsSnap = await txn.get(
            db.collection(GLM_OPERATIONS_COLLECTION).where("inputUid", "==", uid),
          );
          const inFlight = opsSnap.docs.find((d) => {
            const data = d.data() as { kind?: unknown; status?: unknown };
            return (
              data.kind === OP_KIND_MIGRATE_CUSTOMER &&
              (data.status === "pending" || data.status === "running")
            );
          });
          if (inFlight) {
            return {
              status: 409,
              body: {
                error:
                  "a migration for this customer is pending or running — let it finish or fail before unassigning",
                operationId: inFlight.id,
                uid,
              },
            };
          }
          const assignment = parseAssignmentDoc(
            uid,
            assignmentSnap.exists ? assignmentSnap.data() : undefined,
          );
          let stranded: { revisionId: string; state: AssignmentState } | null = null;
          if (assignment && assignment.state !== "serving") {
            // A non-serving assignment normally means a roll is settling this
            // customer. But when its revision is one the durable root no longer
            // references, no roll can EVER settle it — the customer is STRANDED
            // (the r5 class) and resetting to pending placement IS the recovery.
            const rootSnap = await txn.get(
              db.collection(GATEWAYS_COLLECTION).doc(currentGatewayId),
            );
            const root = asDurableGatewayRoot(
              rootSnap.exists ? rootSnap.data() : undefined,
              currentGatewayId,
            );
            if (!root || rootReferencedRevisionIds(root).has(assignment.revisionId)) {
              return {
                status: 409,
                body: {
                  error: `customer is mid-migration (roster state ${assignment.state}) — cannot unassign until the roll settles`,
                  uid,
                  state: assignment.state,
                },
              };
            }
            stranded = { revisionId: assignment.revisionId, state: assignment.state };
          }
          // Drop the durable assignment AND the mirror together, so no stale
          // roster entry outlives the placement (a later roll reads assignment
          // docs first — a stale one strands the roll) and no stale
          // gatewayProfile/shellsEnabled survives the gateway they described.
          txn.delete(assignmentRef);
          txn.update(userRef, {
            "provisioning.openclaw.gatewayId": FieldValue.delete(),
            "provisioning.openclaw.gatewayAssignedAt": FieldValue.delete(),
            "provisioning.openclaw.gatewayProfile": FieldValue.delete(),
            "provisioning.openclaw.shellsEnabled": FieldValue.delete(),
          });
          return {
            status: 200,
            body: {
              unassigned: true,
              uid,
              from: currentGatewayId,
              ...(stranded ? { stranded } : {}),
            },
            from: currentGatewayId,
          };
        });
        if (outcome.status === 200) {
          const actor = (req as ActorRequest).uid ?? "unknown";
          deps.logger.info("admin unassigned customer from gateway", {
            actor,
            uid,
            from: outcome.from,
          });
        }
        res.status(outcome.status).json(outcome.body);
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
