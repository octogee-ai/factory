import { type GatewayStatus, type NativeSharedAgentContextStage } from "@octogee/shared/types/fleet-controller";
import { type CustomerMigrationV2GatewayRootFence } from "@octogee/shared/types/glm";
import { type AssignmentSource, type AssignmentState } from "@octogee/shared/types/gateway-releases";
import type { FleetBrokerCustomerRestoreAuthority } from "@octogee/shared/types/fleet-broker";
import { type WorkspaceMigrationPhase } from "@octogee/shared/types/workspace-migration";
export interface FleetStateDeps {
    db: FleetStateFirestore;
    serverTimestamp: () => unknown;
    deleteField: () => unknown;
    now?: () => Date;
    log?: (msg: string) => void;
}
export declare function setWorkspaceMigrationPhase(deps: FleetStateDeps, params: {
    uid: string;
    sourceGatewayId: string;
    operationId: string;
    phase: WorkspaceMigrationPhase;
}): Promise<void>;
export interface WorkspaceMigrationPreparationParams {
    uid: string;
    sourceGatewayId: string;
    operationId: string;
    sourceAssignmentMode: "assigned" | "unassigned-live";
    sourceRelease: number;
    sourceEpoch: number;
    sourceRootUpdatedAt?: number;
}
export interface WorkspaceMigrationRecoveryParams {
    uid: string;
    sourceGatewayId: string;
    operationId: string;
    sourceEpoch: number;
    claimStartedAt: number;
}
export interface WorkspaceMigrationSourcePreparationParams extends WorkspaceMigrationRecoveryParams {
    slug: string;
    targetGatewayId: string;
}
export declare function assertWorkspaceMigrationSourcePreparationAuthority(deps: FleetStateDeps, params: WorkspaceMigrationSourcePreparationParams): Promise<void>;
export declare function assertWorkspaceMigrationRecoveryAuthority(deps: FleetStateDeps, params: WorkspaceMigrationRecoveryParams): Promise<void>;
export declare function builderActivationRecoveryTargetMatches(params: {
    operationId: string;
    input: Record<string, unknown>;
    openclaw: Record<string, unknown>;
    sourceEpoch: number;
    targetRoot: unknown;
}): boolean;
export declare function completeWorkspaceMigrationRecovery(deps: FleetStateDeps, params: WorkspaceMigrationRecoveryParams): Promise<void>;
export declare function sharedRecoveryTargetCleaned(input: Record<string, unknown>, schedulerHandoff: unknown): boolean;
export declare function clearWorkspaceMigrationPreparation(deps: FleetStateDeps, params: WorkspaceMigrationPreparationParams): Promise<void>;
export declare function clearRetiredBuilderActivationPreparation(deps: FleetStateDeps, params: {
    uid: string;
    targetGatewayId: string;
    generation: number;
    retirementOperationId: string;
}): Promise<boolean>;
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
export interface CustomerRestoreInput {
    fromGatewayId: string;
    uid: string;
    slug: string;
    gatewayId: string;
    assignmentEpoch: number;
    operationId: string;
    claimStartedAt: number;
    attemptId: string;
}
export declare function readCustomerRestoreAuthoritySnapshot(deps: Pick<FleetStateDeps, "db">, scope: {
    uid: string;
    slug: string;
    gatewayId: string;
}): Promise<FleetBrokerCustomerRestoreAuthority | undefined>;
export declare function beginCustomerRestore(deps: FleetStateDeps, input: CustomerRestoreInput, options?: {
    resume?: boolean;
}): Promise<CustomerRestoreInput>;
export declare function acknowledgeCustomerRestore(deps: FleetStateDeps, input: CustomerRestoreInput): Promise<void>;
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
    nativeSharedContextHold?: {
        operationId: string;
        claimedStartedAt: number;
        migrationId: string;
        stage: NativeSharedAgentContextStage;
    };
    customerMigrationV2Fence?: {
        claimStartedAt?: number;
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
    kind: "recover-shared-customer";
    uid: string;
    slug: string;
    fromGatewayId: string;
    toGatewayId: string;
    expectedSourceEpoch: number;
    sharedGatewayIds: readonly string[];
    targetHeartbeatMaxAgeMs: number;
    validateTarget?: (context: UnavailableGatewayRecoveryTargetValidationContext) => Promise<void>;
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
export interface RecoveredDisposableRuntimeResetParams {
    operationId: string;
    previousRecoveryOperationId: string;
    uid: string;
    slug: string;
    targetGatewayId: string;
    expectedAssignmentEpoch: number;
    sharedGatewayIds: readonly string[];
    targetHeartbeatMaxAgeMs: number;
}
export declare function commitRecoveredDisposableRuntimeResetAtomic(deps: FleetStateDeps, params: RecoveredDisposableRuntimeResetParams): Promise<{
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
        updatedAt?: number;
    };
    automatic?: boolean;
}
export declare function markAssignmentState(deps: FleetStateDeps, params: MarkAssignmentStateParams): Promise<void>;
