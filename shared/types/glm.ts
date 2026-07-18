import type { SizingTier } from "./sizing.js";
import type { ConfigCandidateProofResponse } from "./fleet-controller.js";

export type GatewayDesiredStatus = "running" | "paused" | "draining" | "retired";

export const GATEWAY_PROFILES = ["standard", "operator"] as const;
export type GatewayProfile = (typeof GATEWAY_PROFILES)[number];

export const GATEWAY_CLASSES = ["shared", "builder", "operator"] as const;
export type GatewayClass = (typeof GATEWAY_CLASSES)[number];

export const GATEWAY_IMAGE_PROFILES = ["standard", "operator"] as const;
export type GatewayImageProfile = (typeof GATEWAY_IMAGE_PROFILES)[number];

export interface GatewayDesiredState {
  gatewayId: string;

  /**
   * Durable identity this instance belongs to (`default`, `bender`) — bare,
   * never blue/green-suffixed. Explicit on every instance written after the
   * gateway field landed; older docs derive it from gatewayId by convention
   * via deriveGatewayIdentity until backfilled.
   */
  gateway?: string;

  imageRepository: string;
  imageTag: string;

  /**
   * Legacy overloaded image/capability selector. Keep for compatibility with
   * already-authored desired-state docs and API clients. New callers should set
   * gatewayClass + imageProfile explicitly.
   */
  profile?: GatewayProfile;
  gatewayClass?: GatewayClass;
  imageProfile?: GatewayImageProfile;
  desiredStatus: GatewayDesiredStatus;

  createdBy: string;

  retireAfter?: number;

  serviceAccountName?: string;
  serviceAccount?: GatewayServiceAccountSpec;

  gcpProject?: string;

  gatewayContainerSecurityContext?: Record<string, unknown>;

  operatorAccess?: OperatorGatewayAccessSpec;

  operatorReservation?: OperatorGatewayReservationSpec;

  lastError?: { at: number; message: string } | null;

  openclawOverrides?: Record<string, unknown>;

  ownerUid?: string;

  coOwnerUids?: string[];

  builderSlug?: string;

  sizingTier?: SizingTier;
  computeClass?: string;

  modelBrokerLimits?: GatewayModelBrokerLimits;

  preemption?: GatewayPreemptionSpec;

  preemptionHandoff?: GatewayPreemptionHandoffSpec;
}

export interface GatewayModelBrokerLimits {
  spendWindowUsd?: number | null;
  spendWeekUsd?: number | null;
  requestsPerMinute?: number | null;
}

export interface GatewayPreemptionSpec {
  warmTargetGatewayId?: string;
}

export interface GatewayPreemptionHandoffSpec {
  status?: "requested" | "waking-target" | "queued" | "failed" | "ignored";
  sourceGatewayId?: string;
  targetGatewayId?: string;
  reason?: string;
  requestedAt?: unknown;
  queuedAt?: unknown;
  operationId?: string;
  flushCompletedAt?: unknown;
  flushOk?: boolean;
}

export interface GatewayServiceAccountSpec {
  create?: boolean;
  annotations?: Record<string, string>;
}

export interface OperatorGatewayAccessSpec {
  shellsEnabled?: boolean;
  controlUiEnabled?: boolean;
  platformMetadataEgress?: boolean;
  kubeApiServerEgressCidrs?: string[];
  reason?: string;
  verifiedAt?: number;
  verifiedBy?: string;
}

export const OPERATOR_GATEWAY_RESERVATION_STATUSES = [
  "reserved",
  "provisioning",
  "active",
  "suspended",
  "released",
] as const;
export type OperatorGatewayReservationStatus =
  (typeof OPERATOR_GATEWAY_RESERVATION_STATUSES)[number];

export const OPERATOR_GATEWAY_RESERVATION_BILLING_STATUSES = [
  "manual",
  "pending",
  "active",
] as const;
export type OperatorGatewayReservationBillingStatus =
  (typeof OPERATOR_GATEWAY_RESERVATION_BILLING_STATUSES)[number];

export interface OperatorGatewayReservationSpec {
  status: OperatorGatewayReservationStatus;
  reservedAt: number;
  reservedBy: string;
  billingStatus?: OperatorGatewayReservationBillingStatus;
  billingVerifiedAt?: number;
  activatedAt?: number;
  activatedBy?: string;
}

export const OPERATOR_GATEWAY_RESERVATIONS_COLLECTION =
  "operatorGatewayReservations";

