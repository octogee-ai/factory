import type { GatewayPodPlacement, GatewayPodReplacements } from "./gateway-pod-replacements.js";
import { type GatewayMutableConfig } from "./gateway-mutable-config.js";
import type { GatewayDesiredStatus } from "./glm.js";
export declare const GATEWAY_RELEASES_SUBCOLLECTION = "releases";
export declare const GATEWAY_ASSIGNMENTS_SUBCOLLECTION = "assignments";
export type GatewayLifecycleStatus = GatewayDesiredStatus;
export interface GatewayRetirementClaim {
    operationId: string;
    version: number;
    claimedAt: number;
    phase: "claimed";
    liveRelease: number | null;
    liveRuntimeIdentity: {
        startedAt: number;
        version: string;
        openclawVersion: string;
    } | null;
    previousDesiredStatus: Exclude<GatewayLifecycleStatus, "retired">;
}
export interface GatewayDoc {
    gatewayId: string;
    createdAt: number;
    createdBy: string;
    updatedAt: number;
    updatedBy: string;
    latestRelease: number;
    desiredRelease: number;
    liveRelease: number | null;
    desiredStatus: GatewayLifecycleStatus;
    retireAfter?: number | null;
    retirementVersion?: number;
    retirementClaim?: GatewayRetirementClaim | null;
}
export interface GatewayEdgeImage {
    imageRepository: string;
    imageTag: string;
}
export interface GatewayProfileImages {
    builder: {
        imageRepository: string;
        imageTag: string;
    };
}
export interface ReleasePayload {
    imageRepository: string;
    imageTag: string;
    openclawSourceSha?: string;
    profileImages?: GatewayProfileImages;
    gatewayEdgeImage?: GatewayEdgeImage;
}
export declare function isReleasePayload(value: unknown): value is ReleasePayload;
export declare function isGatewayEdgeImage(value: unknown, gatewayImageRepository: string): value is GatewayEdgeImage;
export type ReleasePayloadSchemaUpgrade = {
    status: "current";
    payload: ReleasePayload;
    payloadHash: string;
} | {
    status: "upgraded";
    migration: "remove-retired-mac-ops-token-protocol";
    payload: ReleasePayload;
    payloadHash: string;
} | {
    status: "unsupported";
    reason: "payload-hash-mismatch" | "unsupported-payload-schema";
};
export declare function upgradeReleasePayloadSchema(payload: unknown, persistedPayloadHash: unknown): ReleasePayloadSchemaUpgrade;
export interface ReleaseDoc {
    gatewayId: string;
    release: number;
    createdAt: number;
    createdBy: string;
    sourceRelease: number | null;
    note: string | null;
    payloadHash: string;
    payload: ReleasePayload;
}
export type AssignmentSource = "onboarding" | "migrate-customer" | "repair";
export type AssignmentState = "serving" | "quiescing" | "migrating";
export declare function isAssignmentState(value: unknown): value is AssignmentState;
export interface AssignmentDoc {
    uid: string;
    slug: string;
    gatewayId: string;
    source: AssignmentSource;
    state: AssignmentState;
    epoch: number;
    createdAt: number;
    updatedAt: number;
    updatedByOperationId: string | null;
}
export type GatewayRuntimeLifecycle = "provisioning" | "serving" | "failed";
export type GatewayHeartbeatStatus = "unknown" | "booting" | "ready" | "unreachable" | "error";
export interface GatewayHelmObservation {
    releaseName: string;
    deploymentName: string;
    gatewayServiceName: string;
    gatewayEdgeServiceName: string;
    serviceAccountName: string;
    imageRepository: string | null;
    imageTag: string | null;
    replicas: number | null;
    availableReplicas: number | null;
    lastAppliedAt: number | null;
}
export interface GatewayHeartbeatObservation {
    status: GatewayHeartbeatStatus;
    lastHeartbeatAt: number | null;
    version: string | null;
    openclawVersion: string | null;
    internalUrl: string | null;
    startedAt: number | null;
    mountedCustomers: string[];
    migratingIn: string[];
    configStatus?: import("./fleet-controller.js").GatewayConfigStatus;
}
export interface GatewayRuntimeDoc {
    docKind: "runtime";
    gatewayId: string;
    release: number;
    lifecycle: GatewayRuntimeLifecycle;
    createdAt: number;
    createdByOperationId: string | null;
    helm: GatewayHelmObservation;
    heartbeat: GatewayHeartbeatObservation;
    kubernetes?: GatewayKubernetesObservation;
    podReplacements?: GatewayPodReplacements;
    lastError: {
        message: string | null;
        at: number | null;
    };
}
export interface GatewayKubernetesObservation {
    status: "ready" | "not-ready" | "missing" | "unknown";
    totalPods: number;
    readyPods: number;
    observedAt: number;
    pods?: GatewayPodPlacement[];
}
export declare function hasFreshReadyKubernetesObservation(runtime: GatewayRuntimeDoc, nowMs: number, maxAgeMs: number): boolean;
export declare function isGatewayRuntimeDoc(data: unknown): data is GatewayRuntimeDoc;
export declare function isGatewayDesiredDoc(data: unknown): data is GatewayDoc;
export declare function projectGatewayDesiredRootForGateway(value: unknown, gatewayId: string): (GatewayDoc & GatewayMutableConfig) | null;
export declare function helmReleaseNameForGateway(gatewayId: string): string;
export declare function gatewayEdgeServiceName(id: string): string;
export declare function gatewayPodServiceName(id: string): string;
export declare function releasePayloadHash(payload: ReleasePayload): string;
export type GatewayFieldClassification = "release" | "gateway-mutable";
export declare const RELEASE_FIELDS: readonly ["imageRepository", "imageTag"];
export declare const GATEWAY_MUTABLE_FIELDS: readonly ["profile", "gatewayClass", "imageProfile", "sizingTier", "gcpProject", "gatewayContainerSecurityContext", "serviceAccountName", "serviceAccount", "builderAccess", "ownerUid", "builderSlug", "openclawOverrides", "modelBrokerLimits", "allocation", "desiredStatus", "liveRelease", "retireAfter"];
export declare function classifyGatewayField(field: string): GatewayFieldClassification;
export interface PlacementDocSnap {
    exists: boolean;
    data: () => Record<string, unknown> | undefined;
}
export interface PlacementDocRef {
    get: () => Promise<PlacementDocSnap>;
    set: (data: Record<string, unknown>, options?: {
        merge?: boolean;
    }) => Promise<unknown>;
    update: (data: Record<string, unknown>) => Promise<unknown>;
    collection: (name: string) => {
        doc: (id: string) => PlacementDocRef;
    };
}
export interface PlacementTxn {
    get: (ref: PlacementDocRef) => Promise<PlacementDocSnap>;
    set: (ref: PlacementDocRef, data: Record<string, unknown>, options?: {
        merge?: boolean;
    }) => void;
    update: (ref: PlacementDocRef, data: Record<string, unknown>) => void;
}
export interface PlacementFirestore {
    collection: (name: string) => {
        doc: (id: string) => PlacementDocRef;
    };
    runTransaction: <T>(body: (txn: PlacementTxn) => Promise<T>) => Promise<T>;
}
export interface PlacementTargetValidationContext {
    txn: PlacementTxn;
    gatewayRef: PlacementDocRef;
    assignmentRef: PlacementDocRef;
    gateway: GatewayDoc & GatewayMutableConfig;
    runtime: Record<string, unknown>;
}
export interface CommitPlacementParams {
    uid: string;
    slug: string;
    gatewayId: string;
    source: AssignmentSource;
    now: number;
    mirrorPatch: Record<string, unknown>;
    atomicCreate?: {
        userField: string;
        userPatch: Record<string, unknown>;
        writes: ReadonlyArray<{
            collection: string;
            document: string;
            data: Record<string, unknown>;
        }>;
    };
    updatedByOperationId?: string | null;
    assignmentWrite?: "upsert" | "create-if-missing";
    requireDurableGateway?: boolean;
    automatic?: boolean;
    validateTarget?: (context: PlacementTargetValidationContext) => Promise<PlacementRejectReason | null>;
}
export type PlacementRejectReason = "account-not-interactive" | "gateway-root-invalid" | "gateway-not-running" | "gateway-not-serving" | "gateway-target-not-accepting";
export type CommitPlacementResult = {
    kind: "mirror-only";
} | {
    kind: "assignment-preserved";
} | {
    kind: "assigned";
    release: number | null;
} | {
    kind: "rejected";
    reason: PlacementRejectReason;
};
export declare function commitPlacementAtomic(db: PlacementFirestore, params: CommitPlacementParams): Promise<CommitPlacementResult>;
