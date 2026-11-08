import type { GatewayStatus } from "@octogee/shared/types/fleet-controller";
import { type CustomerMigrationV2GatewayRootFence } from "@octogee/shared/types/glm";
import { type AssignmentSource, type AssignmentState } from "@octogee/shared/types/gateway-releases";
import type { FleetBrokerCustomerRestoreAuthority } from "@octogee/shared/types/fleet-broker";
import { type WorkspaceMigrationPhase } from "@octogee/shared/types/workspace-migration";
import { type BuilderTierReader } from "./builder-activation-lease.js";
import type { PlatformStateStore, PlatformStateTransaction } from "./platform-state/index.js";
export interface FleetStateDeps {
    store: PlatformStateStore;
    now?: () => Date;
    log?: (msg: string) => void;
}
export interface CutoverDeps extends FleetStateDeps {
    readBuilderTier: BuilderTierReader;
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
export declare function readCustomerRestoreAuthoritySnapshot(deps: Pick<FleetStateDeps, "store">, scope: {
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
export interface GatewayHeartbeatDeps {
    db: FleetStateFirestore;
    serverTimestamp: () => unknown;
}
export declare function writeGatewayHeartbeat(deps: GatewayHeartbeatDeps, snapshot: HeartbeatSnapshot): Promise<void>;
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
        claimStartedAt?: number;
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
export declare function legacyForwardRecoveryMatches(operationId: string, input: Record<string, unknown>, handoff: Record<string, unknown>): boolean;
export declare function migrationCancellationDeferred(operation: Record<string, unknown>, operationId: string): boolean;
export declare function commitCutoverAtomic(deps: CutoverDeps, params: CutoverCommitParams): Promise<void>;
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
    transaction: PlatformStateTransaction;
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
    clearSharedSurgeForwardRecovery?: {
        operationId: string;
        targetPodUid: string;
        receivingPodUid: string;
    };
}
interface SharedSurgeForwardRecoveryParams {
    gatewayId: string;
    uid: string;
    slug: string;
    epoch: number;
    operationId: string;
    targetPodUid: string;
    expectedUpdatedAt: number;
}
export declare function markSharedSurgeForwardRecovery(deps: FleetStateDeps, params: SharedSurgeForwardRecoveryParams): Promise<void>;
export declare function rebindSharedSurgeForwardRecovery(deps: FleetStateDeps, params: SharedSurgeForwardRecoveryParams & {
    expectedReceivingPodUid: string;
    receivingPodUid: string;
}): Promise<void>;
export declare function markAssignmentState(deps: FleetStateDeps, params: MarkAssignmentStateParams): Promise<void>;
export {};
