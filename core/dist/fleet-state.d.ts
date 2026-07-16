import { type GatewayStatus } from "@octogee/shared/types/fleet-controller";
import { type CustomerMigrationV2GatewayRootFence } from "@octogee/shared/types/glm";
import { type AssignmentSource, type AssignmentState } from "@octogee/shared/types/gateway-releases";
export interface FleetStateDeps {
    db: FleetStateFirestore;
    serverTimestamp: () => unknown;
    now?: () => Date;
    log?: (msg: string) => void;
}
export interface FleetStateDocRef {
    set: (data: Record<string, unknown>, options?: {
        merge?: boolean;
    }) => Promise<unknown>;
    update: (data: Record<string, unknown>) => Promise<unknown>;
    get: () => Promise<{
        exists: boolean;
        data: () => Record<string, unknown> | undefined;
    }>;
    collection?: (name: string) => {
        doc: (id: string) => FleetStateDocRef;
    };
}
export interface FleetStateTxn {
    get: (ref: FleetStateDocRef) => Promise<{
        exists: boolean;
        data: () => Record<string, unknown> | undefined;
    }>;
    update: (ref: FleetStateDocRef, data: Record<string, unknown>) => void;
    set: (ref: FleetStateDocRef, data: Record<string, unknown>, options?: {
        merge?: boolean;
    }) => void;
    delete: (ref: FleetStateDocRef) => void;
}
export interface FleetStateFirestore {
    collection: (name: string) => {
        doc: (id: string) => FleetStateDocRef;
    };
    runTransaction: <T>(body: (txn: FleetStateTxn) => Promise<T>) => Promise<T>;
}
export interface HeartbeatSnapshot {
    gatewayId: string;
    revisionId: string;
    status: GatewayStatus;
    version: string;
    openclawVersion: string;
    mountedCustomers: string[];
    internalUrl: string;
    startedAt: number;
}
export interface CutoverUserGatewayParams {
    uid: string;
    slug: string;
    toGatewayId: string;
}
export declare function writeGatewayHeartbeat(deps: FleetStateDeps, snapshot: HeartbeatSnapshot): Promise<void>;
export declare function cutoverUserGatewayAndMarkMounted(deps: FleetStateDeps, params: CutoverUserGatewayParams): Promise<void>;
export interface CutoverCommitParams {
    uid: string;
    slug: string;
    toGatewayId: string;
    fromGatewayId: string;
    flipMirror: boolean;
    assignment: {
        revisionId: string;
        release: number;
        source: AssignmentSource;
        updatedByOperationId: string | null;
    } | null;
    rollFence?: {
        operationId: string;
        targetRevisionId: string;
        targetRelease: number;
        sourceRevisionId: string;
        sourceEpoch: number;
        sourceConfigCheckpoint?: {
            migrationId: string;
            checkpointCommit: string;
            configHash: string;
        };
        configReady?: {
            observedRevisionId: string;
            acceptedCommit: string;
            configReadyAt: number;
            runtimeConfigHash: string;
        };
    };
    customerMigrationV2Fence?: {
        operationId: string;
        migrationId: string;
        uid: string;
        slug: string;
        sourceGatewayId: string;
        sourceRevisionId: string;
        sourceEpoch: number;
        sourceRelease: number;
        sourceAssignmentMode: "assigned" | "unassigned-live";
        sourceRootFence: CustomerMigrationV2GatewayRootFence;
        targetGatewayId: string;
        targetRevisionId: string;
        targetRelease: number;
        targetRootFence: CustomerMigrationV2GatewayRootFence;
        checkpointCommit: string;
        configHash: string;
        freezeObject: string;
        candidateCommit: string;
        candidateHash: string;
        runtimeConfigHash: string;
        targetStartedAt: number;
        imageTag: string;
        buildSha: string;
        openclawVersion: string;
        provenAt: number;
    };
}
export declare function commitCutoverAtomic(deps: FleetStateDeps, params: CutoverCommitParams): Promise<void>;
export interface MarkAssignmentStateParams {
    gatewayId: string;
    uid: string;
    state: AssignmentState;
    slug?: string;
    revisionId?: string;
    release?: number;
    epoch?: number;
    updatedByOperationId?: string;
    createIfMissing?: boolean;
}
export declare function markAssignmentState(deps: FleetStateDeps, params: MarkAssignmentStateParams): Promise<void>;
