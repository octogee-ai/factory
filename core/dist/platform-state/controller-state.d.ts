import type { PlatformReleaseRecord } from "@octogee/shared/types/gateway-releases";
import type { SharedPoolReplacement } from "@octogee/shared/types/shared-gateway-pool";
import type { OpaqueMap, RecordPatch, Revision, Stored } from "./store.js";
export interface SharedPoolScalerState {
    readonly schemaVersion: 1;
    readonly actionSequence: number;
    readonly lastActionAt: number | null;
    readonly replacements: readonly SharedPoolReplacement[];
    readonly lastAction: OpaqueMap | null;
    readonly updatedAt: number;
}
export type SharedPoolScalerPatch = RecordPatch<SharedPoolScalerState, "schemaVersion">;
export interface SharedPoolScalerFence {
    readonly revision?: Revision;
    readonly actionSequence?: number;
}
export interface SharedPoolScalerStateRepository {
    get(): Promise<Stored<SharedPoolScalerState> | null>;
    put(state: SharedPoolScalerState, fence: SharedPoolScalerFence | "absent"): Promise<void>;
    patch(patch: SharedPoolScalerPatch, fence?: SharedPoolScalerFence): Promise<void>;
}
export interface PlatformReleaseRecordRepository {
    get(): Promise<Stored<PlatformReleaseRecord> | null>;
    put(record: PlatformReleaseRecord): Promise<void>;
}
export interface ControllerStateRepositories {
    readonly sharedPoolScaler: SharedPoolScalerStateRepository;
    readonly platformRelease: PlatformReleaseRecordRepository;
}
