import type { SizingTier } from "./sizing.js";

export type GatewayDesiredStatus = "running" | "paused" | "draining" | "retired";

export const GATEWAY_PROFILES = ["standard", "operator"] as const;
export type GatewayProfile = (typeof GATEWAY_PROFILES)[number];

export const GATEWAY_CLASSES = ["shared", "builder", "operator"] as const;
export type GatewayClass = (typeof GATEWAY_CLASSES)[number];

export const GATEWAY_IMAGE_PROFILES = ["standard", "operator"] as const;
export type GatewayImageProfile = (typeof GATEWAY_IMAGE_PROFILES)[number];

export interface GatewayDesiredState {
  gatewayId: string;
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

  persistence?: GatewayPersistenceSpec;

  operatorAccess?: OperatorGatewayAccessSpec;

  operatorReservation?: OperatorGatewayReservationSpec;

  lastError?: { at: number; message: string } | null;

  openclawOverrides?: Record<string, unknown>;

  byosub?: Record<string, ByosubRef>;

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

export interface GatewayPersistenceSpec {
  enabled: boolean;
  existingClaim?: string;
  storageClassName?: string;
  size?: string;
  accessModes?: string[];
}

export interface GatewayServiceAccountSpec {
  create?: boolean;
  annotations?: Record<string, string>;
}

export interface OperatorGatewayAccessSpec {
  shellsEnabled?: boolean;
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

export const OPERATOR_GATEWAY_DEFAULT_PERSISTENCE: GatewayPersistenceSpec = {
  enabled: true,
  storageClassName: "premium-rwo",
  size: "20Gi",
  accessModes: ["ReadWriteOnce"],
};

export const OPERATOR_GATEWAY_LOCKED_ACCESS: OperatorGatewayAccessSpec = {
  shellsEnabled: false,
  reason: "operator-trust-boundary-not-provisioned",
};

// An operator-class gateway with a Builder owner IS a provisioned tenant boundary
// (single owner, exec on, owner-only shell auth in gateway-edge), so it gets
// BuilderShell. Un-owned operator gateways stay locked.
export function defaultOperatorGatewayAccess(
  ownerUid: string | null | undefined,
): OperatorGatewayAccessSpec {
  return ownerUid
    ? { shellsEnabled: true, reason: "owned-operator-gateway" }
    : OPERATOR_GATEWAY_LOCKED_ACCESS;
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

export function operatorGatewayServiceAccountName(gatewayId: string): string {
  return `${OPERATOR_GATEWAY_SERVICE_ACCOUNT_PREFIX}${gatewayId}`;
}

export function resolveGatewayPersistence(
  _profile: GatewayProfile | undefined,
  persistence: GatewayPersistenceSpec | undefined,
): GatewayPersistenceSpec | undefined {
  return persistence;
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
  return gatewayClass === "operator" && operatorAccess?.shellsEnabled === true;
}

// The user-doc shell state the PWA gates BuilderShell on (gatewayProfile +
// shellsEnabled). A Builder gets BuilderShell when placed on an operator-class
// gateway they OWN; a guest migrated onto someone else's operator gateway does not.
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

export type ByosubProvider = "openai" | "anthropic";

export interface ByosubRef {
  provider: ByosubProvider;
  secretName: string;
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
}

export interface HelmInstanceValue {
  enabled: boolean;
  image: { repository: string; tag: string };
  gatewayId: string;

  chartFingerprint?: string;
  serviceAccountName?: string;
  serviceAccount?: GatewayServiceAccountSpec;
  gatewayContainerSecurityContext?: Record<string, unknown>;
  persistence?: GatewayPersistenceSpec;
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