export const OPERATOR_GATEWAY_RESERVATION_REQUEST_STATUSES = [
  "billing_pending",
  "requested",
  "provisioning",
  "fulfilled",
  "cancelled",
] as const;
export type OperatorGatewayReservationRequestStatus =
  (typeof OPERATOR_GATEWAY_RESERVATION_REQUEST_STATUSES)[number];

export interface OperatorGatewayReservationRequest {
  uid: string;
  builderSlug: string;
  requestedSizingTier: SizingTier;
  status: OperatorGatewayReservationRequestStatus;
  billingStatus: OperatorGatewayReservationBillingStatus;
  currentGatewayId?: string;
  currentGatewayProfile?: GatewayProfile;
  gatewayId?: string;
  operationId?: string;
  provisioningStartedAt?: number;
  provisioningStartedBy?: string;
  activationOperationId?: string;
  activationStartedAt?: number;
  activationStartedBy?: string;
  fulfilledAt?: number;
  fulfilledByOperationId?: string;
  requestedAt: number;
  updatedAt: number;
}

export interface OperatorGatewayReservationRequestResponse {
  reservation: OperatorGatewayReservationRequest | null;
}

export const OPERATOR_GATEWAY_LOCKED_ACCESS: OperatorGatewayAccessSpec = {
  shellsEnabled: false,
  controlUiEnabled: false,
  reason: "runtime-trust-boundary-not-provisioned",
};

export function defaultOperatorGatewayAccess(
  ownerUid: string | null | undefined,
  shellsEnabled = true,
): OperatorGatewayAccessSpec {
  return ownerUid
    ? {
      shellsEnabled,
      controlUiEnabled: true,
      reason: "owned-runtime-gateway",
    }
    : OPERATOR_GATEWAY_LOCKED_ACCESS;
}

export function resolveOperatorGatewayAccess(
  ownerUid: string | null | undefined,
  operatorAccess: OperatorGatewayAccessSpec | null | undefined,
): OperatorGatewayAccessSpec {
  return {
    ...defaultOperatorGatewayAccess(ownerUid),
    ...(operatorAccess ?? {}),
  };
}

export const OPERATOR_GATEWAY_SERVICE_ACCOUNT_PREFIX = "octogee-gw-";
export const GATEWAY_PLATFORM_SERVICE_ACCOUNT_NAME = "octogee-gateway";
export const GATEWAY_ID_MAX_LENGTH = 32;
export const GATEWAY_ID_REQUIREMENT =
  "gatewayId must be a lowercase DNS-safe id, 1-32 chars, starting and ending with a letter or digit";

export const OPERATOR_GATEWAY_LOCKED_SERVICE_ACCOUNT: GatewayServiceAccountSpec = {
  create: true,
};

export function isValidGatewayId(id: unknown): id is string {
  if (typeof id !== "string" || id.length === 0 || id.length > GATEWAY_ID_MAX_LENGTH) {
    return false;
  }
  if (!isGatewayIdEndpoint(id.charCodeAt(0))) return false;
  if (!isGatewayIdEndpoint(id.charCodeAt(id.length - 1))) return false;
  for (let i = 1; i < id.length - 1; i += 1) {
    const code = id.charCodeAt(i);
    if (!isGatewayIdEndpoint(code) && code !== 45) return false;
  }
  return true;
}

function isGatewayIdEndpoint(code: number): boolean {
  return (code >= 97 && code <= 122) || (code >= 48 && code <= 57);
}

const ROLL_ROLE_SUFFIXES = ["-blue", "-green"] as const;

export const NEW_GATEWAY_ID_REQUIREMENT =
  `${GATEWAY_ID_REQUIREMENT}; the -blue/-green suffixes are reserved for roll roles`;

// Creation-time validator: roll-role suffixes are reserved so the
// deriveGatewayIdentity convention fallback is safe by construction.
// Instance ids minted by the blue/green machinery (default-blue) stay valid
// under isValidGatewayId for routing and reconciliation.
export function isValidNewGatewayId(id: unknown): id is string {
  if (!isValidGatewayId(id)) return false;
  return !ROLL_ROLE_SUFFIXES.some((suffix) => id.endsWith(suffix));
}

// Resolves the durable gateway identity for an instance: the explicit
// `gateway` field when present, else a naming-convention fallback that
// strips a trailing -blue/-green roll-role suffix. Instance ids without that
// suffix are their own bare identity (dedicated gateways, never rolled).
export function deriveGatewayIdentity(
  gatewayId: string,
  explicitGateway?: unknown,
): string {
  if (typeof explicitGateway === "string" && explicitGateway.length > 0) {
    return explicitGateway;
  }
  for (const suffix of ROLL_ROLE_SUFFIXES) {
    if (gatewayId.endsWith(suffix)) return gatewayId.slice(0, -suffix.length);
  }
  return gatewayId;
}

