import type { SizingTier } from "./sizing.js";
export type GatewayDesiredStatus = "running" | "paused" | "draining" | "retired";
export declare const GATEWAY_PROFILES: readonly ["standard", "operator"];
export type GatewayProfile = (typeof GATEWAY_PROFILES)[number];
export declare const GATEWAY_CLASSES: readonly ["shared", "builder", "operator"];
export type GatewayClass = (typeof GATEWAY_CLASSES)[number];
export declare const GATEWAY_IMAGE_PROFILES: readonly ["standard", "operator"];
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
    lastError?: {
        at: number;
        message: string;
    } | null;
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
    platformMetadataEgress?: boolean;
    kubeApiServerEgressCidrs?: string[];
    reason?: string;
    verifiedAt?: number;
    verifiedBy?: string;
}
export declare const OPERATOR_GATEWAY_RESERVATION_STATUSES: readonly ["reserved", "provisioning", "active", "suspended", "released"];
export type OperatorGatewayReservationStatus = (typeof OPERATOR_GATEWAY_RESERVATION_STATUSES)[number];
export declare const OPERATOR_GATEWAY_RESERVATION_BILLING_STATUSES: readonly ["manual", "pending", "active"];
export type OperatorGatewayReservationBillingStatus = (typeof OPERATOR_GATEWAY_RESERVATION_BILLING_STATUSES)[number];
export interface OperatorGatewayReservationSpec {
    status: OperatorGatewayReservationStatus;
    reservedAt: number;
    reservedBy: string;
    billingStatus?: OperatorGatewayReservationBillingStatus;
    billingVerifiedAt?: number;
    activatedAt?: number;
    activatedBy?: string;
}
export declare const OPERATOR_GATEWAY_RESERVATIONS_COLLECTION = "operatorGatewayReservations";
export declare const OPERATOR_GATEWAY_RESERVATION_REQUEST_STATUSES: readonly ["billing_pending", "requested", "provisioning", "fulfilled", "cancelled"];
export type OperatorGatewayReservationRequestStatus = (typeof OPERATOR_GATEWAY_RESERVATION_REQUEST_STATUSES)[number];
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
export declare const OPERATOR_GATEWAY_LOCKED_ACCESS: OperatorGatewayAccessSpec;
export declare function defaultOperatorGatewayAccess(ownerUid: string | null | undefined): OperatorGatewayAccessSpec;
export declare const OPERATOR_GATEWAY_SERVICE_ACCOUNT_PREFIX = "octogee-gw-";
export declare const GATEWAY_PLATFORM_SERVICE_ACCOUNT_NAME = "octogee-gateway";
export declare const GATEWAY_ID_MAX_LENGTH = 32;
export declare const GATEWAY_ID_REQUIREMENT = "gatewayId must be a lowercase DNS-safe id, 1-32 chars, starting and ending with a letter or digit";
export declare const OPERATOR_GATEWAY_LOCKED_SERVICE_ACCOUNT: GatewayServiceAccountSpec;
export declare function isValidGatewayId(id: unknown): id is string;
export declare const NEW_GATEWAY_ID_REQUIREMENT = "gatewayId must be a lowercase DNS-safe id, 1-32 chars, starting and ending with a letter or digit; the -blue/-green suffixes are reserved for roll roles";
export declare function isValidNewGatewayId(id: unknown): id is string;
export declare function deriveGatewayIdentity(gatewayId: string, explicitGateway?: unknown): string;
export declare function operatorGatewayServiceAccountName(gatewayId: string): string;
export declare function isOperatorGatewayShellAccessEnabled(profile: GatewayProfile | undefined, operatorAccess: OperatorGatewayAccessSpec | undefined): boolean;
export declare function isGatewayClassShellAccessEnabled(gatewayClass: GatewayClass | undefined, operatorAccess: OperatorGatewayAccessSpec | undefined): boolean;
export declare function resolveUserGatewayShellState(data: {
    gatewayClass?: unknown;
    profile?: unknown;
    imageProfile?: unknown;
    ownerUid?: unknown;
    coOwnerUids?: unknown;
    operatorAccess?: OperatorGatewayAccessSpec;
} | undefined, uid: string): {
    gatewayProfile: GatewayProfile;
    shellsEnabled: boolean;
};
export type OperationKind = "add-gateway" | "migrate-customer" | "retire-gateway" | "retire-revision" | "restart-gateway" | "recycle-gateway" | "rollout" | "deprovision-customer";
export type OperationStatus = "pending" | "running" | "succeeded" | "failed" | "rolled-back";
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
    lastProgressAt?: number;
    resumeCount?: number;
    waitingOn?: string | null;
    nextAttemptAt?: number | null;
    attempts?: number;
    attemptHistory?: OperationAttemptRecord[];
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
    image: {
        repository: string;
        tag: string;
    };
    gatewayId: string;
    chartFingerprint?: string;
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
export declare const GLM_GATEWAYS_COLLECTION = "glmGateways";
export declare const GLM_OPERATIONS_COLLECTION = "glmOperations";
export declare const GLM_MIGRATION_TRANSFER_TASKS_COLLECTION = "glmMigrationTransferTasks";
export declare function isGatewayClass(value: unknown): value is GatewayClass;
export declare function isGatewayProfile(value: unknown): value is GatewayProfile;
export declare function resolveGatewayClass(input: {
    gatewayClass?: GatewayClass;
    profile?: GatewayProfile;
    imageProfile?: GatewayImageProfile;
}): GatewayClass;
export declare function resolveGatewayImageProfile(input: {
    gatewayClass?: GatewayClass;
    imageProfile?: GatewayImageProfile;
    profile?: GatewayProfile;
}): GatewayImageProfile;
