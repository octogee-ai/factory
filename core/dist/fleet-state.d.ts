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
    status: GatewayStatus;
    version: string;
    openclawVersion: string;
    mountedCustomers: string[];
    internalUrl: string;
    startedAt: number;
}
export declare function writeGatewayHeartbeat(deps: FleetStateDeps, snapshot: HeartbeatSnapshot): Promise<void>;
export interface CutoverCommitParams {
    uid: string;
    slug: string;
    toGatewayId: string;
    fromGatewayId: string;
    flipMirror: boolean;
    assignment: {
        source: AssignmentSource;
        updatedByOperationId: string | null;
    } | null;
    customerMigrationV2Fence?: {
        strategy: "migrate-state" | "provision-fresh";
        operationId: string;
        migrationId: string;
        uid: string;
        slug: string;
        sourceGatewayId: string;
        sourceEpoch: number;
        sourceRelease: number;
        sourceAssignmentMode: "assigned" | "unassigned-live";
        sourceRootFence: CustomerMigrationV2GatewayRootFence;
        targetGatewayId: string;
        targetRelease: number;
        targetRootFence: CustomerMigrationV2GatewayRootFence;
    };
    automatic?: boolean;
}
export declare function commitCutoverAtomic(deps: FleetStateDeps, params: CutoverCommitParams): Promise<void>;
export interface UnavailableGatewayRecoveryParams {
    operationId: string;
    kind: "recover-shared-customer" | "recover-disposable-customer";
    uid: string;
    slug: string;
    fromGatewayId: string;
    toGatewayId: string;
    expectedSourceEpoch: number;
    sharedGatewayIds: readonly string[];
    targetHeartbeatMaxAgeMs: number;
    validateTarget?: (context: UnavailableGatewayRecoveryTargetValidationContext) => Promise<void>;
    disposableLease?: {
        leaseId: string;
        generation: number;
    };
}
export interface UnavailableGatewayRecoveryTargetValidationContext {
    txn: FleetStateTxn;
    targetGatewayId: string;
    targetRoot: Record<string, unknown>;
    targetRuntime: Record<string, unknown>;
}
export declare function commitUnavailableGatewayRecoveryAtomic(deps: FleetStateDeps, params: UnavailableGatewayRecoveryParams): Promise<{
    operationId: string;
}>;
export interface MarkAssignmentStateParams {
    gatewayId: string;
    uid: string;
    state: AssignmentState;
    slug?: string;
    epoch?: number;
    updatedByOperationId?: string;
    createIfMissing?: boolean;
    expected?: {
        state: AssignmentState;
        updatedByOperationId: string | null;
    };
    automatic?: boolean;
}
export declare function markAssignmentState(deps: FleetStateDeps, params: MarkAssignmentStateParams): Promise<void>;
