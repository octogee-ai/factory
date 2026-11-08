import type { GatewayHeartbeatObservation, GatewayRuntimeDoc } from "@octogee/shared/types/gateway-releases";
import type { GatewayRuntime, GatewayVmEgressState, GatewayVmHomeState, GatewayVmSpec, GatewayVmState } from "@octogee/shared/types/glm";
import type { OpaqueMap, RecordPatch, Revision, Stored } from "./store.js";
export type FleetRegistryVmHome = Partial<GatewayVmHomeState> & OpaqueMap;
export interface FleetRegistryVmFields {
    readonly runtime?: GatewayRuntime;
    readonly retiredAt?: number;
    readonly vmSpec?: GatewayVmSpec;
    readonly vm?: GatewayVmState | null;
    readonly vmInstance?: OpaqueMap;
    readonly vmHome?: FleetRegistryVmHome;
    readonly vmStopOnPark?: OpaqueMap;
    readonly vmBootRecovery?: OpaqueMap;
    readonly vmPreemption?: OpaqueMap;
    readonly vmDisk?: OpaqueMap;
    readonly vmImages?: OpaqueMap;
    readonly vmEgress?: GatewayVmEgressState;
    readonly surgeCrashLoopEvictions?: OpaqueMap;
    readonly openclawHealthyBuild?: string;
}
export type FleetRegistryRecord = Omit<GatewayRuntimeDoc, "docKind"> & FleetRegistryVmFields;
export type FleetRegistryPatch = RecordPatch<FleetRegistryRecord, "gatewayId" | "createdAt">;
export type FleetHeartbeatReport = Pick<GatewayHeartbeatObservation, "status" | "mountedCustomers"> & Partial<Omit<GatewayHeartbeatObservation, "status" | "mountedCustomers" | "lastHeartbeatAt">>;
export interface FleetRegistryFence {
    readonly revision?: Revision;
    readonly lifecycle?: readonly FleetRegistryRecord["lifecycle"][];
    readonly vmInstanceId?: string | null;
}
export interface FleetRegistryFilter {
    readonly runtime?: GatewayRuntime;
}
export interface FleetRegistryRepository {
    get(gatewayId: string): Promise<Stored<FleetRegistryRecord> | null>;
    getMany(gatewayIds: readonly string[]): Promise<ReadonlyMap<string, Stored<FleetRegistryRecord>>>;
    list(filter?: FleetRegistryFilter): Promise<readonly Stored<FleetRegistryRecord>[]>;
    findByVmInstanceId(instanceId: string): Promise<Stored<FleetRegistryRecord> | null>;
    create(record: FleetRegistryRecord): Promise<void>;
    upsert(gatewayId: string, initial: FleetRegistryRecord, patch: FleetRegistryPatch): Promise<void>;
    patch(gatewayId: string, patch: FleetRegistryPatch, fence?: FleetRegistryFence): Promise<void>;
    recordHeartbeat(gatewayId: string, heartbeat: FleetHeartbeatReport): Promise<void>;
    delete(gatewayId: string): Promise<void>;
}