export function operatorGatewayServiceAccountName(gatewayId: string): string {
  return `${OPERATOR_GATEWAY_SERVICE_ACCOUNT_PREFIX}${gatewayId}`;
}

export function isOperatorGatewayShellAccessEnabled(
  profile: GatewayProfile | undefined,
  operatorAccess: OperatorGatewayAccessSpec | undefined,
): boolean {
  return profile === "operator" && operatorAccess?.shellsEnabled === true;
}

export function isGatewayClassShellAccessEnabled(
  gatewayClass: GatewayClass | undefined,
  operatorAccess: OperatorGatewayAccessSpec | undefined,
): boolean {
  return (
    (gatewayClass === "builder" || gatewayClass === "operator") &&
    operatorAccess?.shellsEnabled === true
  );
}

export function isGatewayClassControlUiAccessEnabled(
  gatewayClass: GatewayClass | undefined,
  _operatorAccess: OperatorGatewayAccessSpec | undefined,
): boolean {
  return gatewayClass === "builder" || gatewayClass === "operator";
}

// The user-doc shell state the PWA gates BuilderShell on (gatewayProfile +
// shellsEnabled). A Builder gets BuilderShell when placed on a shell-enabled
// builder/operator gateway they OWN; a guest migrated onto someone else's
// gateway does not.
export function resolveUserGatewayShellState(
  data:
    | {
        gatewayClass?: unknown;
        profile?: unknown;
        imageProfile?: unknown;
        ownerUid?: unknown;
        coOwnerUids?: unknown;
        operatorAccess?: OperatorGatewayAccessSpec;
      }
    | undefined,
  uid: string,
): { gatewayProfile: GatewayProfile; shellsEnabled: boolean } {
  const gatewayClass = resolveGatewayClass({
    gatewayClass: isGatewayClass(data?.gatewayClass) ? data.gatewayClass : undefined,
    profile: isGatewayProfile(data?.profile) ? data.profile : undefined,
    imageProfile: isGatewayProfile(data?.imageProfile) ? data.imageProfile : undefined,
  });
  const coOwnerUids = Array.isArray(data?.coOwnerUids) ? (data.coOwnerUids as unknown[]) : [];
  const userOwns = data?.ownerUid === uid || coOwnerUids.includes(uid);
  return {
    gatewayProfile: gatewayClass === "operator" ? "operator" : "standard",
    shellsEnabled: userOwns && isGatewayClassShellAccessEnabled(gatewayClass, data?.operatorAccess),
  };
}

export type OperationKind =
  | "add-gateway"
  | "migrate-customer"
  | "retire-gateway"
  | "restart-gateway"
  | "recycle-gateway"
  | "rollout"
  | "deprovision-customer";

export type OperationStatus =
  | "pending"
  | "running"
  | "succeeded"
  | "failed"
  | "rolled-back";

export type StepStatus = "pending" | "running" | "done" | "failed" | "skipped";

export interface OperationStep {
  name: string;
  status: StepStatus;
  startedAt?: number;
  completedAt?: number;
  error?: string;
}

export interface Operation {
  id: string;
  kind: OperationKind;
  status: OperationStatus;
  createdBy: string;
  createdAt: number;
  startedAt: number | null;
  completedAt: number | null;
  input: Record<string, unknown>;
  steps: OperationStep[];
  error?: string;
  rolledBack?: boolean;
  // Heartbeat for the stuck-op reaper: bumped every time a step is reported and on
  // resume-adoption. Lets a long or resumed roll keep proving liveness so it is reaped
  // only when progress genuinely stalls, not on absolute age since first claim.
  lastProgressAt?: number;
  // Incremented each time a controller re-adopts this op after a restart (observability).
  resumeCount?: number;
  // A serially-exclusive op (e.g. rollout) parked pending because a conflicting op of
  // the same kind is running. Human-readable, e.g. "bender-blue → bender-green". Cleared
  // once the op is claimed.
  waitingOn?: string | null;
  // Set when a transient failure schedules an automatic retry; the op stays `pending`
  // until this passes. Cleared once claimed.
  nextAttemptAt?: number | null;
  // Total handler invocations so far (first run = 1), capped at MAX_OPERATION_ATTEMPTS.
  attempts?: number;
  // One entry per FAILED attempt — retried or terminal — preserving that attempt's
  // steps/error/classification (the live `steps` field resets on retry). Successful
  // completions append nothing.
  attemptHistory?: OperationAttemptRecord[];
  output?: Record<string, unknown>;
  customerMigrationV2?: CustomerMigrationV2State;
}

