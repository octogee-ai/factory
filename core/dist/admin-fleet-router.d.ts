import { Router } from "express";
import { type Firestore } from "firebase-admin/firestore";
import { type GatewayClass, type GatewayImageProfile, type GatewayProfile } from "@octogee/shared/types/glm";
import { type SizingTier } from "@octogee/shared/types/sizing";
import { type GatewayPricingMode } from "@octogee/shared/types/cost-estimator";
export { resolveBuilderActivationPlan } from "./builder-activation-lease.js";
export interface FleetLogger {
    info: (msg: string, meta?: Record<string, unknown>) => void;
    warn: (msg: string, meta?: Record<string, unknown>) => void;
}
export type GatewayPodDiagnosticsStatus = "ready" | "not-ready" | "missing" | "unknown";
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
    workspaceSlugsForUser: (data: {
        username?: string | null;
    }) => string[];
    provisionGatewayAuthSecret: (opts: {
        gatewayId: string;
        gatewayServiceAccount: string;
    }) => Promise<unknown>;
    listGatewayBuilds: (opts: {
        service: string;
        limit: number;
    }) => Promise<unknown[]>;
    readGatewayPodDiagnostics?: (gatewayId: string) => Promise<GatewayPodDiagnostics>;
    readGatewayPodDiagnosticsBatch?: (gatewayIds: readonly string[]) => Promise<Record<string, GatewayPodDiagnostics>>;
    suspendAuthUser: (uid: string) => Promise<void>;
    revokeConnectorGrantsForUser: (uid: string) => Promise<void>;
    dedicatedGatewayIdleDefaultMs?: number;
    dedicatedGatewayIdleSweepMs?: number;
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
export declare const DEDICATED_GATEWAY_IDLE_DEFAULT_MS: number;
export interface DedicatedGatewayIdleSettings {
    configuredMs: number | null;
    defaultMs: number;
    effectiveMs: number;
    sweepMs: number;
    disabled: boolean;
}
export interface FleetRuntimeSettings {
    dedicatedGatewayIdle: DedicatedGatewayIdleSettings;
}
type AdminGatewayDesiredStatus = "running" | "paused" | "draining" | "retired";
export declare function projectDedicatedGatewayIdleSettings(docData: Record<string, unknown> | undefined, defaultMs: number | undefined, sweepMs: number | undefined): DedicatedGatewayIdleSettings;
export declare function parseDedicatedGatewayIdlePatch(body: Record<string, unknown>): {
    ok: number | null;
} | {
    error: {
        status: number;
        body: {
            error: string;
            got?: unknown;
        };
    };
};
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
export declare function projectGatewayReservation(glmDoc: GlmDoc | undefined): {
    type: GatewayPricingMode;
    computeClass: string;
    priceMultiplier: number;
};
export declare function projectGatewaySummary(doc: FirestoreDocLike, glmDoc: GlmDoc | undefined, now: number): {
    gatewayId: string;
    gateway: string;
    status: string;
    desiredStatus: AdminGatewayDesiredStatus | null;
    imageTag: string | null;
    openclawVersion: string | null;
    mountedCustomers: unknown[];
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
};
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
export declare function validateRolloutBody(body: Partial<{
    imageTag: string;
    imageRepository: string;
    profile: string;
    gatewayClass: string;
    imageProfile: string;
}>): {
    error: RolloutBodyError;
} | {
    ok: RolloutBodyOk;
};
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
export declare function buildBuilderCandidates(opts: {
    users: BuilderCandidateDoc[];
    gatewayRoots: BuilderCandidateDoc[];
    reservations: BuilderCandidateDoc[];
    workspaceSlugsForUser: FleetRouterDeps["workspaceSlugsForUser"];
}): BuilderCandidate[];
export declare function addAdminFleetRoutes(router: Router, deps: FleetRouterDeps): Router;
