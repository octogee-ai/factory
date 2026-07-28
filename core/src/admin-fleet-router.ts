

import {
  Router,
  type Request,
  type Response,
  type NextFunction,
} from "express";
import {
  FieldValue,
  type DocumentReference,
  type Firestore,
  type Transaction,
} from "firebase-admin/firestore";
import {
  GLM_GATEWAYS_COLLECTION,
  GLM_OPERATIONS_COLLECTION,
  isOperationAuditRecord,
  isOperationAuditRow,
  GATEWAY_CLASSES,
  GATEWAY_IMAGE_PROFILES,
  GATEWAY_PROFILES,
  NEW_GATEWAY_ID_REQUIREMENT,
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
  type OperationAuditDocument,
  type OperatorGatewayAccessSpec,
} from "@octogee/shared/types/glm";
import {
  deploymentSettingsForRuntime,
  deploymentTargetsForEnvironment,
} from "./deployment-environment.js";
import { accountAllowsInteractiveAccess } from "@octogee/shared/types/account-lifecycle";
import { GATEWAYS_COLLECTION } from "@octogee/shared/types/fleet-controller";
import {
  GATEWAY_ASSIGNMENTS_SUBCOLLECTION,
  GATEWAY_RELEASES_SUBCOLLECTION,
  commitPlacementAtomic,
  isReleasePayload,
  releasePayloadHash,
  isGatewayDesiredDoc,
  isGatewayRuntimeDoc,
  upgradeReleasePayloadSchema,
  type AssignmentDoc,
  type AssignmentState,
  type GatewayDoc,
  type GatewayRuntimeDoc,
  type PlacementFirestore,
  type ReleaseDoc,
  type ReleasePayload,
} from "@octogee/shared/types/gateway-releases";
import { parseAssignmentDoc, readAssignmentDocsForGateway } from "./assignment-doc.js";
import {
  GATEWAY_CONFIG_SCHEMA_VERSION,
  InitialGatewayReleaseConflictError,
  gatewayArtifactFromReleasePayload,
  isGatewayMutableConfigForGateway,
  projectGatewayMutableConfigForGateway,
  writeInitialGatewayRelease,
  type GatewayArtifact,
  type GatewayMutableConfig,
} from "./gateway-live-release.js";
import { projectReleaseHistory } from "./gateway-release-history.js";
import {
  resolveContinuousBuilderPlacement,
  resolveLiveActivationTargetGatewayId,
  type OnboardingOrchestratorConfig,
} from "@octogee/shared/types/orchestrator-placement";
import {
  SIZING_TIERS,
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
import { requestBuilderActivationLease } from "./builder-activation-lease.js";
import {
  GatewayRetirementConflictError,
  claimGatewayRetirementAtomic,
} from "./gateway-retirement-claim.js";
import {
  findActiveGatewayMigration,
  GatewayMigrationInFlightError,
} from "./fleet-operation-lock.js";
import {
  CUSTOMER_DELETION_JOBS_COLLECTION,
  buildCustomerDeletionSchedule,
} from "@octogee/shared/types/account-lifecycle";
import { buildCustomerDeletionPlan } from "./customer-deletion-plan.js";
import {
  FleetMutationFrozenError,
  FleetMutationIdempotencyError,
  FleetMutationMaintenanceUnavailableError,
  runNormalFleetMutation,
  type NormalFleetMutationDb,
  type NormalFleetMutationResult,
} from "./normal-fleet-mutation.js";
import { OperationAuditIdempotencyConflictError } from "./operation-audit.js";

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
  readGatewayPodDiagnosticsBatch?: (
    gatewayIds: readonly string[],
  ) => Promise<Record<string, GatewayPodDiagnostics>>;

  suspendAuthUser: (uid: string) => Promise<void>;
  revokeConnectorGrantsForUser: (uid: string) => Promise<void>;
}

type ActorRequest = Request & {
  uid?: string;
  user?: { email?: string | null };
};

class GatewayAuthSecretProvisionError extends Error {}

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

export function resolveFleetDeploymentSettings(
  namespace = resolveFleetNamespace(),
  targetId = process.env.DEPLOYMENT_TARGET_ID,
) {
  try {
    return deploymentSettingsForRuntime({ namespace, targetId });
  } catch (error) {
    if (targetId === undefined && error instanceof Error && error.message.startsWith("Unknown deployment environment")) {
      throw new Error(`Unknown deployment environment for fleet namespace: ${namespace}`);
    }
    throw error;
  }
}

type GlmDoc = Record<string, unknown>;
interface FirestoreDocLike { id: string; data(): GlmDoc }
type DurableGatewayRoot = GatewayDoc & GatewayMutableConfig;
const FLEET_RUNTIME_CONFIG_DOC_PATH = "config/orchestrator";

interface DurableGatewayRuntime {
  root: DurableGatewayRoot;
  runtime: GatewayRuntimeDoc | null;
  heartbeat: GlmDoc | null;
}

export interface FleetRuntimeSettings {
  gatewayImageRepository: string;
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
  | "pointer-drift"
  | "assigned-not-mounted"
  | "mounted-orphan"
  | "migration-in-flight"
  | "account-deletion-pending";

interface AdminOnboardingPlacementWarning {
  code: AdminOnboardingPlacementWarningCode;
  message: string;
  severity: "info" | "warning" | "error";
  gatewayId?: string;
  uid?: string;
  slug?: string;
  operationId?: string;
  expiresAt?: number;
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
  policyTargetGatewayId: string | null;
  assignedGatewayId: string | null;
  mountedGatewayId: string | null;
  provisioningStatus: string | null;
  driftState: AdminOnboardingDriftState;
  // Durable roster truth from gateways/{gw}/assignments/{uid}. null when
  // the customer has no assignment doc (legacy/un-backfilled gateway) — the
  // client falls back to derivation only in that case.
  rosterState: AssignmentState | null;
  rosterEpoch: number | null;
  warnings: AdminOnboardingPlacementWarning[];
  latestOperation: AdminOnboardingLatestOperation | null;
}

interface AdminOnboardingPlacementResponse {
  config: {
    defaultGatewayId: string | null;
  };
  gateways: AdminOnboardingGatewaySummary[];
  customers: AdminOnboardingCustomerProjection[];
  driftSummary: Record<AdminOnboardingDriftState, number>;
  warnings: AdminOnboardingPlacementWarning[];
  generatedAt: string;
  defaultChange?: AdminDefaultGatewayChange;
}

interface AdminDefaultGatewayChange {
  previousGatewayId: string | null;
  targetGatewayId: string;
  enqueued: Array<{ uid: string; operationId: string }>;
  adopted: Array<{ uid: string; operationId: string }>;
  blocked: Array<{
    uid: string;
    reason: "unassigned" | "current-gateway-missing" | "migration-in-flight";
    currentGatewayId: string | null;
    operationId?: string;
  }>;
  dedicatedUntouched: number;
}

function normalizeOnboardingRuntimeConfig(
  data: Record<string, unknown> | undefined,
): OnboardingOrchestratorConfig {
  return {
    defaultGatewayId: asStringOrNull(data?.defaultGatewayId) ?? "",
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
  data: Record<string, unknown>;
}): boolean {
  return (
    accountAllowsInteractiveAccess(input.data) &&
    (
      asStringOrNull(input.data.username) !== null ||
      readUserGatewayId(input.data) !== null
    )
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
      message: `${input.latestOperation.kind} ${input.slug ?? "unresolved-builder"} (${input.uid}) is ${input.latestOperation.status}`,
    });
  }
  return warnings;
}

function accountLifecycleWarning(input: {
  uid: string;
  data: Record<string, unknown>;
  operations: ReadonlyArray<AdminOnboardingLatestOperation>;
}): AdminOnboardingPlacementWarning | null {
  const lifecycle = isPlainRecord(input.data.accountLifecycle)
    ? input.data.accountLifecycle
    : null;
  if (lifecycle?.status !== "deletion_scheduled" && lifecycle?.status !== "erasing") {
    return null;
  }
  const operation = latestOperation(
    input.operations,
    (candidate) =>
      candidate.kind === "erase-customer" && operationUid(candidate) === input.uid,
  );
  const slug = resolveCustomerSlug(input.data, (data) =>
    asStringOrNull(data.username) ? [asStringOrNull(data.username)!] : [],
  ) ?? asStringOrNull(operation?.input.builderSlug);
  const expiresAt = toMillis(lifecycle.eraseAfter);
  return {
    code: "account-deletion-pending",
    severity: "info",
    uid: input.uid,
    slug: slug ?? undefined,
    ...(operation ? { operationId: operation.id } : {}),
    ...(expiresAt !== null ? { expiresAt } : {}),
    message: `${slug ?? "unresolved-builder"} (${input.uid}) is ${lifecycle.status === "erasing" ? "being deleted" : "scheduled for deletion"}`,
  };
}

function accountLifecycleWarnings(
  userDocs: ReadonlyArray<FirestoreDocLike>,
  operations: ReadonlyArray<AdminOnboardingLatestOperation>,
): AdminOnboardingPlacementWarning[] {
  return userDocs
    .map((userDoc) => accountLifecycleWarning({
      uid: userDoc.id,
      data: userDoc.data(),
      operations,
    }))
    .filter((warning): warning is AdminOnboardingPlacementWarning => warning !== null);
}

