import type { AccountLifecycle } from "@octogee/shared/types/account-lifecycle";
import type { BuilderAuxiliaryFamily, FleetBrokerCustomerRuntimeReset } from "@octogee/shared/types/fleet-broker";
import type { ScheduleTransferDoc } from "@octogee/shared/types/fleet-controller";
import type { BuilderParkedComputer, GatewayProfile, GatewayVmHomeCheckpoint } from "@octogee/shared/types/glm";
import type { PlacementReceipt, PlacementReceiptKind } from "@octogee/shared/types/placement-receipts";
import type { WorkspaceMigrationMarker } from "@octogee/shared/types/workspace-migration";
import type { Clearable, OpaqueMap, Page, PageRequest, RecordPatch, Revision, Stored, TimeInput } from "./store.js";
export type BuilderRole = "user" | "admin";
export type BuilderActivationLeaseStatus = "requested" | "provisioning" | "activating" | "active" | "returning" | "parked" | "failed";
export interface BuilderActivationLease {
    readonly leaseId: string;
    readonly generation: number;
    readonly status: BuilderActivationLeaseStatus;
    readonly targetGatewayId?: string | null;
    readonly sourceGatewayId?: string;
    readonly sourceAssignmentEpoch?: number;
    readonly lastActiveAt?: number | null;
    readonly [field: string]: unknown;
}
export interface ActivationLeaseFence {
    readonly leaseId: string | null;
    readonly generation: number | null;
    readonly status?: readonly BuilderActivationLeaseStatus[];
}
export interface SourceTransferFence {
    readonly sourceGatewayId: string;
    readonly targetGatewayId: string;
    readonly [field: string]: unknown;
}
export interface ComputerRecoveryFence {
    readonly operationId: string;
    readonly gatewayId: string;
    readonly instanceId?: string | null;
    readonly sharedGatewayId?: string | null;
    readonly assignmentEpoch?: number;
}
export interface BuilderFences {
    readonly restoreFence?: OpaqueMap;
    readonly sourceTransferFence?: SourceTransferFence;
    readonly computerRecovery?: ComputerRecoveryFence;
    readonly migration?: WorkspaceMigrationMarker;
    readonly pendingNativeSchedulerRetirement?: OpaqueMap;
    readonly runtimeReset?: FleetBrokerCustomerRuntimeReset & OpaqueMap;
}
export type BuilderFenceName = keyof BuilderFences;
export interface BuilderProvisioning {
    readonly status?: string;
    readonly startedAt?: number;
    readonly gitRepoUrl?: string;
    readonly gitCreatedAt?: number;
}
export interface BuilderGatewayMirror {
    readonly gatewayId: string;
    readonly gatewayAssignedAt?: number;
    readonly gatewayProfile?: GatewayProfile;
    readonly controlUiEnabled?: boolean;
}
export type BuilderGatewayMirrorInput = Omit<BuilderGatewayMirror, "gatewayAssignedAt"> & {
    readonly gatewayAssignedAt?: TimeInput;
};
export interface BuilderOpenClawState {
    readonly status?: string;
    readonly version?: string;
    readonly agentId?: string;
    readonly customerDir?: string;
    readonly provisionedAt?: number;
    readonly mounted?: boolean;
    readonly managedBy?: "cowboy" | "operator";
    readonly greeting?: OpaqueMap;
    readonly toolchain?: OpaqueMap;
}
export interface BuilderHomeState {
    readonly computer?: BuilderParkedComputer;
    readonly homeCheckpoint?: GatewayVmHomeCheckpoint;
    readonly homeDisk?: OpaqueMap;
    readonly homeStorage?: OpaqueMap;
    readonly homeMigration?: OpaqueMap;
    readonly homeErasure?: readonly OpaqueMap[];
    readonly homeCapacity?: OpaqueMap;
    readonly projectStorageNativeBoot?: OpaqueMap;
}
export interface BuilderAgentRoster {
    readonly agentIds: readonly string[];
    readonly activatedAgents: readonly string[];
}
export type BuilderPersona = OpaqueMap;
export interface BuilderRecord {
    readonly uid: string;
    readonly slug: string | null;
    readonly mattermostUserId: string | null;
    readonly admitted: boolean;
    readonly persona: BuilderPersona | null;
    readonly workspaceId: string | null;
    readonly role: BuilderRole | null;
    readonly createdAt: number | null;
    readonly updatedAt: number;
    readonly provisioning: BuilderProvisioning;
    readonly gateway: BuilderGatewayMirror | null;
    readonly openclaw: BuilderOpenClawState;
    readonly agents: BuilderAgentRoster;
    readonly accountLifecycle: AccountLifecycle | null;
    readonly activationLease: BuilderActivationLease | null;
    readonly fences: BuilderFences;
    readonly home: BuilderHomeState;
}
export interface NewBuilderRecord {
    readonly uid: string;
    readonly createdAt: TimeInput;
}
export interface AdmitBuilderInput {
    readonly slug: string;
    readonly persona: BuilderPersona | null;
    readonly provisioningStartedAt: TimeInput;
}
export interface BuilderPatch {
    readonly slug?: Clearable<string>;
    readonly mattermostUserId?: Clearable<string>;
    readonly workspaceId?: Clearable<string>;
    readonly role?: Clearable<BuilderRole>;
    readonly provisioning?: RecordPatch<Omit<BuilderProvisioning, "startedAt" | "gitCreatedAt">> & {
        readonly startedAt?: Clearable<TimeInput>;
        readonly gitCreatedAt?: Clearable<TimeInput>;
    };
    readonly openclaw?: RecordPatch<Omit<BuilderOpenClawState, "provisionedAt">> & {
        readonly provisionedAt?: Clearable<TimeInput>;
    };
    readonly accountLifecycle?: Clearable<AccountLifecycle>;
    readonly home?: RecordPatch<BuilderHomeState>;
}
export interface BuilderFence {
    readonly revision?: Revision;
    readonly gatewayId?: string | null;
    readonly provisioningStatus?: string | "absent";
}
export interface GatewayFenceHolders {
    readonly assigned: readonly Stored<BuilderRecord>[];
    readonly sourceTransferSource: readonly Stored<BuilderRecord>[];
    readonly sourceTransferTarget: readonly Stored<BuilderRecord>[];
    readonly computerRecovery: readonly Stored<BuilderRecord>[];
}
export interface BuilderGatewayFilter {
    readonly openclawStatus?: string;
    readonly limit?: number;
}
export interface BuilderRecordsRepository {
    get(uid: string): Promise<Stored<BuilderRecord> | null>;
    getMany(uids: readonly string[]): Promise<ReadonlyMap<string, Stored<BuilderRecord>>>;
    findBySlug(slug: string): Promise<Stored<BuilderRecord> | null>;
    findByMattermostUserId(mattermostUserId: string): Promise<Stored<BuilderRecord> | null>;
    findByComputerInstanceId(instanceId: string): Promise<Stored<BuilderRecord> | null>;
    listByAgentId(agentId: string, limit: number): Promise<readonly Stored<BuilderRecord>[]>;
    listByGateway(gatewayId: string, filter?: BuilderGatewayFilter): Promise<readonly Stored<BuilderRecord>[]>;
    listGatewayFenceHolders(gatewayId: string): Promise<GatewayFenceHolders>;
    listAdmitted(): Promise<readonly Stored<BuilderRecord>[]>;
    listAll(): Promise<readonly Stored<BuilderRecord>[]>;
    listByOpenClawStatus(openclawStatus: string): Promise<readonly Stored<BuilderRecord>[]>;
    list(page: PageRequest): Promise<Page<Stored<BuilderRecord>>>;
    create(record: NewBuilderRecord): Promise<void>;
    patch(uid: string, patch: BuilderPatch, fence?: BuilderFence): Promise<void>;
    admit(uid: string, input: AdmitBuilderInput): Promise<void>;
    setGatewayMirror(uid: string, mirror: Clearable<BuilderGatewayMirrorInput>, fence?: BuilderFence): Promise<void>;
    addAgents(uid: string, agentIds: readonly string[]): Promise<void>;
    removeAgents(uid: string, agentIds: readonly string[]): Promise<void>;
    setActivatedAgents(uid: string, activatedAgents: readonly string[]): Promise<void>;
    setActivationLease(uid: string, lease: Clearable<BuilderActivationLease>, fence: ActivationLeaseFence): Promise<void>;
    patchActivationLease(uid: string, patch: RecordPatch<BuilderActivationLease, "leaseId" | "generation">, fence: ActivationLeaseFence): Promise<void>;
    setFence<F extends BuilderFenceName>(uid: string, fence: F, value: Clearable<NonNullable<BuilderFences[F]>>, expected?: NonNullable<BuilderFences[F]> | "absent"): Promise<void>;
    delete(uid: string): Promise<void>;
}
export interface PlacementReceiptsRepository {
    get(uid: string, leaseId: string, generation: number, kind: PlacementReceiptKind): Promise<PlacementReceipt | null>;
    list(uid: string, page: PageRequest): Promise<Page<PlacementReceipt>>;
    create(uid: string, receipt: PlacementReceipt): Promise<void>;
}
export interface ScheduleTransfersRepository {
    get(uid: string, migrationId: string): Promise<Stored<ScheduleTransferDoc> | null>;
    put(uid: string, transfer: ScheduleTransferDoc): Promise<void>;
    patch(uid: string, migrationId: string, patch: RecordPatch<ScheduleTransferDoc, "migrationId">): Promise<void>;
}
export type AgentStoreAnchor = {
    readonly kind: "agent";
    readonly storeId: string;
    readonly agentId: string;
    readonly schema: string;
} | {
    readonly kind: "gateway-state";
    readonly storeId: string;
    readonly schema: string;
} | {
    readonly kind: "auxiliary";
    readonly storeId: string;
    readonly schema: string;
    readonly family: BuilderAuxiliaryFamily;
};
export type AgentStoreRecord = AgentStoreAnchor & {
    readonly gatewayId: string | null;
    readonly generation: number | null;
    readonly assignmentEpoch: number | null;
    readonly recordedAt: number;
};
export interface AgentStoresRepository {
    list(uid: string): Promise<readonly Stored<AgentStoreRecord>[]>;
    put(uid: string, record: AgentStoreRecord): Promise<void>;
    delete(uid: string, storeKey: string): Promise<void>;
}
export interface BuilderRepositories {
    readonly records: BuilderRecordsRepository;
    readonly placementReceipts: PlacementReceiptsRepository;
    readonly scheduleTransfers: ScheduleTransfersRepository;
    readonly agentStores: AgentStoresRepository;
}
export interface BuilderPlacementPolicy {
    readonly uid: string;
    readonly placementAllowed: boolean;
    readonly sizingKey: string | null;
    readonly byot: boolean;
    readonly workspacePermissions: boolean;
}
export interface BuilderPlacementPolicies {
    resolve(uid: string, now: number): Promise<BuilderPlacementPolicy>;
    resolveMany(uids: readonly string[], now: number): Promise<ReadonlyMap<string, BuilderPlacementPolicy>>;
}
export interface BuilderProfile {
    readonly uid: string;
    readonly email: string | null;
    readonly displayName: string | null;
    readonly lastName: string | null;
    readonly photoUrl: string | null;
}
export interface BuilderProfiles {
    resolve(uid: string): Promise<BuilderProfile | null>;
}
export interface ControlSessionAttachment {
    readonly uid: string;
    readonly gatewayId: string;
    readonly workspaceSlug: string;
    readonly attachmentId: string;
}
export interface ControlSessionChecks {
    current(attachment: ControlSessionAttachment, now: number): Promise<boolean>;
}
