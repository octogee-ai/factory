import { type GatewayMutableConfig } from "./gateway-mutable-config.js";
import type { GatewayPreemptionHandoffSpec } from "./glm.js";
export declare const GATEWAY_RELEASES_SUBCOLLECTION = "releases";
export declare const GATEWAY_ASSIGNMENTS_SUBCOLLECTION = "assignments";
export type GatewayLifecycleStatus = "running" | "paused" | "retired";
export type GatewayIdleSleepStatus = "paused" | "empty-waiting" | "returning-to-shared";
export interface GatewayIdleSleepState {
    status?: GatewayIdleSleepStatus;
    action?: string;
    pausedAt?: number;
    emptySince?: number;
    protectedUntil?: number;
    lastActivityAt?: number | null;
    requestedAt?: number;
    operationId?: string;
    targetGatewayId?: string;
}
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
    idleSleep?: GatewayIdleSleepState | null;
    preemptionHandoff?: GatewayPreemptionHandoffSpec | null;
    retireAfter?: number | null;
    retirementVersion?: number;
    retirementClaim?: GatewayRetirementClaim | null;
}
export declare const W9_CANDIDATE_MANIFEST_PATH = "infra/gateway/openclaw-candidates/agent-conversation.json";
export declare const W9_MATTERMOST_OVERLAY_VALUES_PATH = "infra/candidates/values.mattermost-silent-post.yaml";
export declare const W9_GATEWAY_EDGE_IMAGE_REPOSITORY = "us-central1-docker.pkg.dev/octogee/octogee/gateway-edge";
export interface W9GatewayEdgeImage {
    imageRepository: typeof W9_GATEWAY_EDGE_IMAGE_REPOSITORY;
    imageTag: string;
}
export interface W9TestPublisherLiveExperiment {
    kind: "w9-agent-conversation";
    mode: "publisher-live";
    candidateManifest: {
        path: typeof W9_CANDIDATE_MANIFEST_PATH;
        sha256: string;
    };
    mattermostOverlay: {
        valuesPath: typeof W9_MATTERMOST_OVERLAY_VALUES_PATH;
        imageReference: string;
    };
}
export declare function isW9TestPublisherLiveExperiment(value: unknown): value is W9TestPublisherLiveExperiment;
export interface ReleasePayload {
    imageRepository: string;
    imageTag: string;
    gatewayEdgeImage?: W9GatewayEdgeImage;
    testExperiment?: W9TestPublisherLiveExperiment;
}
export declare function isReleasePayload(value: unknown): value is ReleasePayload;
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
export declare function isW9GatewayEdgeImage(value: unknown, gatewayImageTag: string): value is W9GatewayEdgeImage;
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
    updatedAt: number;
    updatedByOperationId: string | null;
}
export type GatewayRuntimeLifecycle = "provisioning" | "serving" | "failed";
export type GatewayHeartbeatStatus = "unknown" | "ready" | "unreachable" | "error";
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
    lastError: {
        message: string | null;
        at: number | null;
    };
}
export declare function isGatewayRuntimeDoc(data: unknown): data is GatewayRuntimeDoc;
export declare function isGatewayDesiredDoc(data: unknown): data is GatewayDoc;
export declare function projectGatewayDesiredRootForGateway(value: unknown, gatewayId: string): (GatewayDoc & GatewayMutableConfig) | null;
export declare function helmReleaseNameForGateway(gatewayId: string): string;
export declare function gatewayEdgeServiceName(id: string): string;
export declare function gatewayPodServiceName(id: string): string;
export declare function releasePayloadHash(payload: ReleasePayload): string;
export type GatewayFieldClassification = "release" | "gateway-mutable";
export declare const RELEASE_FIELDS: readonly ["imageRepository", "imageTag", "testExperiment"];
export declare const GATEWAY_MUTABLE_FIELDS: readonly ["profile", "gatewayClass", "imageProfile", "sizingTier", "computeClass", "gcpProject", "gatewayContainerSecurityContext", "serviceAccountName", "serviceAccount", "operatorAccess", "ownerUid", "builderSlug", "openclawOverrides", "modelBrokerLimits", "preemption", "allocation", "desiredStatus", "idleSleep", "preemptionHandoff", "liveRelease", "retireAfter"];
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
export interface CommitPlacementParams {
    uid: string;
    slug: string;
    gatewayId: string;
    source: AssignmentSource;
    now: number;
    mirrorPatch: Record<string, unknown>;
    updatedByOperationId?: string | null;
    assignmentWrite?: "upsert" | "create-if-missing";
    companionWrites?: ReadonlyArray<{
        collection: string;
        docId: string;
        data: Record<string, unknown>;
        mode?: "upsert" | "create-if-missing";
        mirrorPatchIfWritten?: Record<string, unknown>;
    }>;
}
export type PlacementRejectReason = "gateway-root-invalid" | "gateway-not-running" | "gateway-not-serving";
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