function driftStateForCustomer(input: {
  assignedGatewayId: string | null;
  mountedGatewayId: string | null;
  policyTargetGatewayId: string | null;
  latestOperation: AdminOnboardingLatestOperation | null;
  glmByGatewayId: Map<string, GlmDoc>;
}): AdminOnboardingDriftState {
  if (isInFlightOperation(input.latestOperation)) return "in-flight";
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

function activationPolicyGatewayId(input: {
  uid: string;
  data: Record<string, unknown>;
  assignedGatewayId: string | null;
  glmByGatewayId: ReadonlyMap<string, GlmDoc>;
}): string | null {
  const candidate = resolveLiveActivationTargetGatewayId({
    userData: input.data,
  });
  const gateway = candidate ? input.glmByGatewayId.get(candidate) : undefined;
  const placement = resolveContinuousBuilderPlacement({
    uid: input.uid,
    userData: input.data,
    currentGatewayId: input.assignedGatewayId,
    defaultGatewayId: "",
    ownedGateway: candidate && gateway
      ? {
          gatewayId: candidate,
          gatewayClass: normalizeGatewayClass(gateway),
          ownerUid: asStringOrNull(gateway.ownerUid),
          desiredStatus: projectDesiredStatus(gateway) ?? "invalid",
          ready: asStringOrNull(effectiveHeartbeatDoc(candidate, gateway)?.data()?.status) === "ready",
        }
      : null,
  });
  return placement.targetGatewayId || null;
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
  const policyTargetGatewayId = activationPolicyGatewayId({
    uid: input.uid,
    data: input.data,
    assignedGatewayId,
    glmByGatewayId: input.glmByGatewayId,
  }) ?? input.config.defaultGatewayId;
  const mountedGatewayId = slug ? input.mountedBySlug.get(slug) ?? null : null;
  const latestOp = latestOperation(
    input.operations,
    (operation: AdminOnboardingLatestOperation) => operationUid(operation) === input.uid,
  );
  const driftState = driftStateForCustomer({
    assignedGatewayId,
    mountedGatewayId,
    policyTargetGatewayId,
    latestOperation: latestOp,
    glmByGatewayId: input.glmByGatewayId,
  });
  const warnings = userPlacementWarnings({
    uid: input.uid,
    slug,
    assignedGatewayId,
    mountedGatewayId,
    policyTargetGatewayId,
    driftState,
    latestOperation: latestOp,
  });
  const assignment = input.assignmentByUid.get(input.uid) ?? null;
  return {
    uid: input.uid,
    username: asStringOrNull(input.data.username) ?? "",
    email: asStringOrNull(input.data.email) ?? "",
    slug,
    policyTargetGatewayId,
    assignedGatewayId,
    mountedGatewayId,
    provisioningStatus: readProvisioningStatus(input.data),
    driftState,
    rosterState: assignment ? assignment.state : null,
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
  const assignmentByUid = indexAssignmentDocs(opts.assignmentDocs);
  const operations = opts.operationDocs.map((doc) =>
    shapeOnboardingOperation(doc.id, doc.data()),
  );
  const mountedBySlug = mountedGatewayBySlug(glmByGatewayId);
  const customers = opts.userDocs
    .filter((doc) =>
      shouldIncludeOnboardingCustomer({
        data: doc.data(),
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
    const status = asStringOrNull(heartbeat?.status);
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
      status,
      imageTag: projectImageTag(heartbeat ?? {}, glmDoc),
      openclawVersion: projectOpenclawVersion(heartbeat ?? {}, glmDoc),
      assignableAsDefault:
        Boolean(glmDoc) &&
        gatewayClass === "shared" &&
        desiredStatus === "running" &&
        status === "ready",
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
  warnings.push(...accountLifecycleWarnings(opts.userDocs, operations));
  for (const customer of customers) warnings.push(...customer.warnings);

  return {
    config: {
      defaultGatewayId,
    },
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
  const [
    config,
    glmSnap,
    gatewaySnap,
    usersSnap,
    operationsSnap,
    assignmentSnap,
  ] =
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

async function readFleetRuntimeSettings(): Promise<FleetRuntimeSettings> {
  const deployment = resolveFleetDeploymentSettings();
  return {
    gatewayImageRepository: `${deployment.artifactRegistryRepository}/octogee-gateway`,
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
  runtime: GatewayRuntimeDoc | null,
): GlmDoc {
  if (!runtime) return { ...root, gateway: root.gatewayId };
  return {
    ...root,
    gateway: root.gatewayId,
    imageRepository: runtime.helm.imageRepository,
    imageTag: runtime.helm.imageTag,
    heartbeat: runtime.heartbeat,
    lastError: runtime.lastError,
  };
}

// The admin surface is addressed by the durable gateway identity. Runtime
// observations come from the gateway's bare-id runtime doc; legacy bare GLM
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
    out.set(
      gatewayId,
      projectDurableGatewayRuntime(root, exactRuntimeDoc(root, rawGlmById.get(gatewayId))),
    );
  }
  for (const [gatewayId, glmDoc] of rawGlmById) {
    if (gatewayDocIds.has(gatewayId) || isGatewayRuntimeDoc(glmDoc)) continue;
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
  if (!isGatewayDesiredDoc(data) || data.gatewayId !== gatewayId) return null;
  return projectGatewayMutableConfigForGateway(data, gatewayId) as DurableGatewayRoot | null;
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

function exactRuntimeDoc(
  root: DurableGatewayRoot,
  data: unknown,
): GatewayRuntimeDoc | null {
  if (!isGatewayRuntimeDoc(data) || data.gatewayId !== root.gatewayId) {
    return null;
  }
  return data;
}

function runtimeHeartbeat(runtime: GatewayRuntimeDoc | null): GlmDoc | null {
  return runtime && isPlainRecord(runtime.heartbeat) ? runtime.heartbeat : null;
}

async function readDurableGatewayRuntime(
  db: Firestore,
  gatewayId: string,
): Promise<DurableGatewayRuntime | null> {
  const rootSnap = await db.collection(GATEWAYS_COLLECTION).doc(gatewayId).get();
  const root = rootSnap.exists ? asDurableGatewayRoot(rootSnap.data(), gatewayId) : null;
  if (!root) return null;
  const runtimeSnap = await db
    .collection(GLM_GATEWAYS_COLLECTION)
    .doc(gatewayId)
    .get();
  const runtime = runtimeSnap.exists ? exactRuntimeDoc(root, runtimeSnap.data()) : null;
  return { root, runtime, heartbeat: runtimeHeartbeat(runtime) };
}

function gatewayRetirementBlocker(
  gatewayId: string,
  runtime: DurableGatewayRuntime,
): Record<string, unknown> | null {
  if (
    runtime.root.desiredStatus === "running" &&
    runtime.root.liveRelease != null &&
    !runtime.runtime
  ) {
    return {
      error: "gateway runtime telemetry is unavailable",
      gatewayId,
    };
  }
  return null;
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

// Gateway pods select nothing but `cloud.google.com/gke-spot`: Spot-only, with
// no on-demand fallback rung, so pricing is always the Spot rate.
export function projectGatewayReservation(
  _glmDoc: GlmDoc | undefined,
): {
  type: GatewayPricingMode;
  priceMultiplier: number;
} {
  return { type: "spot", priceMultiplier: SPOT_PRICE_MULTIPLIER };
}

function projectDisposableRuntime(
  glmDoc: GlmDoc | undefined,
): {
  ownerUid: string;
  leaseId: string;
  generation: number;
} | null {
  const allocation = isPlainRecord(glmDoc?.allocation)
    ? glmDoc.allocation
    : null;
  if (
    allocation?.kind !== "disposable-builder" ||
    typeof allocation.leaseId !== "string" ||
    !Number.isSafeInteger(allocation.generation) ||
    typeof allocation.claimedByUid !== "string" ||
    glmDoc?.ownerUid !== allocation.claimedByUid
  ) {
    return null;
  }
  return {
    ownerUid: allocation.claimedByUid,
    leaseId: allocation.leaseId,
    generation: allocation.generation as number,
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
  disposableRuntime: ReturnType<typeof projectDisposableRuntime>;
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
    disposableRuntime: projectDisposableRuntime(glmDoc),
  };
}

export type AdminBuilderRuntimeLifecycle =
  | "requested"
  | "provisioning"
  | "activating"
  | "active"
  | "returning"
  | "retiring"
  | "failed";

const BUILDER_RUNTIME_STATUSES = new Set([
  "requested",
  "provisioning",
  "activating",
  "active",
  "returning",
  "failed",
]);
const BUILDER_RUNTIME_STALE_AFTER_MS = 10 * 60_000;
const BUILDER_RUNTIME_STATUS_FIELDS: Record<AdminBuilderRuntimeLifecycle, string> = {
  requested: "requestedAt",
  provisioning: "provisionedAt",
  activating: "activatingAt",
  active: "activeAt",
  returning: "returningAt",
  retiring: "returningAt",
  failed: "failedAt",
};

function activationLeaseFromUser(
  data: GlmDoc,
): {
  openclaw: GlmDoc;
  lease: GlmDoc;
} | null {
  const provisioning = isPlainRecord(data.provisioning)
    ? data.provisioning
    : null;
  const openclaw = isPlainRecord(provisioning?.openclaw)
    ? provisioning.openclaw
    : null;
  const lease = isPlainRecord(openclaw?.activationLease)
    ? openclaw.activationLease
    : null;
  return openclaw && lease ? { openclaw, lease } : null;
}

function runtimeStatusAt(lease: GlmDoc, lifecycle: AdminBuilderRuntimeLifecycle): number | null {
  const field = BUILDER_RUNTIME_STATUS_FIELDS[lifecycle];
  return toMillis(lease[field]) ?? toMillis(lease.requestedAt);
}

function runtimeWakeDurationMs(
  lease: GlmDoc,
  leaseStatus: string,
  requestedAt: number | null,
  now: number,
): number | null {
  if (requestedAt === null) return null;
  let completedAt: number | null = null;
  if (
    leaseStatus === "active" ||
    leaseStatus === "returning" ||
    leaseStatus === "parked"
  ) {
    completedAt = toMillis(lease.activeAt);
  } else if (leaseStatus === "failed") {
    completedAt = toMillis(lease.failedAt);
  }
  return Math.max(0, (completedAt ?? now) - requestedAt);
}

function projectOperationSteps(
  operation: GlmDoc | undefined,
): Array<{ name: string; status: string }> {
  return Array.isArray(operation?.steps)
    ? operation.steps.flatMap((step) => {
        if (
          !isPlainRecord(step) ||
          typeof step.name !== "string" ||
          typeof step.status !== "string"
        ) {
          return [];
        }
        return [{ name: step.name, status: step.status }];
      })
    : [];
}

interface BuilderRuntimeLeaseContext {
  data: GlmDoc;
  openclaw: GlmDoc;
  lease: GlmDoc;
  leaseId: string;
  generation: number;
  leaseStatus: string;
}

interface BuilderRuntimeRetirementContext {
  targetGatewayId: string | null;
  target: GlmDoc | undefined;
  operationId: string | null;
  operation: GlmDoc | undefined;
  started: boolean;
  complete: boolean;
  failed: boolean;
}

type AdminBuilderRuntimePhase = "activation" | "runtime" | "return" | "retirement";

function builderRuntimeLeaseContext(
  userDoc: FirestoreDocLike,
): BuilderRuntimeLeaseContext | null {
  const data = userDoc.data();
  const resolved = activationLeaseFromUser(data);
  if (!resolved) return null;
  const { openclaw, lease } = resolved;
  if (
    typeof lease.leaseId !== "string" ||
    !Number.isSafeInteger(lease.generation)
  ) {
    return null;
  }
  return {
    data,
    openclaw,
    lease,
    leaseId: lease.leaseId,
    generation: lease.generation as number,
    leaseStatus: typeof lease.status === "string" ? lease.status : "",
  };
}

function builderRuntimeRetirementContext(
  uid: string,
  lease: GlmDoc,
  gatewaysById: ReadonlyMap<string, GlmDoc>,
  operationsById: ReadonlyMap<string, GlmDoc>,
): BuilderRuntimeRetirementContext {
  const targetGatewayId = asStringOrNull(lease.targetGatewayId);
  const target = targetGatewayId ? gatewaysById.get(targetGatewayId) : undefined;
  const retirementClaim = isPlainRecord(target?.retirementClaim)
    ? target.retirementClaim
    : null;
  let operationId: string | null = null;
  if (targetGatewayId) {
    operationId =
      asStringOrNull(retirementClaim?.operationId) ??
      `placement-retire-${uid}-${targetGatewayId}`;
  }
  const operation = operationId ? operationsById.get(operationId) : undefined;
  return {
    targetGatewayId,
    target,
    operationId,
    operation,
    started: target?.desiredStatus === "retired",
    complete: operation?.status === "succeeded",
    failed: operation?.status === "failed",
  };
}

function builderRuntimeLifecycle(
  leaseStatus: string,
  retirement: BuilderRuntimeRetirementContext,
): AdminBuilderRuntimeLifecycle | null {
  const visible =
    BUILDER_RUNTIME_STATUSES.has(leaseStatus) ||
    (
      leaseStatus === "parked" &&
      retirement.started &&
      !retirement.complete
    );
  if (!visible) return null;
  if (retirement.failed || leaseStatus === "failed") return "failed";
  if (retirement.started) return "retiring";
  return leaseStatus as AdminBuilderRuntimeLifecycle;
}

function builderRuntimePhase(
  leaseStatus: string,
  lifecycle: AdminBuilderRuntimeLifecycle,
  retirementStarted: boolean,
): AdminBuilderRuntimePhase {
  if (leaseStatus === "failed") return "activation";
  if (retirementStarted) return "retirement";
  if (lifecycle === "returning") return "return";
  if (lifecycle === "active") return "runtime";
  return "activation";
}

function builderRuntimeOperationId(
  phase: AdminBuilderRuntimePhase,
  lease: GlmDoc,
  retirementOperationId: string | null,
): string | null {
  if (phase === "retirement") return retirementOperationId;
  if (phase === "return") return asStringOrNull(lease.returnOperationId);
  return asStringOrNull(lease.activationOperationId);
}

function builderRuntimeSlug(
  uid: string,
  data: GlmDoc,
  openclaw: GlmDoc,
  lease: GlmDoc,
): string {
  const leaseSlug = asStringOrNull(lease.builderSlug);
  if (leaseSlug) return leaseSlug;
  const openclawSlug = asStringOrNull(openclaw.slug);
  if (openclawSlug) return openclawSlug;
  return asStringOrNull(data.username) ?? uid;
}

function builderRuntimeIsStale(
  leaseStatus: string,
  wakeDurationMs: number | null,
): boolean {
  const preCutover =
    leaseStatus === "requested" ||
    leaseStatus === "provisioning" ||
    leaseStatus === "activating";
  return preCutover &&
    wakeDurationMs !== null &&
    wakeDurationMs > BUILDER_RUNTIME_STALE_AFTER_MS;
}

function builderRuntimeTerminationAvailable(input: {
  targetGatewayId: string | null;
  currentGatewayId: string | null;
  target: GlmDoc | undefined;
  leaseFailed: boolean;
  stale: boolean;
}): boolean {
  return input.targetGatewayId !== null &&
    input.currentGatewayId !== input.targetGatewayId &&
    input.target?.desiredStatus !== "retired" &&
    (input.leaseFailed || input.stale);
}

function isoFromMillis(value: number | null): string | null {
  return value === null ? null : new Date(value).toISOString();
}

export function projectBuilderRuntime(
  userDoc: FirestoreDocLike,
  gatewaysById: ReadonlyMap<string, GlmDoc>,
  operationsById: ReadonlyMap<string, GlmDoc>,
  now: number,
): {
  uid: string;
  builderSlug: string;
  lifecycle: AdminBuilderRuntimeLifecycle;
  phase: "activation" | "runtime" | "return" | "retirement";
  leaseId: string;
  generation: number;
  cause: string | null;
  currentGatewayId: string | null;
  sourceGatewayId: string | null;
  targetGatewayId: string | null;
  sizingTier: string | null;
  requestedAt: string | null;
  wakeDurationMs: number | null;
  statusAt: string | null;
  statusAgeMs: number | null;
  stale: boolean;
  operationId: string | null;
  operationStatus: string | null;
  operationSteps: Array<{ name: string; status: string }>;
  cleanupOperationId: string | null;
  cleanupOperationStatus: string | null;
  cleanupOperationSteps: Array<{ name: string; status: string }>;
  cleanupError: string | null;
  error: string | null;
  terminationAvailable: boolean;
  retryAvailable: boolean;
  targetPodStatus: GatewayPodDiagnosticsStatus | null;
  targetPodCount: number | null;
} | null {
  const leaseContext = builderRuntimeLeaseContext(userDoc);
  if (!leaseContext) return null;
  const { data, openclaw, lease, leaseId, generation, leaseStatus } = leaseContext;
  const retirement = builderRuntimeRetirementContext(
    userDoc.id,
    lease,
    gatewaysById,
    operationsById,
  );
  const { targetGatewayId } = retirement;
  const lifecycle = builderRuntimeLifecycle(leaseStatus, retirement);
  if (!lifecycle) return null;
  const leaseFailed = leaseStatus === "failed";
  const phase = builderRuntimePhase(
    leaseStatus,
    lifecycle,
    retirement.started,
  );
  const operationId = builderRuntimeOperationId(
    phase,
    lease,
    retirement.operationId,
  );
  const operation = operationId ? operationsById.get(operationId) : undefined;
  const operationSteps = projectOperationSteps(operation);
  const cleanupOperationId = retirement.started
    ? retirement.operationId
    : null;
  const cleanupOperation = cleanupOperationId
    ? retirement.operation
    : undefined;
  const lastError = isPlainRecord(lease.lastError) ? lease.lastError : null;
  const requestedAt = toMillis(lease.requestedAt);
  const statusAt = runtimeStatusAt(lease, lifecycle);
  const statusAgeMs = ageMsOrNull(statusAt, now);
  const wakeDurationMs = runtimeWakeDurationMs(
    lease,
    leaseStatus,
    requestedAt,
    now,
  );
  const currentGatewayId = asStringOrNull(openclaw.gatewayId);
  const stale = builderRuntimeIsStale(leaseStatus, wakeDurationMs);
  return {
    uid: userDoc.id,
    builderSlug: builderRuntimeSlug(userDoc.id, data, openclaw, lease),
    lifecycle,
    phase,
    leaseId,
    generation,
    cause: asStringOrNull(lease.cause),
    currentGatewayId,
    sourceGatewayId: asStringOrNull(lease.sourceGatewayId),
    targetGatewayId,
    sizingTier: asStringOrNull(lease.sizingTier),
    requestedAt: isoFromMillis(requestedAt),
    wakeDurationMs,
    statusAt: isoFromMillis(statusAt),
    statusAgeMs,
    stale,
    operationId,
    operationStatus: asStringOrNull(operation?.status),
    operationSteps,
    cleanupOperationId,
    cleanupOperationStatus: asStringOrNull(cleanupOperation?.status),
    cleanupOperationSteps: projectOperationSteps(cleanupOperation),
    cleanupError: asStringOrNull(cleanupOperation?.error),
    error:
      asStringOrNull(operation?.error) ??
      asStringOrNull(lastError?.message),
    terminationAvailable: builderRuntimeTerminationAvailable({
      targetGatewayId,
      currentGatewayId,
      target: retirement.target,
      leaseFailed,
      stale,
    }),
    retryAvailable: false,
    targetPodStatus: null,
    targetPodCount: null,
  };
}

export function projectDisposableFleetCapacity(
  gateways: ReadonlyArray<ReturnType<typeof projectGatewaySummary>>,
  builderRuntimes: ReadonlyArray<NonNullable<ReturnType<typeof projectBuilderRuntime>>> = [],
  parkedBuilders = 0,
): {
  disposableInstances: number;
  stagedInstances: 0;
  namedReservations: 0;
  byTier: Record<string, number>;
  parkedBuilders: number;
  byLifecycle: Record<AdminBuilderRuntimeLifecycle | "parked", number>;
  failedBuilders: number;
  staleActivations: number;
  oldestActivationAgeMs: number | null;
} {
  const disposables = gateways.filter((gateway) => gateway.disposableRuntime !== null);
  const byTier: Record<string, number> = {};
  const byLifecycle: Record<AdminBuilderRuntimeLifecycle | "parked", number> = {
    requested: 0,
    provisioning: 0,
    activating: 0,
    active: 0,
    returning: 0,
    retiring: 0,
    failed: 0,
    parked: parkedBuilders,
  };
  for (const gateway of disposables) {
    byTier[gateway.sizing.tier] = (byTier[gateway.sizing.tier] ?? 0) + 1;
  }
  for (const runtime of builderRuntimes) {
    byLifecycle[runtime.lifecycle] += 1;
  }
  const activationAges = builderRuntimes.flatMap((runtime) =>
    (
      runtime.lifecycle === "requested" ||
      runtime.lifecycle === "provisioning" ||
      runtime.lifecycle === "activating"
    ) && runtime.wakeDurationMs !== null
      ? [runtime.wakeDurationMs]
      : []
  );
  return {
    disposableInstances: disposables.length,
    stagedInstances: 0,
    namedReservations: 0,
    byTier,
    parkedBuilders,
    byLifecycle,
    failedBuilders: byLifecycle.failed,
    staleActivations: builderRuntimes.filter((runtime) => runtime.stale).length,
    oldestActivationAgeMs:
      activationAges.length === 0 ? null : Math.max(...activationAges),
  };
}

function rollupFleetStats(
  gateways: ReadonlyArray<ReturnType<typeof projectGatewaySummary>>,
): {
  gateways: { total: number; ready: number; paused: number; unreachable: number };
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
  let ready = 0, paused = 0, unreachable = 0, customersMounted = 0, fleetMonthlyUsd = 0, fleetOnDemandUsd = 0;
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
    if (g.desiredStatus === "paused") paused++;
    else if (stale) unreachable++;
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
    gateways: { total: gateways.length, ready, paused, unreachable },
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
const ERR_USER_NOT_FOUND = "user not found";
const OP_KIND_MIGRATE_CUSTOMER = "migrate-customer";
const GATEWAY_IMAGE_REPO_PREFIXES = [...new Set(
  (["prod", "test", "build-week"] as const).flatMap((environment) =>
    deploymentTargetsForEnvironment(environment).map(
      (target) => `${target.artifactRegistryRepository}/`,
    ),
  ),
)];
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
  "suspend-customer",
  "erase-customer",
]);
const OP_STATUSES = new Set([
  "pending",
  "running",
  "succeeded",
  "failed",
  "rolled-back",
]);

interface StripeRefs {
  customerIds: string[];
  subscriptionIds: string[];
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
    | "restart-gateway"
    | "rollout"
    | "deprovision-customer"
    | "suspend-customer"
    | "erase-customer";
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
  return GATEWAY_IMAGE_REPO_PREFIXES.some((prefix) => repo.startsWith(prefix));
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
          expectedPrefixes: GATEWAY_IMAGE_REPO_PREFIXES,
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
  if (gatewayClass !== "shared" && body.ownerUid === undefined) {
    return {
      error: {
        status: 400,
        body: { error: "dedicated gateway requires ownerUid" },
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

function readUserGatewayId(
  data: Record<string, unknown> | undefined,
): string | null {
  const provisioning =
    (data?.provisioning as Record<string, unknown> | undefined) ?? {};
  const openclaw =
    (provisioning.openclaw as Record<string, unknown> | undefined) ?? {};
  return asStringOrNull(openclaw.gatewayId);
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
  const builderSubscription =
    (userData.builderSubscription as Record<string, unknown> | undefined) ?? {};
  const billing =
    (userData.billing as Record<string, unknown> | undefined) ?? {};
  const subscriptionIds = [
    asStringOrNull(subscription.stripeSubscriptionId) ??
      asStringOrNull(subscription.id) ??
      asStringOrNull(billing.subscriptionId),
    asStringOrNull(builderSubscription.stripeSubscriptionId) ??
      asStringOrNull(builderSubscription.id),
  ].filter((value): value is string => value !== null);
  return {
    customerIds: [...new Set([
      asStringOrNull(subscription.stripeCustomerId),
      asStringOrNull(userData.stripeCustomerId),
      asStringOrNull(billing.stripeCustomerId),
    ].filter((value): value is string => value !== null))],
    subscriptionIds: [...new Set(subscriptionIds)],
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

function shapeInvalidOperationAuditHistoryRecord(
  id: string,
  data: Record<string, unknown>,
): Record<string, unknown> {
  return {
    id,
    recordType: "audit",
    invalid: true,
    schemaVersion: typeof data.schemaVersion === "number" ? data.schemaVersion : null,
    status: "invalid",
    lifecycleStage: "invalid",
    createdAt: typeof data.createdAt === "number" && Number.isFinite(data.createdAt)
      ? data.createdAt
      : 0,
    completedAt: null,
    error: "Unsupported or malformed operation audit record",
  };
}

function shapeAuditHistoryPreCreatedAtFields(
  data: OperationAuditDocument,
): Record<string, unknown> {
  return {
    ...(data.aliasOutcomes ? { aliasOutcomes: data.aliasOutcomes } : {}),
    ...(data.releaseRollout ? { releaseRollout: data.releaseRollout } : {}),
    ...(data.testProvenance ? { testProvenance: data.testProvenance } : {}),
    ...(data.outcome ? { outcome: data.outcome } : {}),
    ...(data.partialOutcome ? { partialOutcome: data.partialOutcome } : {}),
  };
}

function shapeAuditHistoryActionFields(
  data: OperationAuditDocument,
): Record<string, unknown> {
  return {
    ...(data.actionClaimId ? { actionClaimId: data.actionClaimId } : {}),
    ...(data.actionStartedAt !== undefined ? { actionStartedAt: data.actionStartedAt } : {}),
    ...(data.actionRecoveryCount !== undefined
      ? { actionRecoveryCount: data.actionRecoveryCount }
      : {}),
  };
}

function shapeAuditHistoryErrorField(
  data: OperationAuditDocument,
): Record<string, unknown> {
  return {
    ...(typeof data.error === "string" ? { error: data.error } : {}),
  };
}

function shapeValidOperationAuditHistoryRecord(
  id: string,
  data: OperationAuditDocument,
): Record<string, unknown> {
  return {
    id,
    recordType: data.recordType,
    schemaVersion: data.schemaVersion,
    status: data.status,
    lifecycleStage: data.lifecycleStage,
    idempotencyKey: data.idempotencyKey,
    mutationFingerprint: data.mutationFingerprint,
    mutation: data.mutation,
    actor: data.actor,
    forced: data.forced,
    what: data.what,
    why: data.why,
    target: data.target,
    preActionStatus: data.preActionStatus,
    aliasPlan: data.aliasPlan,
    ...shapeAuditHistoryPreCreatedAtFields(data),
    createdAt: data.createdAt,
    ...shapeAuditHistoryActionFields(data),
    completedAt: data.completedAt,
    ...shapeAuditHistoryErrorField(data),
  };
}

export function shapeOperationsHistoryRecord(
  id: string,
  data: Record<string, unknown>,
): Record<string, unknown> {
  if (isOperationAuditRow(data) && !isOperationAuditRecord(data)) {
    return shapeInvalidOperationAuditHistoryRecord(id, data);
  }
  if (isOperationAuditRecord(data)) {
    return shapeValidOperationAuditHistoryRecord(id, data);
  }
  return { id, ...data };
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

function unknownGatewayPodDiagnostics(error: string): GatewayPodDiagnostics {
  return {
    status: "unknown",
    totalPods: 0,
    readyPods: 0,
    totalRestarts: 0,
    pods: [],
    error,
  };
}

async function projectGatewaySummariesWithDiagnostics(
  deps: FleetRouterDeps,
  summaries: Array<ReturnType<typeof projectGatewaySummary>>,
  readBatch: NonNullable<FleetRouterDeps["readGatewayPodDiagnosticsBatch"]>,
): Promise<Array<ReturnType<typeof projectGatewaySummary> & {
  podDiagnostics: GatewayPodDiagnostics | null;
}>> {
  try {
    const diagnostics = await readBatch(
      summaries.map((summary) => summary.gatewayId),
    );
    return summaries.map((summary) => ({
      ...summary,
      podDiagnostics:
        diagnostics[summary.gatewayId] ??
        unknownGatewayPodDiagnostics("gateway missing from batched pod diagnostics"),
    }));
  } catch (error) {
    const message = (error as Error)?.message ?? String(error);
    deps.logger.warn("gateway pod diagnostics batch failed", { error: message });
    return summaries.map((summary) => ({
      ...summary,
      podDiagnostics: unknownGatewayPodDiagnostics(message),
    }));
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

type DefaultGatewayUserDecision =
  | { kind: "ignore" }
  | { kind: "already-on-target" }
  | { kind: "dedicated" }
  | {
      kind: "blocked";
      reason: "unassigned" | "current-gateway-missing" | "migration-in-flight";
      currentGatewayId: string | null;
      operationId?: string;
    }
  | { kind: "adopt"; operationId: string }
  | { kind: "enqueue"; currentGatewayId: string; builderSlug: string | null };

function defaultGatewayUserDecision(input: {
  data: Record<string, unknown>;
  gatewaysById: ReadonlyMap<string, DurableGatewayRoot>;
  pending: { id: string; toGatewayId: string | null } | undefined;
  targetGatewayId: string;
  workspaceSlugsForUser: FleetRouterDeps["workspaceSlugsForUser"];
}): DefaultGatewayUserDecision {
  if (!accountAllowsInteractiveAccess(input.data)) return { kind: "ignore" };
  const currentGatewayId = readUserGatewayId(input.data);
  if (!currentGatewayId) {
    return { kind: "blocked", reason: "unassigned", currentGatewayId: null };
  }
  const currentGateway = input.gatewaysById.get(currentGatewayId);
  if (!currentGateway) {
    return { kind: "blocked", reason: "current-gateway-missing", currentGatewayId };
  }
  if (currentGateway.gatewayClass !== "shared") return { kind: "dedicated" };
  if (currentGatewayId === input.targetGatewayId) return { kind: "already-on-target" };
  if (input.pending?.toGatewayId === input.targetGatewayId) {
    return { kind: "adopt", operationId: input.pending.id };
  }
  if (input.pending) {
    return {
      kind: "blocked",
      reason: "migration-in-flight",
      currentGatewayId,
      operationId: input.pending.id,
    };
  }
  return {
    kind: "enqueue",
    currentGatewayId,
    builderSlug: resolveCustomerSlug(input.data, input.workspaceSlugsForUser),
  };
}

function indexPendingMigrations(
  docs: ReadonlyArray<FirestoreDocLike>,
): Map<string, { id: string; toGatewayId: string | null }> {
  const pendingByUid = new Map<string, { id: string; toGatewayId: string | null }>();
  for (const operation of docs) {
    const data = operation.data();
    if (data.kind !== OP_KIND_MIGRATE_CUSTOMER) continue;
    const operationInput = isPlainRecord(data.input) ? data.input : {};
    const uid = asStringOrNull(data.inputUid) ?? asStringOrNull(operationInput.uid);
    if (!uid || pendingByUid.has(uid)) continue;
    pendingByUid.set(uid, {
      id: operation.id,
      toGatewayId: asStringOrNull(operationInput.toGatewayId),
    });
  }
  return pendingByUid;
}

async function convergeDefaultGatewayChange(input: {
  deps: FleetRouterDeps;
  gatewaysById: ReadonlyMap<string, DurableGatewayRoot>;
  previousGatewayId: string | null;
  targetGatewayId: string;
  createdBy: string;
  enqueueMigration: (input: Record<string, unknown>) => Promise<string>;
}): Promise<AdminDefaultGatewayChange> {
  const [usersSnap, pendingOpsSnap] = await Promise.all([
    input.deps.db.collection("users").get(),
    input.deps.db
      .collection(GLM_OPERATIONS_COLLECTION)
      .where("status", "in", ["pending", "running"])
      .get(),
  ]);
  const pendingByUid = indexPendingMigrations(pendingOpsSnap.docs);

  const result: AdminDefaultGatewayChange = {
    previousGatewayId: input.previousGatewayId,
    targetGatewayId: input.targetGatewayId,
    enqueued: [],
    adopted: [],
    blocked: [],
    dedicatedUntouched: 0,
  };
  const users = [...usersSnap.docs].sort((a, b) => a.id.localeCompare(b.id));
  for (const user of users) {
    const data = user.data() as Record<string, unknown>;
    const decision = defaultGatewayUserDecision({
      data,
      gatewaysById: input.gatewaysById,
      pending: pendingByUid.get(user.id),
      targetGatewayId: input.targetGatewayId,
      workspaceSlugsForUser: input.deps.workspaceSlugsForUser,
    });
    if (decision.kind === "ignore" || decision.kind === "already-on-target") continue;
    if (decision.kind === "dedicated") {
      result.dedicatedUntouched += 1;
      continue;
    }
    if (decision.kind === "blocked") {
      result.blocked.push({
        uid: user.id,
        reason: decision.reason,
        currentGatewayId: decision.currentGatewayId,
        ...(decision.operationId ? { operationId: decision.operationId } : {}),
      });
      continue;
    }
    if (decision.kind === "adopt") {
      result.adopted.push({ uid: user.id, operationId: decision.operationId });
      continue;
    }
    const operationId = await input.enqueueMigration({
      uid: user.id,
      ...(decision.builderSlug ? { builderSlug: decision.builderSlug } : {}),
      fromGatewayId: decision.currentGatewayId,
      toGatewayId: input.targetGatewayId,
      source: "platform-default-change",
    });
    result.enqueued.push({ uid: user.id, operationId });
  }
  return result;
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

class ReleaseArtifactSchemaUnsupportedError extends Error {
  readonly code = "release-artifact-schema-unsupported";

  constructor(
    readonly gatewayId: string,
    readonly release: number,
    readonly reason: "payload-hash-mismatch" | "unsupported-payload-schema",
  ) {
    super(`gateway ${gatewayId} release ${release} artifact schema is unsupported`);
    this.name = "ReleaseArtifactSchemaUnsupportedError";
  }
}

async function readAndUpgradeReleaseArtifact(
  db: Firestore,
  gatewayId: string,
  release: number,
): Promise<GatewayArtifact> {
  const releaseRef = db
    .collection(GATEWAYS_COLLECTION)
    .doc(gatewayId)
    .collection(GATEWAY_RELEASES_SUBCOLLECTION)
    .doc(String(release));
  return db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(releaseRef);
    const data = snapshot.exists ? snapshot.data() as Record<string, unknown> | undefined : undefined;
    const upgrade = upgradeReleasePayloadSchema(data?.payload, data?.payloadHash);
    if (upgrade.status === "unsupported") {
      throw new ReleaseArtifactSchemaUnsupportedError(gatewayId, release, upgrade.reason);
    }
    if (upgrade.status === "upgraded") {
      transaction.update(releaseRef, {
        payload: upgrade.payload,
        payloadHash: upgrade.payloadHash,
      });
    }
    return gatewayArtifactFromReleasePayload(upgrade.payload);
  });
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
    const migrationConflict = findActiveGatewayMigration(
      args.gateway.gatewayId,
      activeOperations.docs.map((doc) => {
        const operation = doc.data() as Record<string, unknown>;
        return {
          id: doc.id,
          kind: typeof operation.kind === "string" ? operation.kind : "",
          status: typeof operation.status === "string" ? operation.status : "",
          input: operation.input,
          customerMigrationV2: operation.customerMigrationV2,
        };
      }),
    );
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
  "gcpProject",
  "gatewayContainerSecurityContext",
  "serviceAccountName",
  "serviceAccount",
  "operatorAccess",
  "ownerUid",
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
        expectedPrefixes: GATEWAY_IMAGE_REPO_PREFIXES,
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
  for (const uid of candidates) {
    const snap = await db.collection("users").doc(uid).get();
    if (!snap.exists) {
      return { status: 404, body: { error: ERR_OWNER_USER_NOT_FOUND, ownerUid: uid } };
    }
  }
  if (
    next.ownerUid !== previous.ownerUid
    || next.builderSlug !== previous.builderSlug
  ) {
    return validateBuilderWorkspaceOwner(db, next.ownerUid, next.builderSlug);
  }
  return null;
}

async function validateBuilderWorkspaceOwner(
  db: Firestore,
  ownerUid: string | null | undefined,
  builderSlug: string | null | undefined,
): Promise<RolloutBodyError | null> {
  if (!builderSlug) return builderWorkspaceOwnerError(ownerUid, builderSlug, undefined);
  const workspace = await db.collection("workspaces").doc(builderSlug).get();
  return builderWorkspaceOwnerError(
    ownerUid,
    builderSlug,
    workspace.exists ? workspace.data() as Record<string, unknown> : undefined,
  );
}

function builderWorkspaceOwnerError(
  ownerUid: string | null | undefined,
  builderSlug: string | null | undefined,
  workspace: Record<string, unknown> | undefined,
): RolloutBodyError | null {
  if (!ownerUid || !builderSlug) {
    return { status: 400, body: { error: "dedicated gateway requires ownerUid and builderSlug" } };
  }
  return workspace?.ownerUid === ownerUid
    ? null
    : {
        status: 400,
        body: {
          error: "builderSlug workspace owner does not match ownerUid",
          builderSlug,
          ownerUid,
        },
      };
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
    gcpProject: null,
    gatewayContainerSecurityContext: null,
    serviceAccountName: args.serviceAccountName ?? null,
    serviceAccount: args.serviceAccount ?? null,
    operatorAccess: args.operatorAccess ?? null,
    ownerUid: args.ownerUid ?? null,
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
  const artifact = await readAndUpgradeReleaseArtifact(db, gatewayId, gateway.latestRelease);
  return { gateway, artifact };
}

async function readRolloutCurrentConfigOrRespond(
  db: Firestore,
  gatewayId: string,
  res: Response,
): Promise<NonNullable<Awaited<ReturnType<typeof readRolloutCurrentConfig>>> | null> {
  try {
    const current = await readRolloutCurrentConfig(db, gatewayId);
    if (current) return current;
    res.status(404).json({ error: ERR_GATEWAY_NOT_FOUND, gatewayId });
    return null;
  } catch (error) {
    if (!(error instanceof ReleaseArtifactSchemaUnsupportedError)) throw error;
    res.status(409).json({
      error: "release artifact schema is unsupported",
      code: error.code,
      gatewayId: error.gatewayId,
      release: error.release,
      reason: error.reason,
    });
    return null;
  }
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
  const ownerUidPatched = Object.prototype.hasOwnProperty.call(args.body, "ownerUid");
  const builderSlugPatched = Object.prototype.hasOwnProperty.call(args.body, "builderSlug");
  if (
    args.current.gatewayClass !== "shared"
    && ownerUidPatched !== builderSlugPatched
  ) {
    return {
      error: {
        status: 400,
        body: { error: "ownerUid and builderSlug must be updated together" },
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
  const workspaceOwnerError = await validateBuilderWorkspaceOwner(
    opts.db,
    body.ownerUid,
    builderSlug,
  );
  if (workspaceOwnerError) return { error: workspaceOwnerError };

  return {
    ok: {
      ownerUid: body.ownerUid,
      builderSlug,
    },
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
  workspaceSlugsForUser: FleetRouterDeps["workspaceSlugsForUser"];
}): BuilderCandidate[] {
  const assigned = new Set<string>();

  for (const doc of opts.gatewayRoots) {
    const root = asDurableGatewayRoot(doc.data(), doc.id);
    if (!root) continue;
    const ownerUid = asStringOrNull(root.ownerUid);
    if (ownerUid) assigned.add(ownerUid);
  }

  const candidates = opts.users.map((doc) => {
    const data = doc.data();
    return {
      uid: doc.id,
      username: asStringOrNull(data.username) ?? "",
      email: asStringOrNull(data.email) ?? "",
      slug: resolveCustomerSlug(data, opts.workspaceSlugsForUser),
      assigned: assigned.has(doc.id),
    };
  });

  candidates.sort((a, b) =>
    (a.username || a.email).localeCompare(b.username || b.email, undefined, {
      sensitivity: "base",
    }),
  );
  return candidates;
}

async function accelerateScheduledCustomerErasure(opts: {
  db: Firestore;
  userRef: DocumentReference;
  lifecycle: Record<string, unknown>;
}): Promise<
  | { status: 202; body: Record<string, unknown> }
  | { status: 409; body: Record<string, unknown> }
> {
  const deletionId = asStringOrNull(opts.lifecycle.deletionId);
  if (!deletionId) {
    return {
      status: 409,
      body: { error: "Scheduled deletion is missing its deletion id" },
    };
  }
  const deletionRef = opts.db.collection(CUSTOMER_DELETION_JOBS_COLLECTION).doc(deletionId);
  const deletionSnap = await deletionRef.get();
  const deletion = deletionSnap.data() as Record<string, unknown> | undefined;
  const erasureOperationId = asStringOrNull(deletion?.erasureOperationId);
  if (!deletionSnap.exists || !erasureOperationId) {
    return {
      status: 409,
      body: {
        error: "Scheduled deletion is missing its durable erasure operation",
        deletionId,
      },
    };
  }
  const erasureRef = opts.db.collection(GLM_OPERATIONS_COLLECTION).doc(erasureOperationId);
  const erasureSnap = await erasureRef.get();
  const erasure = erasureSnap.data() as Record<string, unknown> | undefined;
  const runnable = erasureSnap.exists &&
    erasure?.kind === "erase-customer" &&
    (erasure.status === "pending" || erasure.status === "running");
  if (!runnable) {
    return {
      status: 409,
      body: {
        error: "Scheduled erasure operation is not runnable",
        deletionId,
        erasureOperationId,
      },
    };
  }
  const now = Date.now();
  const batch = opts.db.batch();
  batch.update(opts.userRef, { "accountLifecycle.eraseAfter": now });
  batch.update(deletionRef, { eraseAfter: now, updatedAt: now });
  batch.update(erasureRef, { nextAttemptAt: now });
  await batch.commit();
  return {
    status: 202,
    body: {
      status: "erasure_requested",
      deletionId,
      erasureOperationId,
      eraseAfter: now,
    },
  };
}

type CustomerDeletionAdmission =
  | { kind: "not-found" }
  | { kind: "conflict"; deletionId: string | null; operationId: string | null }
  | {
      kind: "created";
      deletionId: string;
      suspensionOperationId: string;
      erasureOperationId: string;
      eraseAfter: number;
      slug: string | null;
    };

async function claimCustomerDeletion(opts: {
  db: Firestore;
  uid: string;
  requestedBy: string;
  eraseNow: boolean;
  workspaceSlugsForUser: FleetRouterDeps["workspaceSlugsForUser"];
}): Promise<CustomerDeletionAdmission> {
  const userRef = opts.db.collection("users").doc(opts.uid);
  const deletionRef = opts.db.collection(CUSTOMER_DELETION_JOBS_COLLECTION).doc();
  const suspensionRef = opts.db.collection(GLM_OPERATIONS_COLLECTION).doc();
  const erasureRef = opts.db.collection(GLM_OPERATIONS_COLLECTION).doc();
  return opts.db.runTransaction(async (transaction) => {
    const userSnap = await transaction.get(userRef);
    if (!userSnap.exists) return { kind: "not-found" };
    const userData = userSnap.data() ?? {};
    const lifecycle = isPlainRecord(userData.accountLifecycle)
      ? userData.accountLifecycle
      : undefined;
    if (lifecycle?.status === "deletion_scheduled" || lifecycle?.status === "erasing") {
      return {
        kind: "conflict",
        deletionId: asStringOrNull(lifecycle.deletionId),
        operationId: null,
      };
    }
    const inFlight = await transaction.get(
      opts.db.collection(GLM_OPERATIONS_COLLECTION).where("inputUid", "==", opts.uid),
    );
    const conflict = inFlight.docs.find((doc) => {
      const data = doc.data() as { kind?: unknown; status?: unknown };
      return (
        (data.kind === "suspend-customer" || data.kind === "erase-customer") &&
        (data.status === "pending" || data.status === "running")
      );
    });
    if (conflict) {
      return {
        kind: "conflict",
        deletionId: null,
        operationId: conflict.id,
      };
    }
    const now = Date.now();
    const schedule = buildCustomerDeletionSchedule({ now, eraseNow: opts.eraseNow });
    const slug = resolveCustomerSlug(userData, opts.workspaceSlugsForUser);
    const currentGatewayId = readUserGatewayId(userData);
    const stripe = resolveStripeRefs(userData);
    const plan = buildCustomerDeletionPlan({
      uid: opts.uid,
      slug,
      currentGatewayId,
      requestedBy: opts.requestedBy,
      requestedAt: schedule.requestedAt,
      eraseAfter: schedule.eraseAfter,
      deletionId: deletionRef.id,
      suspensionOperationId: suspensionRef.id,
      erasureOperationId: erasureRef.id,
      stripeCustomerIds: stripe.customerIds,
      stripeSubscriptionIds: stripe.subscriptionIds,
    });
    transaction.update(userRef, {
      accountLifecycle: plan.lifecycle,
      ...(currentGatewayId
        ? {
            "provisioning.openclaw.gatewayId": FieldValue.delete(),
            "provisioning.openclaw.gatewayAssignedAt": FieldValue.delete(),
            "provisioning.openclaw.gatewayProfile": FieldValue.delete(),
            "provisioning.openclaw.shellsEnabled": FieldValue.delete(),
          }
        : {}),
    });
    transaction.set(deletionRef, plan.job);
    transaction.set(suspensionRef, plan.suspensionOperation);
    transaction.set(erasureRef, plan.erasureOperation);
    if (currentGatewayId) {
      transaction.delete(
        opts.db
          .collection(GATEWAYS_COLLECTION)
          .doc(currentGatewayId)
          .collection(GATEWAY_ASSIGNMENTS_SUBCOLLECTION)
          .doc(opts.uid),
      );
    }
    return {
      kind: "created",
      deletionId: deletionRef.id,
      suspensionOperationId: suspensionRef.id,
      erasureOperationId: erasureRef.id,
      eraseAfter: schedule.eraseAfter,
      slug,
    };
  });
}

type ActivationLeaseTerminationOutcome =
  | { kind: "not-found" }
  | { kind: "conflict"; reason: string }
  | { kind: "adopted" }
  | { kind: "requested" };

function activationLeaseForTermination(
  data: GlmDoc,
  leaseId: string,
  generation: number,
): NonNullable<ReturnType<typeof activationLeaseFromUser>> | null {
  const resolved = activationLeaseFromUser(data);
  if (
    !resolved ||
    resolved.lease.leaseId !== leaseId ||
    resolved.lease.generation !== generation
  ) {
    return null;
  }
  return resolved;
}

function sharedAssignmentServesBuilder(input: {
  exists: boolean;
  assignment: GlmDoc | undefined;
  uid: string;
  gatewayId: string;
}): boolean {
  return input.exists &&
    input.assignment?.uid === input.uid &&
    input.assignment.gatewayId === input.gatewayId &&
    input.assignment.state === "serving" &&
    Number.isSafeInteger(input.assignment.epoch);
}

function disposableRuntimeMatchesTermination(input: {
  exists: boolean;
  target: GlmDoc | undefined;
  uid: string;
  leaseId: string;
  generation: number;
}): boolean {
  const allocation = isPlainRecord(input.target?.allocation)
    ? input.target.allocation
    : null;
  return input.exists &&
    input.target?.ownerUid === input.uid &&
    allocation?.kind === "disposable-builder" &&
    allocation.claimedByUid === input.uid &&
    allocation.leaseId === input.leaseId &&
    allocation.generation === input.generation;
}

function terminationStatusAt(lease: GlmDoc): number | null {
  if (lease.status === "activating") return toMillis(lease.activatingAt);
  return toMillis(lease.provisionedAt ?? lease.requestedAt);
}

function runtimeTerminationCanStart(lease: GlmDoc, now: number): boolean {
  const statusAt = terminationStatusAt(lease);
  const stale = statusAt !== null &&
    now - statusAt > BUILDER_RUNTIME_STALE_AFTER_MS;
  return lease.status === "failed" || stale;
}

async function requestActivationLeaseTermination(
  db: Firestore,
  transaction: Transaction,
  input: {
    uid: string;
    leaseId: string;
    generation: number;
    defaultGatewayId: string;
    requestedAt: number;
    requestedBy: string;
  },
): Promise<ActivationLeaseTerminationOutcome> {
  const userRef = db.collection("users").doc(input.uid);
  const assignmentRef = db.doc(
    `gateways/${input.defaultGatewayId}/assignments/${input.uid}`,
  );
  const [userSnapshot, assignmentSnapshot] = await Promise.all([
    transaction.get(userRef),
    transaction.get(assignmentRef),
  ]);
  if (!userSnapshot.exists) return { kind: "not-found" };
  const data = userSnapshot.data() as GlmDoc;
  const resolved = activationLeaseForTermination(
    data,
    input.leaseId,
    input.generation,
  );
  if (!resolved) {
    return { kind: "conflict", reason: "lease generation changed" };
  }
  const { lease, openclaw } = resolved;
  const targetGatewayId = asStringOrNull(lease.targetGatewayId);
  if (
    !targetGatewayId ||
    asStringOrNull(openclaw.gatewayId) !== input.defaultGatewayId
  ) {
    return {
      kind: "conflict",
      reason: "Builder is not authoritative on the shared gateway",
    };
  }
  const assignment = assignmentSnapshot.exists
    ? assignmentSnapshot.data() as GlmDoc
    : undefined;
  if (!sharedAssignmentServesBuilder({
    exists: assignmentSnapshot.exists,
    assignment,
    uid: input.uid,
    gatewayId: input.defaultGatewayId,
  })) {
    return {
      kind: "conflict",
      reason: "canonical shared assignment is not serving",
    };
  }
  if (
    lease.status === "returning" &&
    toMillis(lease.operatorTerminateRequestedAt) !== null
  ) {
    return { kind: "adopted" };
  }
  const targetSnapshot = await transaction.get(
    db.collection(GATEWAYS_COLLECTION).doc(targetGatewayId),
  );
  const target = targetSnapshot.data() as GlmDoc | undefined;
  if (!disposableRuntimeMatchesTermination({
    exists: targetSnapshot.exists,
    target,
    uid: input.uid,
    leaseId: input.leaseId,
    generation: input.generation,
  })) {
    return {
      kind: "conflict",
      reason: "disposable runtime ownership changed",
    };
  }
  if (!runtimeTerminationCanStart(lease, input.requestedAt)) {
    return {
      kind: "conflict",
      reason: "runtime is neither failed nor stale",
    };
  }
  transaction.update(userRef, {
    "provisioning.openclaw.activationLease.status": "returning",
    "provisioning.openclaw.activationLease.returnRequestedAt": input.requestedAt,
    "provisioning.openclaw.activationLease.returnRequestedBy": input.requestedBy,
    "provisioning.openclaw.activationLease.operatorTerminateRequestedAt":
      input.requestedAt,
    "provisioning.openclaw.activationLease.operatorTerminateRequestedBy":
      input.requestedBy,
  });
  return { kind: "requested" };
}

// eslint-disable-next-line max-lines-per-function -- factory mounts ~15 admin routes; splitting it would scatter the contract across files for no readability gain
export function addAdminFleetRoutes(
  router: Router,
  deps: FleetRouterDeps,
): Router {
  const { db, logger } = deps;

  async function runAdminFleetMutation<T>(input: {
    req: Request;
    what: string;
    why: string;
    target: Record<string, unknown>;
    preActionStatus: Record<string, unknown>;
    mutation: Record<string, unknown>;
    action: () => Promise<T>;
    classifyResult?: (result: T) => NormalFleetMutationResult;
    idempotencyScope?: string;
  }): Promise<T> {
    const actor = input.req as ActorRequest;
    const headerKey = input.req.get("Idempotency-Key")?.trim();
    return runNormalFleetMutation(db as unknown as NormalFleetMutationDb, {
      actor: actor.uid ?? "unknown",
      forced: false,
      what: input.what,
      why: input.why,
      target: input.target,
      preActionStatus: input.preActionStatus,
      mutation: input.mutation,
      action: async () => input.action(),
      classifyResult: input.classifyResult,
      ...(headerKey
        ? { idempotencyKey: `${headerKey}:${input.idempotencyScope ?? input.what}` }
        : {}),
    });
  }

router.post(
    "/customer/:uid/delete",
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const uid = req.params.uid as string;
        const body = (req.body ?? {}) as { eraseNow?: unknown };
        if (body.eraseNow !== undefined && typeof body.eraseNow !== "boolean") {
          res.status(400).json({ error: "eraseNow must be a boolean" });
          return;
        }
        const userRef = db.collection("users").doc(uid);
        const userSnap = await userRef.get();
        if (!userSnap.exists) {
          res.status(404).json({ error: "User not found", uid });
          return;
        }
        const userData = userSnap.data() ?? {};
        const existingLifecycle = userData.accountLifecycle as
          | Record<string, unknown>
          | undefined;
        const existingStatus = existingLifecycle?.status;
        if (
          existingLifecycle &&
          (existingStatus === "deletion_scheduled" || existingStatus === "erasing")
        ) {
          if (existingStatus !== "deletion_scheduled" || body.eraseNow !== true) {
            res.status(409).json({
              error: "Cleanup already in progress",
              deletionId: existingLifecycle?.deletionId ?? null,
            });
            return;
          }
          const acceleration = await runAdminFleetMutation({
            req,
            what: "accelerate scheduled customer erasure",
            why: "Admin fleet request",
            target: { uid, deletionId: existingLifecycle.deletionId ?? null },
            preActionStatus: { lifecycleStatus: existingStatus },
            mutation: { kind: "accelerate-customer-erasure", uid },
            classifyResult: (result) => result.status >= 400
              ? {
                  outcome: "failed",
                  error: typeof result.body.error === "string"
                    ? result.body.error
                    : `customer erasure acceleration returned ${result.status}`,
                }
              : { outcome: "completed" },
            action: async () => accelerateScheduledCustomerErasure({
              db,
              userRef,
              lifecycle: existingLifecycle,
            }),
          });
          res.status(acceleration.status).json(acceleration.body);
          return;
        }
        const actor = req as ActorRequest;
        const admission = await runAdminFleetMutation({
          req,
          what: "schedule customer deletion",
          why: "Admin fleet request",
          target: { uid },
          preActionStatus: { lifecycleStatus: existingStatus ?? null },
          mutation: { kind: "schedule-customer-deletion", uid, eraseNow: body.eraseNow === true },
          classifyResult: (result) => {
            if (result.kind === "not-found") {
              return { outcome: "failed", error: "User not found" };
            }
            if (result.kind === "conflict") {
              return { outcome: "failed", error: "Cleanup already in progress" };
            }
            if (result.kind === "partial") {
              return {
                outcome: "partial",
                partialOutcome: {
                  summary: result.failedStep === "suspend-auth"
                    ? "customer deletion was scheduled but identity suspension failed"
                    : "customer deletion was scheduled but connector grant revocation failed",
                  details: {
                    uid,
                    failedStep: result.failedStep,
                    deletionId: result.claimed.deletionId,
                    suspensionOperationId: result.claimed.suspensionOperationId,
                    erasureOperationId: result.claimed.erasureOperationId,
                  },
                },
              };
            }
            return { outcome: "completed" };
          },
          action: async () => {
            const claimed = await claimCustomerDeletion({
              db,
              uid,
              requestedBy: actor.uid ?? "unknown",
              eraseNow: body.eraseNow === true,
              workspaceSlugsForUser: deps.workspaceSlugsForUser,
            });
            if (claimed.kind === "created") {
              try {
                await deps.suspendAuthUser(uid);
              } catch (error) {
                return {
                  kind: "partial" as const,
                  failedStep: "suspend-auth" as const,
                  claimed,
                  error: error instanceof Error ? error : new Error(String(error)),
                };
              }
              try {
                await deps.revokeConnectorGrantsForUser(uid);
              } catch (error) {
                return {
                  kind: "partial" as const,
                  failedStep: "revoke-connector-grants" as const,
                  claimed,
                  error: error instanceof Error ? error : new Error(String(error)),
                };
              }
            }
            return claimed;
          },
        });
        if (admission.kind === "partial") throw admission.error;
        if (admission.kind === "not-found") {
          res.status(404).json({ error: "User not found", uid });
          return;
        }
        if (admission.kind === "conflict") {
          res.status(409).json({
            error: "Cleanup already in progress",
            ...(admission.deletionId ? { deletionId: admission.deletionId } : {}),
            ...(admission.operationId ? { operationId: admission.operationId } : {}),
          });
          return;
        }

        logger.info(
          `[admin-delete] scheduled deletion=${admission.deletionId} uid=${uid} eraseAfter=${admission.eraseAfter}`,
        );
        res.status(202).json({
          status: "deletion_scheduled",
          deletionId: admission.deletionId,
          suspensionOperationId: admission.suspensionOperationId,
          erasureOperationId: admission.erasureOperationId,
          eraseAfter: admission.eraseAfter,
          slug: admission.slug,
        });
      } catch (e) {
        next(e);
      }
    },
  );

router.get(
    "/gateways",
    async (_req: Request, res: Response, next: NextFunction) => {
      try {
        const [gwSnap, glmSnap, usersSnap, operationsSnap, configSnap, settings] = await Promise.all([
          db.collection("gateways").get(),
          db.collection(GLM_GATEWAYS_COLLECTION).get(),
          db.collection("users").get(),
          db.collection(GLM_OPERATIONS_COLLECTION).get(),
          db.doc("config/orchestrator").get(),
          readFleetRuntimeSettings(),
        ]);
        const glmByGatewayId = indexAdminGatewayRuntimeDocs({
          gatewayDocs: gwSnap.docs,
          glmDocs: glmSnap.docs,
        });
        const operationsById = indexGlmDocs(operationsSnap.docs);
        const now = Date.now();
        const builderRuntimes = usersSnap.docs.flatMap((doc) => {
          const runtime = projectBuilderRuntime(
            doc,
            glmByGatewayId,
            operationsById,
            now,
          );
          return runtime ? [runtime] : [];
        });
        const visibleRetiredGatewayIds = new Set(
          builderRuntimes.flatMap((runtime) =>
            runtime.targetGatewayId &&
            (runtime.lifecycle === "failed" ||
              (runtime.cleanupOperationId &&
                runtime.cleanupOperationStatus !== "succeeded"))
              ? [runtime.targetGatewayId]
              : [],
          ),
        );
        for (const [gatewayId, gateway] of glmByGatewayId) {
          const retirementClaim = isPlainRecord(gateway.retirementClaim)
            ? gateway.retirementClaim
            : null;
          const operationId =
            asStringOrNull(retirementClaim?.operationId) ??
            `placement-retire-${asStringOrNull(gateway.ownerUid) ?? "unknown"}-${gatewayId}`;
          const cleanupStatus = operationsById.get(operationId)?.status;
          if (
            projectDesiredStatus(gateway) === "retired" &&
            projectDisposableRuntime(gateway) !== null &&
            cleanupStatus !== "succeeded"
          ) {
            visibleRetiredGatewayIds.add(gatewayId);
          }
        }
        const gatewayIds = new Set(glmByGatewayId.keys());
        const gatewayInputs = [...gatewayIds].flatMap((gatewayId) => {
          const glmDoc = glmByGatewayId.get(gatewayId);
          if (
            projectDesiredStatus(glmDoc) === "retired" &&
            !visibleRetiredGatewayIds.has(gatewayId)
          ) {
            return [];
          }
          const doc = effectiveHeartbeatDoc(gatewayId, glmDoc);
          if (
            !doc &&
            !shouldProjectDesiredOnlyGateway(glmDoc) &&
            !visibleRetiredGatewayIds.has(gatewayId)
          ) {
            return [];
          }
          return [{ doc: doc ?? syntheticGatewayDoc(gatewayId), glmDoc }];
        });
        const summaries = gatewayInputs.map(({ doc, glmDoc }) =>
          projectGatewaySummary(doc, glmDoc, now),
        );
        const readBatch = deps.readGatewayPodDiagnosticsBatch;
        const gateways = readBatch
          ? await projectGatewaySummariesWithDiagnostics(deps, summaries, readBatch)
          : await Promise.all(
              gatewayInputs.map(({ doc, glmDoc }) =>
                projectGatewaySummaryWithDiagnostics(deps, doc, glmDoc, now),
              ),
            );
        const gatewayById = new Map(
          gateways.map((gateway) => [gateway.gatewayId, gateway]),
        );
        const builderRuntimeViews = builderRuntimes.map((runtime) => {
          const target = runtime.targetGatewayId
            ? gatewayById.get(runtime.targetGatewayId)
            : undefined;
          const targetPodStatus = target?.podDiagnostics?.status ?? null;
          const targetPodCount = target?.podDiagnostics?.totalPods ?? null;
          return {
            ...runtime,
            targetPodStatus,
            targetPodCount,
            retryAvailable:
              runtime.lifecycle === "failed" &&
              runtime.cleanupOperationStatus === "succeeded" &&
              target?.desiredStatus === "retired" &&
              targetPodStatus === "missing" &&
              targetPodCount === 0,
          };
        });
        const defaultGatewayId = asStringOrNull(configSnap.data()?.defaultGatewayId);
        const parkedBuilders = usersSnap.docs.filter((doc) => {
          const resolved = activationLeaseFromUser(doc.data());
          return (
            resolved?.lease.status === "parked" &&
            asStringOrNull(resolved.openclaw.gatewayId) === defaultGatewayId
          );
        }).length;
        res.json({
          gateways,
          builderRuntimes: builderRuntimeViews,
          disposableCapacity: projectDisposableFleetCapacity(
            gateways,
            builderRuntimeViews,
            parkedBuilders,
          ),
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
        const [gatewaySnap, config] = await Promise.all([
          db.collection(GATEWAYS_COLLECTION).get(),
          readOnboardingRuntimeConfig(deps),
        ]);
        const gatewaysById = indexDurableGatewayRoots(gatewaySnap.docs);
        const parsed = parsePlacementPatch(
          req.body as Record<string, unknown>,
          gatewaysById,
        );
        if ("error" in parsed) {
          res.status(parsed.error.status).json(parsed.error.body);
          return;
        }
        const target = await readGatewayRegistrationReadiness(db, parsed.ok.defaultGatewayId);
        if (target.status !== "ready") {
          res.status(409).json({
            error: "default gateway must be ready",
            gatewayId: parsed.ok.defaultGatewayId,
            status: target.status ?? "unknown",
          });
          return;
        }
        const actor = req as ActorRequest;
        const createdBy = actor.uid ?? "unknown";
        await runAdminFleetMutation({
          req,
          what: "set default gateway placement",
          why: "Admin fleet request",
          target: { gatewayId: parsed.ok.defaultGatewayId },
          preActionStatus: { defaultGatewayId: config.defaultGatewayId || null },
          mutation: {
            kind: "set-default-gateway-placement",
            gatewayId: parsed.ok.defaultGatewayId,
          },
          action: async () => {
            await db.doc(FLEET_RUNTIME_CONFIG_DOC_PATH).set(
              {
                defaultGatewayId: parsed.ok.defaultGatewayId,
                placementUpdatedAt: Date.now(),
                placementUpdatedBy: createdBy,
              },
              { merge: true },
            );
          },
        });
        const defaultChange = await convergeDefaultGatewayChange({
          deps,
          gatewaysById,
          previousGatewayId: config.defaultGatewayId || null,
          targetGatewayId: parsed.ok.defaultGatewayId,
          createdBy,
          enqueueMigration: async (input) => {
            const uid = input.uid as string;
            const fromGatewayId = input.fromGatewayId as string;
            const toGatewayId = input.toGatewayId as string;
            return runAdminFleetMutation({
              req,
              what: "migrate builder after default placement change",
              why: "Admin fleet request",
              target: { uid, gatewayId: toGatewayId },
              preActionStatus: { gatewayId: fromGatewayId },
              mutation: {
                kind: OP_KIND_MIGRATE_CUSTOMER,
                uid,
                fromGatewayId,
                toGatewayId,
                source: "platform-default-change",
              },
              idempotencyScope: `default-placement-migration:${uid}`,
              action: async () => createOperation(db, {
                kind: OP_KIND_MIGRATE_CUSTOMER,
                createdBy,
                input,
              }),
            });
          },
        });
        const response = await readAdminOnboardingPlacementResponse(deps);
        res.json({ ...response, defaultChange });
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
          const operationInput = {
            uid,
            ...(builderSlug ? { builderSlug } : {}),
            ...(currentGatewayId ? { fromGatewayId: currentGatewayId } : {}),
            toGatewayId,
            source: "admin-bulk-repair",
          };
          const operationId = await runAdminFleetMutation({
            req,
            what: "migrate builder",
            why: "Admin bulk migration request",
            target: { uid, gatewayId: toGatewayId },
            preActionStatus: { gatewayId: currentGatewayId ?? null },
            mutation: {
              kind: OP_KIND_MIGRATE_CUSTOMER,
              uid,
              ...(currentGatewayId ? { fromGatewayId: currentGatewayId } : {}),
              toGatewayId,
              source: "admin-bulk-repair",
            },
            idempotencyScope: `bulk-migration:${uid}`,
            action: async () => createOperation(db, {
              kind: OP_KIND_MIGRATE_CUSTOMER,
              createdBy,
              input: operationInput,
            }),
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
        const [usersSnap, gatewaySnap] = await Promise.all([
          db.collection("users").get(),
          db.collection(GATEWAYS_COLLECTION).get(),
        ]);
        const candidates = buildBuilderCandidates({
          users: usersSnap.docs,
          gatewayRoots: gatewaySnap.docs,
          workspaceSlugsForUser: deps.workspaceSlugsForUser,
        });
        res.json({ candidates, generatedAt: new Date().toISOString() });
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
        const targetGatewayId = body.gatewayId;
        const userSnap = await db.collection("users").doc(uid).get();
        if (!userSnap.exists) {
          res.status(404).json({ error: ERR_USER_NOT_FOUND, uid });
          return;
        }
        const userData = (userSnap.data() ?? {}) as {
          provisioning?: { openclaw?: { gatewayId?: string; gatewayProfile?: unknown } };
        };
        const target = await readDurableGatewayRuntime(db, targetGatewayId);
        if (!target) {
          res.status(404).json({
            error: ERR_GATEWAY_NOT_FOUND,
            gatewayId: targetGatewayId,
          });
          return;
        }
        if (target.root.desiredStatus !== "running") {
          res.status(409).json({
            error: "target gateway not ready",
            gatewayId: targetGatewayId,
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
        const placement = await runAdminFleetMutation({
          req,
          what: "assign builder to gateway",
          why: "Admin fleet request",
          target: { uid, gatewayId: targetGatewayId },
          preActionStatus: { gatewayId: currentGid ?? null },
          mutation: {
            kind: "assign-customer",
            uid,
            gatewayId: targetGatewayId,
            assignmentWrite: currentGid === targetGatewayId ? "create-if-missing" : "upsert",
          },
          classifyResult: (result) => result.kind === "rejected"
            ? { outcome: "failed", error: `target revision not placeable: ${result.reason}` }
            : { outcome: "completed" },
          action: async () => commitPlacementAtomic(db as unknown as PlacementFirestore, {
            uid,
            slug,
            gatewayId: targetGatewayId,
            source: "repair",
            now: Date.now(),
            assignmentWrite: currentGid === targetGatewayId ? "create-if-missing" : "upsert",
            mirrorPatch: {
              "provisioning.openclaw.gatewayId": targetGatewayId,
              "provisioning.openclaw.gatewayProfile": gatewayProfile,
              "provisioning.openclaw.shellsEnabled": shellState.shellsEnabled,
            },
          }),
        });
        if (placement.kind === "rejected") {
          res.status(409).json({
            error: `target revision not placeable: ${placement.reason}`,
            gatewayId: targetGatewayId,
            reason: placement.reason,
          });
          return;
        }
        res.status(currentGid === targetGatewayId ? 200 : 202).json({
          uid,
          gatewayId: targetGatewayId,
          gatewayProfile,
          ...(currentGid === targetGatewayId ? { repaired: true } : {}),
        });
      } catch (e) {
        next(e);
      }
    },
  );

router.post(
    "/customers/:uid/activation-lease/terminate",
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const body = isPlainRecord(req.body) ? req.body : {};
        const allowed = new Set(["leaseId", "generation"]);
        if (
          Object.keys(body).some((key) => !allowed.has(key)) ||
          typeof body.leaseId !== "string" ||
          !Number.isSafeInteger(body.generation) ||
          (body.generation as number) <= 0
        ) {
          res.status(400).json({ error: "leaseId and generation are required" });
          return;
        }
        const uid = req.params.uid as string;
        const actor = req as ActorRequest;
        const leaseId = body.leaseId;
        const generation = body.generation as number;
        const now = Date.now();
        const config = await db.doc("config/orchestrator").get();
        const defaultGatewayId = asStringOrNull(config.data()?.defaultGatewayId);
        if (!defaultGatewayId) {
          res.status(409).json({ error: "default gateway is unavailable" });
          return;
        }
        const outcome = await runAdminFleetMutation({
          req,
          what: "terminate builder activation lease",
          why: "Admin fleet request",
          target: { uid, leaseId, generation },
          preActionStatus: { defaultGatewayId },
          mutation: { kind: "terminate-activation-lease", uid, leaseId, generation },
          classifyResult: (result) => result.kind === "not-found"
            ? { outcome: "failed", error: ERR_USER_NOT_FOUND }
            : result.kind === "conflict"
              ? { outcome: "failed", error: result.reason }
              : result.kind === "adopted"
                ? {
                    outcome: "failed",
                    error: "activation lease termination was already requested",
                  }
                : { outcome: "completed" },
          action: async () => db.runTransaction((transaction) =>
            requestActivationLeaseTermination(db, transaction, {
              uid,
              leaseId,
              generation,
              defaultGatewayId,
              requestedAt: now,
              requestedBy: actor.uid ?? "unknown",
            })
          ),
        });
        if (outcome.kind === "not-found") {
          res.status(404).json({ error: ERR_USER_NOT_FOUND, uid });
          return;
        }
        if (outcome.kind === "conflict") {
          res.status(409).json({ error: outcome.reason });
          return;
        }
        res.status(outcome.kind === "adopted" ? 200 : 202).json({
          status: "termination-requested",
          leaseId,
          generation,
          ...(outcome.kind === "adopted" ? { adopted: true } : {}),
        });
      } catch (e) {
        next(e);
      }
    },
  );

router.post(
    "/customers/:uid/activation-lease/return",
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const body = isPlainRecord(req.body) ? req.body : {};
        const allowed = new Set(["leaseId", "generation"]);
        if (
          Object.keys(body).some((key) => !allowed.has(key)) ||
          typeof body.leaseId !== "string" ||
          !Number.isSafeInteger(body.generation) ||
          (body.generation as number) <= 0
        ) {
          res.status(400).json({ error: "leaseId and generation are required" });
          return;
        }
        const uid = req.params.uid as string;
        const actor = req as ActorRequest;
        const userRef = db.collection("users").doc(uid);
        const requestedAt = Date.now();
        const outcome = await runAdminFleetMutation({
          req,
          what: "return builder activation lease",
          why: "Admin fleet request",
          target: { uid, leaseId: body.leaseId, generation: body.generation },
          preActionStatus: {},
          mutation: {
            kind: "return-activation-lease",
            uid,
            leaseId: body.leaseId,
            generation: body.generation,
          },
          classifyResult: (result) => result.kind === "not-found"
            ? { outcome: "failed", error: ERR_USER_NOT_FOUND }
            : result.kind === "conflict"
              ? { outcome: "failed", error: "activation lease is not the requested active generation" }
              : result.kind === "adopted"
                ? {
                    outcome: "failed",
                    error: "activation lease return was already requested",
                  }
                : { outcome: "completed" },
          action: async () => db.runTransaction(async (transaction) => {
            const snapshot = await transaction.get(userRef);
            if (!snapshot.exists) return { kind: "not-found" as const };
            const data = snapshot.data() as Record<string, unknown>;
            const resolved = activationLeaseFromUser(data);
            const lease = resolved?.lease;
            if (
              !lease ||
              lease.leaseId !== body.leaseId ||
              lease.generation !== body.generation ||
              lease.status !== "active"
            ) {
              return {
                kind: "conflict" as const,
                status: asStringOrNull(lease?.status),
              };
            }
            if (toMillis(lease.returnRequestedAt) !== null) {
              return { kind: "adopted" as const };
            }
            transaction.update(userRef, {
              "provisioning.openclaw.activationLease.returnRequestedAt": requestedAt,
              "provisioning.openclaw.activationLease.returnRequestedBy":
                actor.uid ?? "unknown",
            });
            return { kind: "requested" as const };
          }),
        });
        if (outcome.kind === "not-found") {
          res.status(404).json({ error: ERR_USER_NOT_FOUND, uid });
          return;
        }
        if (outcome.kind === "conflict") {
          res.status(409).json({
            error: "activation lease is not the requested active generation",
            status: outcome.status,
          });
          return;
        }
        res.status(outcome.kind === "adopted" ? 200 : 202).json({
          status: "return-requested",
          leaseId: body.leaseId,
          generation: body.generation,
          ...(outcome.kind === "adopted" ? { adopted: true } : {}),
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
        const userSnap = await db.collection("users").doc(uid).get();
        if (!userSnap.exists) {
          res.status(404).json({ error: ERR_USER_NOT_FOUND, uid });
          return;
        }
        const reportingGatewayId = readUserGatewayId(
          userSnap.data() as Record<string, unknown>,
        );
        const assignmentSnap = reportingGatewayId
          ? await db.doc(
              `gateways/${reportingGatewayId}/assignments/${uid}`,
            ).get()
          : null;
        const assignmentData = assignmentSnap?.exists
          ? assignmentSnap.data() as Record<string, unknown>
          : undefined;
        const assignmentEpoch =
          typeof assignmentData?.epoch === "number"
            ? assignmentData.epoch
            : undefined;
        const result = await runAdminFleetMutation({
          req,
          what: "request builder activation lease",
          why: "Admin fleet request",
          target: { uid },
          preActionStatus: {
            gatewayId: reportingGatewayId ?? null,
            assignmentEpoch: assignmentEpoch ?? null,
          },
          mutation: { kind: "request-activation-lease", uid },
          classifyResult: (result) => result.statusCode >= 400
            ? {
                outcome: "failed",
                error: typeof result.body.error === "string"
                  ? result.body.error
                  : `activation lease request returned ${result.statusCode}`,
              }
            : { outcome: "completed" },
          action: async () => requestBuilderActivationLease({
            db,
            uid,
            reportingGatewayId: reportingGatewayId ?? undefined,
            assignmentEpoch,
            eventKey: `manual:${createdBy}:${now}`,
            cause: "manual",
            observedAt: now,
            createdBy,
            now,
          }),
        });
        res.status(result.statusCode).json(result.body);
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
        const config = buildCreateGatewayConfig({
          body,
          gatewayClass,
          imageProfile,
          ownerUid: owner.ok.ownerUid,
          builderSlug: owner.ok.builderSlug,
          operatorAccess: ownerRuntimeDefaults.operatorAccess,
          serviceAccountName: operatorDefaults.serviceAccountName,
          serviceAccount: operatorDefaults.serviceAccount,
        });
        const artifact = buildCreateArtifact(body);
        let operationId: string;
        try {
          const result = await runAdminFleetMutation({
            req,
            what: "add gateway",
            why: "Admin fleet request",
            target: { gatewayId: body.gatewayId },
            preActionStatus: { exists: false },
            mutation: {
              kind: "add-gateway",
              gatewayId: body.gatewayId,
              imageTag: body.imageTag,
              gatewayClass,
              imageProfile,
              desiredStatus: "running",
            },
            classifyResult: (outcome) => {
              if (outcome.kind === "partial") {
                if (outcome.failedStep === "initial-release") {
                  return {
                    outcome: "partial",
                    partialOutcome: {
                      summary: "gateway auth secret was provisioned but its initial release was not created",
                      details: {
                        gatewayId: body.gatewayId,
                        failedStep: outcome.failedStep,
                      },
                    },
                  };
                }
                return {
                  outcome: "partial",
                  partialOutcome: {
                    summary: "gateway release was created but its rollout operation could not be enqueued",
                    details: {
                      gatewayId: body.gatewayId,
                      release: 1,
                      failedStep: outcome.failedStep,
                    },
                  },
                  releaseRollout: {
                    releaseId: `${body.gatewayId}/1`,
                    releaseTag: artifact.imageTag,
                  },
                };
              }
              return {
                outcome: "completed",
                releaseRollout: {
                  releaseId: `${body.gatewayId}/1`,
                  releaseTag: artifact.imageTag,
                  rolloutOperationId: outcome.operationId,
                },
              };
            },
            action: async () => {
              try {
                await deps.provisionGatewayAuthSecret({
                  gatewayId: body.gatewayId,
                  gatewayServiceAccount,
                });
              } catch (error) {
                throw new GatewayAuthSecretProvisionError(
                  error instanceof Error ? error.message : String(error),
                );
              }
              try {
                await writeInitialGatewayRelease(db, {
                  gatewayId: body.gatewayId,
                  createdBy,
                  now,
                  desiredStatus: "running",
                  config,
                  artifact,
                });
              } catch (error) {
                return {
                  kind: "partial" as const,
                  failedStep: "initial-release" as const,
                  error: error instanceof Error ? error : new Error(String(error)),
                };
              }
              try {
                return {
                  kind: "completed" as const,
                  operationId: await createOperation(db, {
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
                  }),
                };
              } catch (error) {
                return {
                  kind: "partial" as const,
                  failedStep: "rollout-operation" as const,
                  error: error instanceof Error ? error : new Error(String(error)),
                };
              }
            },
          });
          if (result.kind === "partial") throw result.error;
          operationId = result.operationId;
        } catch (e) {
          if (e instanceof GatewayAuthSecretProvisionError) {
            res.status(502).json({
              error: "failed to provision gateway auth-token secret",
              gatewayId: body.gatewayId,
              detail: e.message,
            });
            return;
          }
          if (e instanceof InitialGatewayReleaseConflictError) {
            res.status(409).json({
              error: "gateway already exists",
              gatewayId: e.gatewayId,
            });
            return;
          }
          throw e;
        }
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
        const patchResult = await runAdminFleetMutation({
          req,
          what: "update gateway desired configuration",
          why: "Admin fleet request",
          target: { gatewayId: id },
          preActionStatus: {
            desiredStatus: root.desiredStatus,
            desiredRelease: root.desiredRelease,
          },
          mutation: { kind: "patch-gateway", gatewayId: id, patch: built.ok.patch },
          classifyResult: (result) => result.ok
            ? { outcome: "completed" }
            : { outcome: "failed", error: result.error },
          action: async () => db.runTransaction(async (txn) => {
            const [currentSnap, activeOperations] = await Promise.all([
              txn.get(rootRef),
              txn.get(
                db
                  .collection(GLM_OPERATIONS_COLLECTION)
                  .where("status", "in", ["pending", "running"]),
              ),
            ]);
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
            const migrationConflict = findActiveGatewayMigration(
              id,
              activeOperations.docs.map((doc) => {
                const operation = doc.data() as Record<string, unknown>;
                return {
                  id: doc.id,
                  kind: typeof operation.kind === "string" ? operation.kind : "",
                  status: typeof operation.status === "string" ? operation.status : "",
                  input: operation.input,
                  customerMigrationV2: operation.customerMigrationV2,
                };
              }),
            );
            if (migrationConflict) {
              return {
                ok: false as const,
                error: `customer migration is in flight for gateway ${id}`,
              };
            }
            txn.update(rootRef, {
              ...built.ok.patch,
              updatedAt: Date.now(),
              updatedBy,
            });
            return { ok: true as const };
          }),
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
        const disposable = projectDisposableRuntime(
          runtime.root as unknown as GlmDoc,
        );
        if (disposable) {
          res.status(409).json({
            error:
              "disposable gateway termination is owned by the Builder runtime lifecycle",
            gatewayId: id,
          });
          return;
        }
        const retirementBlocker = gatewayRetirementBlocker(id, runtime);
        if (retirementBlocker) {
          res.status(409).json(retirementBlocker);
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
          await runAdminFleetMutation({
            req,
            what: "retire gateway",
            why: "Admin fleet request",
            target: { gatewayId: id },
            preActionStatus: {
              desiredStatus: runtime.root.desiredStatus,
              desiredRelease: runtime.root.desiredRelease,
            },
            mutation: {
              kind: "retire-gateway",
              gatewayId: id,
              ...(retainData ? { retainData: true } : {}),
              ...(retainServiceAccount ? { retainServiceAccount: true } : {}),
            },
            action: async () => claimGatewayRetirementAtomic({
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
            }),
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

        const operationId = await runAdminFleetMutation({
          req,
          what: "restart gateway",
          why: "Admin fleet request",
          target: { gatewayId: id },
          preActionStatus: {
            desiredStatus: gateway.desiredStatus,
            desiredRelease: gateway.desiredRelease,
          },
          mutation: { kind: "restart-gateway", gatewayId: id },
          action: async () => createOperation(db, {
            kind: "restart-gateway",
            createdBy: (req as ActorRequest).uid ?? "unknown",
            input: { gatewayId: id },
          }),
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

        const current = await readRolloutCurrentConfigOrRespond(db, id, res);
        if (!current) return;
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
          recorded = await runAdminFleetMutation({
            req,
            what: "roll out gateway image",
            why: "Admin fleet request",
            target: { gatewayId: id },
            preActionStatus: {
              desiredStatus: rolloutGateway.desiredStatus,
              desiredRelease: rolloutGateway.desiredRelease,
              imageTag: current.artifact.imageTag,
            },
            mutation: {
              kind: "rollout-gateway",
              gatewayId: id,
              imageTag: artifact.imageTag,
              imageRepository: artifact.imageRepository,
            },
            action: async () => recordRolloutRelease(db, {
              gateway: rolloutGateway,
              patch,
              createdBy: actor.uid ?? "unknown",
            }),
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
          appended = await runAdminFleetMutation({
            req,
            what: "cut gateway release",
            why: "Admin fleet request",
            target: { gatewayId: id },
            preActionStatus: {
              latestRelease: gateway.latestRelease,
              desiredRelease: gateway.desiredRelease,
            },
            mutation: {
              kind: "cut-gateway-release",
              gatewayId: id,
              sourceRelease: gateway.latestRelease,
              artifact,
              note,
            },
            action: async () => appendGatewayRelease(db, {
              gateway,
              artifact,
              createdBy,
              now,
              sourceRelease: gateway.latestRelease,
              note,
            }),
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
          appended = await runAdminFleetMutation({
            req,
            what: "roll back gateway release",
            why: "Admin fleet request",
            target: { gatewayId: id, release },
            preActionStatus: {
              latestRelease: gateway.latestRelease,
              desiredRelease: gateway.desiredRelease,
            },
            mutation: {
              kind: "rollback-gateway-release",
              gatewayId: id,
              sourceRelease: release,
              artifact,
              note,
            },
            action: async () => appendGatewayRelease(db, {
              gateway,
              artifact,
              createdBy,
              now,
              sourceRelease: release,
              note,
            }),
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
        const operationId = await runAdminFleetMutation({
          req,
          what: "migrate builder",
          why: "Admin fleet request",
          target: { uid, gatewayId: body.to },
          preActionStatus: { gatewayId: currentGatewayId ?? null },
          mutation: {
            kind: OP_KIND_MIGRATE_CUSTOMER,
            uid,
            ...(currentGatewayId ? { fromGatewayId: currentGatewayId } : {}),
            toGatewayId: body.to,
          },
          action: async () => createOperation(db, {
            kind: OP_KIND_MIGRATE_CUSTOMER,
            createdBy,
            input: {
              uid,
              ...(builderSlug ? { builderSlug } : {}),
              ...(currentGatewayId ? { fromGatewayId: currentGatewayId } : {}),
              toGatewayId: body.to,
            },
          }),
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
        const userBefore = await db.collection("users").doc(uid).get();
        const preActionGatewayId = userBefore.exists
          ? readUserGatewayId(userBefore.data() as Record<string, unknown> | undefined)
          : null;
        const outcome = await runAdminFleetMutation({
          req,
          what: "unassign builder from gateway",
          why: "Admin fleet request",
          target: { uid },
          preActionStatus: { gatewayId: preActionGatewayId },
          mutation: {
            kind: "unassign-customer",
            uid,
            ...(preActionGatewayId ? { gatewayId: preActionGatewayId } : {}),
          },
          classifyResult: (result) => result.status >= 400
            ? {
                outcome: "failed",
                error: typeof result.body.error === "string"
                  ? result.body.error
                  : `unassign returned ${result.status}`,
              }
            : { outcome: "completed" },
          action: async () => db.runTransaction<{
            status: number;
            body: Record<string, unknown>;
            from?: string;
          }>(async (txn) => {
          const userRef = db.collection("users").doc(uid);
          const userSnap = await txn.get(userRef);
          if (!userSnap.exists) {
            return { status: 404, body: { error: ERR_USER_NOT_FOUND, uid } };
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
          if (assignment && assignment.state !== "serving") {
            return {
              status: 409,
              body: {
                error: `customer is mid-migration (roster state ${assignment.state}) — cannot unassign until the migration settles`,
                uid,
                state: assignment.state,
              },
            };
          }
          // Drop the durable assignment AND the mirror together, so no stale
          // roster entry outlives the placement and no stale
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
            },
            from: currentGatewayId,
          };
          }),
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
          gatewayId: string;
          imageTag: string;
        }>;
        if (
          typeof body.gatewayId !== "string" ||
          body.gatewayId.length === 0 ||
          typeof body.imageTag !== "string" ||
          body.imageTag.length === 0
        ) {
          res.status(400).json({
            error: "missing required fields",
            required: ["gatewayId", "imageTag"],
          });
          return;
        }
        const actor = req as ActorRequest;
        const createdBy = actor.uid ?? "unknown";
        const operationId = await runAdminFleetMutation({
          req,
          what: "roll out gateway image",
          why: "Admin fleet request",
          target: { gatewayId: body.gatewayId },
          preActionStatus: {},
          mutation: {
            kind: "rollout",
            gatewayId: body.gatewayId,
            imageTag: body.imageTag,
          },
          action: async () => createOperation(db, {
            kind: "rollout",
            createdBy,
            input: {
              gatewayId: body.gatewayId,
              imageTag: body.imageTag,
            },
          }),
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
        const operations = snap.docs.map((doc) =>
          shapeOperationsHistoryRecord(doc.id, doc.data() as Record<string, unknown>),
        );
        res.json({ operations, generatedAt: new Date().toISOString() });
      } catch (e) {
        next(e);
      }
    },
  );

  router.use((error: unknown, _req: Request, res: Response, next: NextFunction) => {
    if (error instanceof FleetMutationFrozenError) {
      res.status(409).json({ error: error.message });
      return;
    }
    if (error instanceof FleetMutationMaintenanceUnavailableError) {
      res.status(503).json({ error: error.message });
      return;
    }
    if (error instanceof FleetMutationIdempotencyError) {
      res.status(409).json({
        error: error.message,
        auditId: error.auditId,
        status: error.status,
      });
      return;
    }
    if (error instanceof OperationAuditIdempotencyConflictError) {
      res.status(409).json({
        error: error.message,
        auditId: error.auditId,
      });
      return;
    }
    next(error);
  });

  return router;
}
