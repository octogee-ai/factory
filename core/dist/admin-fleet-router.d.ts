import { Router } from "express";
import type { Firestore } from "firebase-admin/firestore";
import { type GatewayClass, type GatewayImageProfile, type GatewayProfile, type GatewayRuntime, type GatewayVmState } from "@octogee/shared/types/glm";
import { type AssignmentDoc } from "@octogee/shared/types/gateway-releases";
import { type GatewayPodReplacementSummary } from "@octogee/shared/types/gateway-pod-replacements";
import type { MigrationProgressRecord } from "@octogee/shared/types/glm";
import { type SizingTier } from "@octogee/shared/types/sizing";
import { type GatewayPricingMode } from "@octogee/shared/types/cost-estimator";
import { type UserAccounts, type UserSignInHosts } from "./admin-user-router.js";
import { type DurableGatewayRoot } from "./gateway-release-append.js";
import { type UserAccountReader } from "./user-account.js";
import type { PlatformStateStore } from "./platform-state/store.js";
import { type CentralReleaseAuthority } from "./artifact-registry.js";
export interface FleetLogger {
    info: (msg: string, meta?: Record<string, unknown>) => void;
    warn: (msg: string, meta?: Record<string, unknown>) => void;
}
export type GatewayPodDiagnosticsStatus = "ready" | "not-ready" | "missing" | "unknown";
export type GatewayPodCapacityType = "spot" | "on-demand";
export interface GatewayPodDiagnostic {
    name: string;
    uid: string | null;
    replicaSetUid: string | null;
    phase: string;
    readyContainers: number;
    totalContainers: number;
    restarts: number;
    reason: string | null;
    nodeName: string | null;
    instanceId: string | null;
    nodePool: string | null;
    capacityType: GatewayPodCapacityType | null;
    ageMs: number | null;
}
export interface GatewayPodDiagnostics {
    status: GatewayPodDiagnosticsStatus;
    totalPods: number;
    readyPods: number;
    totalRestarts: number;
    spotPods: number;
    onDemandPods: number;
    unknownCapacityPods: number;
    pods: GatewayPodDiagnostic[];
    error?: string;
}
export interface FleetRouterDeps {
    computerReplacementEnabled?: boolean;
    db: Firestore;
    store: PlatformStateStore;
    logger: FleetLogger;
    provisionGatewayAuthSecret: (opts: {
        gatewayId: string;
        gatewayServiceAccount: string;
    }) => Promise<unknown>;
    listGatewayBuilds: (opts: {
        service: string;
        limit: number;
    }) => Promise<unknown[]>;
    releaseEnvironment?: "test" | "prod" | null;
    releaseAuthority?: CentralReleaseAuthority;
    readGatewayPodDiagnostics?: (gatewayId: string) => Promise<GatewayPodDiagnostics>;
    readGatewayPodDiagnosticsBatch?: (gatewayIds: readonly string[]) => Promise<Record<string, GatewayPodDiagnostics>>;
    requestNativeReturnSourceRecovery?: (input: {
        uid: string;
        operationId: string;
        requestedAt: number;
        requestedBy: string;
    }) => Promise<boolean>;
    suspendAuthUser: (uid: string) => Promise<void>;
    revokeConnectorGrantsForUser: (uid: string) => Promise<void>;
    userAccounts?: UserAccounts;
    userSignIn?: UserSignInHosts;
}
declare function resolveSizingForResponse(glmDoc: Record<string, unknown> | undefined, reservation: ReturnType<typeof projectGatewayReservation>): {
    tier: SizingTier;
    resolvedFrom: "explicit" | "class-default" | "profile-default";
    resources: {
        requests: {
            cpu: string;
            memory: string;
        };
        limits: {
            cpu: string;
            memory: string;
        };
    };
    capacity: {
        targetActiveBuilders: number;
        typicalBuilders: number;
    };
    monthlyCostUsd: {
        compute: number;
        onDemandCompute: number;
        savings: number;
        pricingMode: GatewayPricingMode;
        perBuilderAtTarget: number;
        perBuilderAtTypical: number;
    };
};
export declare function resolveFleetNamespace(env?: NodeJS.ProcessEnv): string;
type GlmDoc = Record<string, unknown>;
interface FirestoreDocLike {
    id: string;
    data(): GlmDoc;
}
export declare const ERR_SHARED_POOL_RIDES_PLATFORM_RELEASE = "shared pool rides the platform release; deploy the platform instead";
type AdminGatewayDesiredStatus = "running" | "paused" | "draining" | "retired";
declare function projectLastError(raw: unknown): {
    slug?: string;
    message?: string;
    at: string | null;
} | null;
type ProjectedGatewayStorage = {
    mode: "emptyDir" | "pvc";
    pvcName: string | null;
    size: string | null;
    storageClassName: string | null;
    accessModes: string[];
};
declare function projectGatewayStorage(_gatewayId: string, _glmDoc: GlmDoc | undefined): ProjectedGatewayStorage;
export declare function projectGatewayReservation(glmDoc: GlmDoc | undefined, observedCapacityType?: GatewayPodCapacityType): {
    type: GatewayPricingMode;
    priceMultiplier: number;
    source: "kubernetes" | "class-default";
};
declare function projectDisposableRuntime(glmDoc: GlmDoc | undefined): {
    ownerUid: string;
    leaseId: string;
    generation: number;
} | null;
export declare function projectGatewaySummary(doc: FirestoreDocLike, glmDoc: GlmDoc | undefined, now: number): {
    gatewayId: string;
    gateway: string;
    status: string;
    desiredStatus: AdminGatewayDesiredStatus | null;
    imageTag: string | null;
    openclawVersion: string | null;
    mountedUsers: unknown[];
    ownerId: string | null;
    handoffProgress?: Record<string, MigrationProgressRecord[]>;
    lastHeartbeatAt: string | null;
    heartbeatAgeMs: number | null;
    startedAt: string | null;
    uptimeMs: number | null;
    lastError: ReturnType<typeof projectLastError>;
    sizing: ReturnType<typeof resolveSizingForResponse>;
    storage: ReturnType<typeof projectGatewayStorage>;
    reservation: ReturnType<typeof projectGatewayReservation>;
    profile: GatewayProfile;
    gatewayClass: GatewayClass;
    imageProfile: GatewayImageProfile;
    disposableRuntime: ReturnType<typeof projectDisposableRuntime>;
    podReplacements: GatewayPodReplacementSummary | null;
};
export type AdminIsolatedRuntimeLifecycle = "requested" | "provisioning" | "activating" | "active" | "returning" | "retiring" | "failed";
export declare function projectIsolatedRuntime(userDoc: FirestoreDocLike, gatewaysById: ReadonlyMap<string, GlmDoc>, operationsById: ReadonlyMap<string, GlmDoc>, now: number): {
    uid: string;
    builderSlug: string;
    lifecycle: AdminIsolatedRuntimeLifecycle;
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
    operationSteps: Array<{
        name: string;
        status: string;
    }>;
    cleanupOperationId: string | null;
    cleanupOperationStatus: string | null;
    cleanupOperationSteps: Array<{
        name: string;
        status: string;
    }>;
    cleanupError: string | null;
    error: string | null;
    terminationAvailable: boolean;
    targetPodStatus: GatewayPodDiagnosticsStatus | null;
    targetPodCount: number | null;
} | null;
export declare function projectDisposableFleetCapacity(gateways: ReadonlyArray<ReturnType<typeof projectGatewaySummary>>, isolatedRuntimes?: ReadonlyArray<NonNullable<ReturnType<typeof projectIsolatedRuntime>>>, parkedBuilders?: number): {
    disposableInstances: number;
    stagedInstances: 0;
    byTier: Record<string, number>;
    parkedBuilders: number;
    byLifecycle: Record<AdminIsolatedRuntimeLifecycle | "parked", number>;
    failedBuilders: number;
    staleActivations: number;
    oldestActivationAgeMs: number | null;
};
export interface AdminGatewayControlProjection {
    desiredStatus: string;
    desiredRelease: number | null;
    liveRelease: number | null;
    runtime: GatewayRuntime;
    gatewayClass: GatewayClass;
    imageProfile: GatewayImageProfile;
    profile: GatewayProfile | null;
    sizingTier: string | null;
    ownerUid: string | null;
    builderSlug: string | null;
    gcpProject: string | null;
    serviceAccountName: string | null;
    builderAccess: Record<string, unknown> | null;
    modelBrokerLimits: Record<string, unknown> | null;
    vm: GatewayVmState | null;
}
export declare function projectGatewayControl(root: DurableGatewayRoot, glmData: Record<string, unknown> | undefined): AdminGatewayControlProjection;
interface RolloutBodyError {
    status: number;
    body: Record<string, unknown>;
}
export declare function validateDesiredStatusPatch(desiredStatus: string): {
    error: {
        status: number;
        body: {
            error: string;
            got?: string;
        };
    };
} | {
    ok: "running" | "paused" | "draining";
};
export declare function validateDeployBody(body: unknown): {
    error: RolloutBodyError;
} | {
    ok: {
        sourceSha: string;
    };
};
export declare function projectHandoffProgress(assignments: readonly AssignmentDoc[]): Map<string, Record<string, MigrationProgressRecord[]>>;
export declare function shapeOperationsHistoryRecord(id: string, data: Record<string, unknown>): Record<string, unknown>;
export type UserSelfDeletionOutcome = {
    kind: "not-found";
} | {
    kind: "conflict";
} | {
    kind: "workspace-busy";
} | {
    kind: "scheduled";
    deletionId: string;
    eraseAfter: number;
    incompleteStep: {
        name: "suspend-auth" | "revoke-connector-grants";
        error: Error;
    } | null;
};
export declare function scheduleUserSelfDeletion(opts: {
    store: PlatformStateStore;
    accounts: UserAccountReader;
    deps: Pick<FleetRouterDeps, "suspendAuthUser" | "revokeConnectorGrantsForUser">;
    uid: string;
}): Promise<UserSelfDeletionOutcome>;
export declare function addAdminFleetRoutes(router: Router, deps: FleetRouterDeps): Router;
export {};
