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
    lastError?: {
        at: number;
        message: string;
    } | null;
    openclawOverrides?: Record<string, unknown>;
    ownerUid?: string;
    builderSlug?: string;
    sizingTier?: SizingTier;
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
export declare const OPERATOR_GATEWAY_LOCKED_ACCESS: OperatorGatewayAccessSpec;
export declare function defaultOperatorGatewayAccess(ownerUid: string | null | undefined, shellsEnabled?: boolean): OperatorGatewayAccessSpec;
export declare function resolveOperatorGatewayAccess(ownerUid: string | null | undefined, operatorAccess: OperatorGatewayAccessSpec | null | undefined): OperatorGatewayAccessSpec;
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
export declare function isGatewayClassControlUiAccessEnabled(gatewayClass: GatewayClass | undefined, operatorAccess: OperatorGatewayAccessSpec | undefined): boolean;
export declare function resolveUserGatewayShellState(data: {
    gatewayClass?: unknown;
    profile?: unknown;
    imageProfile?: unknown;
    ownerUid?: unknown;
    operatorAccess?: OperatorGatewayAccessSpec;
} | undefined, uid: string): {
    gatewayProfile: GatewayProfile;
    shellsEnabled: boolean;
};
export type OperationKind = "add-gateway" | "migrate-customer" | "retire-gateway" | "restart-gateway" | "recycle-gateway" | "rollout" | "deprovision-customer" | "suspend-customer" | "erase-customer";
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
    output?: Record<string, unknown>;
    customerMigrationV2?: CustomerMigrationV2State;
}
export type CustomerMigrationV2Phase = "initialized" | "keysSynced" | "targetRestored" | "preSynced" | "sourceQuiesced" | "finalSynced" | "targetVerified" | "cutover" | "sourceRetired" | "complete" | "abortIntent" | "abortTargetUnmounted" | "aborted";
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
    sourceRelease: number;
    sourceEpoch: number;
    sourceAssignmentMode: "assigned" | "unassigned-live";
    sourceRootFence: CustomerMigrationV2GatewayRootFence;
    targetGatewayId: string;
    targetRelease: number;
    targetRootFence: CustomerMigrationV2GatewayRootFence;
    sourceSystemConfigCommit?: string;
    cutoverAt?: number;
    sourceRetiredAt?: number;
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
    image: {
        repository: string;
        tag: string;
    };
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
    ownerUid?: string;
    builderSlug?: string;
    sizingTier?: SizingTier;
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