export type CustomerMigrationV2Phase =
  | "initialized"
  | "checkpointed"
  | "targetPrepared"
  | "keysSynced"
  | "targetRestored"
  | "candidateProven"
  | "preSynced"
  | "sourceQuiesced"
  | "finalSynced"
  | "targetVerified"
  | "promotionIntent"
  | "promoted"
  | "cutover"
  | "sourceRetired"
  | "finalized"
  | "complete"
  | "abortIntent"
  | "abortPublished"
  | "abortTargetUnmounted"
  | "abortContextCleared"
  | "aborted";

export interface CustomerMigrationV2GatewayRootFence {
  gatewayId: string;
  updatedAt: number;
  latestRelease: number;
  desiredRelease: number;
  liveRelease: number;
  gatewayClass: "builder" | "operator";
  ownerUid: string;
  builderSlug: string;
  configHash: string;
}

export interface CustomerMigrationV2State {
  phase: CustomerMigrationV2Phase;
  operationId: string;
  migrationId: string;
  uid: string;
  slug: string;
  sourceGatewayId: string;
  sourceRevisionId: string;
  sourceRelease: number;
  sourceEpoch: number;
  sourceAssignmentMode: "assigned" | "unassigned-live";
  sourceRootFence: CustomerMigrationV2GatewayRootFence;
  targetGatewayId: string;
  targetRevisionId: string;
  targetRelease: number;
  targetRootFence: CustomerMigrationV2GatewayRootFence;
  sourceImageTag: string;
  sourceBuildSha: string;
  sourceOpenclawVersion: string;
  targetImageTag: string;
  checkpointCommit?: string;
  configHash?: string;
  freezeRef?: string;
  freezeObject?: string;
  candidateProof?: ConfigCandidateProofResponse;
  promotionIntentAt?: number;
  promotedAt?: number;
  cutoverAt?: number;
  sourceRetiredAt?: number;
  finalizedAt?: number;
  completedAt?: number;
  abortFromPhase?: CustomerMigrationV2Phase;
  abortReason?: string;
  abortIntentAt?: number;
  abortedAt?: number;
}

export interface OperationAttemptRecord {
  attempt: number;
  startedAt: number;
  completedAt: number;
  error: string;
  classification: "transient" | "terminal";
  steps: OperationStep[];
}

export interface HelmInstanceValue {
  enabled: boolean;
  image: { repository: string; tag: string };
  gatewayId: string;

  chartFingerprint?: string;
  deploymentIntentFingerprint?: string;
  serviceAccountName?: string;
  serviceAccount?: GatewayServiceAccountSpec;
  gatewayContainerSecurityContext?: Record<string, unknown>;
  operatorAccess?: OperatorGatewayAccessSpec;

  profile?: GatewayProfile;
  gatewayClass?: GatewayClass;
  imageProfile?: GatewayImageProfile;
  builderSlug?: string;

  sizingTier?: SizingTier;
  computeClassOverride?: string;

  replicas?: number;
}

export type HelmInstancesMap = Record<string, HelmInstanceValue>;

export const GLM_GATEWAYS_COLLECTION = "glmGateways";
export const GLM_OPERATIONS_COLLECTION = "glmOperations";
export const GLM_MIGRATION_TRANSFER_TASKS_COLLECTION =
  "glmMigrationTransferTasks";

export function isGatewayClass(value: unknown): value is GatewayClass {
  return (
    typeof value === "string" &&
    (GATEWAY_CLASSES as readonly string[]).includes(value)
  );
}

export function isGatewayProfile(value: unknown): value is GatewayProfile {
  return (
    typeof value === "string" &&
    (GATEWAY_PROFILES as readonly string[]).includes(value)
  );
}

export function resolveGatewayClass(input: {
  gatewayClass?: GatewayClass;
  profile?: GatewayProfile;
  imageProfile?: GatewayImageProfile;
}): GatewayClass {
  if (input.gatewayClass) return input.gatewayClass;
  return input.profile === "operator" || input.imageProfile === "operator"
    ? "operator"
    : "shared";
}

export function resolveGatewayImageProfile(input: {
  gatewayClass?: GatewayClass;
  imageProfile?: GatewayImageProfile;
  profile?: GatewayProfile;
}): GatewayImageProfile {
  if (input.imageProfile) return input.imageProfile;
  if (!input.gatewayClass && input.profile) return input.profile;
  return resolveGatewayClass(input) === "operator" ? "operator" : "standard";
}
