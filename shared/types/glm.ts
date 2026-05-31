import type { SizingTier } from "./sizing.js";

export type GatewayDesiredStatus = "running" | "paused" | "draining" | "retired";

export const GATEWAY_PROFILES = ["standard", "operator"] as const;
export type GatewayProfile = (typeof GATEWAY_PROFILES)[number];

export interface GatewayDesiredState {
  gatewayId: string;
  instanceName: string;
  imageRepository: string;
  imageTag: string;

  profile?: GatewayProfile;
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

export const OPERATOR_GATEWAY_SERVICE_ACCOUNT_PREFIX = "octogee-gw-";
export const GATEWAY_PLATFORM_SERVICE_ACCOUNT_NAME = "octogee-gateway";

export const OPERATOR_GATEWAY_LOCKED_SERVICE_ACCOUNT: GatewayServiceAccountSpec = {
  create: true,
};

export function operatorGatewayServiceAccountName(gatewayId: string): string {
  const suffix = gatewayId.startsWith("gw-") ? gatewayId.slice(3) : gatewayId;
  return `${OPERATOR_GATEWAY_SERVICE_ACCOUNT_PREFIX}${suffix}`;
}

export function resolveGatewayPersistence(
  profile: GatewayProfile | undefined,
  persistence: GatewayPersistenceSpec | undefined,
): GatewayPersistenceSpec | undefined {
  if (persistence) return persistence;
  if (profile !== "operator") return undefined;
  return {
    ...OPERATOR_GATEWAY_DEFAULT_PERSISTENCE,
    accessModes: [...(OPERATOR_GATEWAY_DEFAULT_PERSISTENCE.accessModes ?? [])],
  };
}

export function isOperatorGatewayShellAccessEnabled(
  profile: GatewayProfile | undefined,
  operatorAccess: OperatorGatewayAccessSpec | undefined,
): boolean {
  return profile === "operator" && operatorAccess?.shellsEnabled === true;
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

  sizingTier?: SizingTier;

  replicas?: number;
}

export type HelmInstancesMap = Record<string, HelmInstanceValue>;

export const GLM_GATEWAYS_COLLECTION = "glmGateways";
export const GLM_OPERATIONS_COLLECTION = "glmOperations";
