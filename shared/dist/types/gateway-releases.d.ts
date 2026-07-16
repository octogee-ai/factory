import type { GatewayPreemptionHandoffSpec } from "./glm.js";
export declare const GATEWAY_RELEASES_SUBCOLLECTION = "releases";
export declare const GATEWAY_ASSIGNMENTS_SUBCOLLECTION = "assignments";
export declare const REVISION_TOMBSTONES_COLLECTION = "revisionTombstones";
export type GatewayLifecycleStatus = "running" | "paused" | "retired";
export type GatewayRollStatus = "warming" | "routing" | "migrating" | "retiring-source" | "failed";
export interface GatewayRollState {
    operationId: string;
    status: GatewayRollStatus;
    fromRelease: number | null;
    toRelease: number;
    sourceRevisionId: string | null;
    targetRevisionId: string;
    acceptingNewAssignments: boolean;
    startedAt: number;
    updatedAt: number;
    error: string | null;
    flippedAt: number | null;
}
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
export interface GatewayLegacyBackfill {
    sourceGlmGatewayIds: string[];
    startedAt: number;
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
    liveRevisionId: string | null;
    trafficRevisionId: string | null;
    desiredStatus: GatewayLifecycleStatus;
    roll: GatewayRollState | null;
    idleSleep?: GatewayIdleSleepState | null;
    preemptionHandoff?: GatewayPreemptionHandoffSpec | null;
    retireAfter?: number | null;
    legacyBackfill?: GatewayLegacyBackfill | null;
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
export type AssignmentSource = "onboarding" | "migrate-customer" | "rollout" | "repair";
export type AssignmentState = "serving" | "quiescing" | "migrating";
export declare function isAssignmentState(value: unknown): value is AssignmentState;
export declare const INTRA_FAMILY_HOP_HEADER = "x-octogee-intra-family-hop";
export declare const ASSIGNMENT_EPOCH_HEADER = "x-octogee-assignment-epoch";
export declare const INTERNAL_ROUTING_HEADERS: readonly string[];
export interface AssignmentDoc {
    uid: string;
    slug: string;
    gatewayId: string;
    revisionId: string;
    release: number;
    source: AssignmentSource;
    state: AssignmentState;
    epoch: number;
    updatedAt: number;
    updatedByOperationId: string | null;
}
export type RevisionRollRole = "source" | "target" | null;
export type RevisionLifecycle = "provisioning" | "warming" | "serving" | "draining" | "retiring" | "retired" | "failed";
export type RevisionHeartbeatStatus = "unknown" | "ready" | "unreachable" | "error";
export interface RevisionHelmObservation {
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
export interface RevisionHeartbeatObservation {
    status: RevisionHeartbeatStatus;
    lastHeartbeatAt: number | null;
    version: string | null;
    openclawVersion: string | null;
    internalUrl: string | null;
    startedAt: number | null;
    mountedCustomers: string[];
    migratingIn: string[];
}
export interface RevisionRealizationDoc {
    docKind: "revision";
    revisionId: string;
    gateway: string;
    release: number;
    rollRole: RevisionRollRole;
    lifecycle: RevisionLifecycle;
    createdAt: number;
    createdByOperationId: string | null;
    retiredAt: number | null;
    retireReason: string | null;
    helm: RevisionHelmObservation;
    heartbeat: RevisionHeartbeatObservation;
    lastError: {
        message: string | null;
        at: number | null;
    };
}
export declare function isRevisionRealizationDoc(data: unknown): data is RevisionRealizationDoc;
export declare function isGatewayLegacyBackfill(value: unknown): value is GatewayLegacyBackfill;
export declare function isGatewayDesiredDoc(data: unknown): data is GatewayDoc;
export declare function revisionIdForRelease(gatewayId: string, release: number): string;
export declare function rootReferencedRevisionIds(root: GatewayDoc): ReadonlySet<string>;
export declare function helmReleaseNameForRevision(revisionId: string): string;
export declare function gatewayEdgeServiceName(id: string): string;
export declare function gatewayPodServiceName(id: string): string;
export interface RevisionTombstone {
    gatewayId: string;
    revision: number;
    revisionId: string;
    currentRevisionId: string | null;
    retiredAt: number;
}
export declare function revisionTombstoneDocId(gatewayId: string, revision: number): string;
export declare function isRevisionTombstone(data: unknown): data is RevisionTombstone;
export declare function releasePayloadHash(payload: ReleasePayload): string;
export type GatewayFieldClassification = "new-revision" | "in-place" | "gateway-mutable";
export declare const RELEASE_NEW_REVISION_FIELDS: readonly ["imageRepository", "imageTag", "testExperiment"];
export declare const RELEASE_IN_PLACE_FIELDS: readonly string[];
export declare const GATEWAY_MUTABLE_FIELDS: readonly ["profile", "gatewayClass", "imageProfile", "sizingTier", "computeClass", "gcpProject", "gatewayContainerSecurityContext", "serviceAccountName", "serviceAccount", "operatorAccess", "ownerUid", "coOwnerUids", "builderSlug", "openclawOverrides", "modelBrokerLimits", "preemption", "desiredStatus", "roll", "idleSleep", "preemptionHandoff", "liveRelease", "liveRevisionId", "trafficRevisionId", "retireAfter"];
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
}
export type PlacementRejectReason = "gateway-root-invalid" | "gateway-not-running" | "no-live-revision" | "revision-identity-invalid" | "revision-not-ready";
export type CommitPlacementResult = {
    kind: "mirror-only";
} | {
    kind: "assignment-preserved";
} | {
    kind: "assigned";
    revisionId: string;
    release: number | null;
} | {
    kind: "rejected";
    reason: PlacementRejectReason;
};
export declare function commitPlacementAtomic(db: PlacementFirestore, params: CommitPlacementParams): Promise<CommitPlacementResult>;
