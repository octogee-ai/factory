import { type FlushGatewayResponse, type ConfigFreezeV2Response, type ConfigCandidateProofResponse, type ConfigPromoteCandidateResponse, type ConfigAbortV2Response, type ConfigFinalizeV2Response, type ConfigRetireV2Response, type ImportResponse, type QuiesceResponse, type RestoreMigrationResponse, type UnmountResponse, type VerifyMigrationResponse } from "@octogee/shared/types/fleet-controller";
import type { FleetBrokerUserSnapshot } from "@octogee/shared/types/fleet-broker";
import type { MigrationSyncMode } from "./fleet-migration.js";
export interface MigrationClientTimeouts {
    quiesceMs?: number;
    transferMs?: number;
    unmountMs?: number;
    verifyMs?: number;
}
export interface MigrationClientDeps {
    privateKey: string;
    resolveGatewayUrl: (gatewayId: string) => string;
    fetch?: typeof globalThis.fetch;
    log?: (msg: string) => void;
    timeouts?: MigrationClientTimeouts;
    now?: () => number;
    genRequestId?: () => string;
}
export interface MigrationClient {
    freezeConfig(opts: LegacyConfigControlOpts): Promise<LegacyConfigFreezeResponse>;
    proveConfigRestore(opts: LegacyConfigControlOpts & {
        checkpointCommit: string;
    }): Promise<LegacyConfigRestoreProofResponse>;
    reproveConfigRestore(opts: LegacyConfigControlOpts & {
        checkpointCommit: string;
    }): Promise<LegacyConfigRestoreProofResponse>;
    unfreezeConfig(opts: LegacyConfigControlOpts): Promise<LegacyConfigUnfreezeResponse>;
    freezeConfigV2(opts: ConfigControlOpts): Promise<ConfigFreezeV2Response>;
    proveConfigCandidate(opts: ConfigControlOpts & {
        checkpointCommit: string;
        freezeObject: string;
    }): Promise<ConfigCandidateProofResponse>;
    promoteConfigCandidate(opts: ConfigControlOpts & {
        checkpointCommit: string;
        candidateCommit: string;
        candidateHash: string;
        freezeObject: string;
    }): Promise<ConfigPromoteCandidateResponse>;
    abortConfigV2(opts: ConfigControlOpts & {
        checkpointCommit: string;
        candidateCommit: string | null;
        freezeObject: string;
    }): Promise<ConfigAbortV2Response>;
    finalizeConfigV2(opts: ConfigControlOpts & {
        checkpointCommit: string;
        candidateCommit: string;
        candidateHash: string;
        freezeObject: string;
    }): Promise<ConfigFinalizeV2Response>;
    retireConfigV2(opts: ConfigControlOpts & {
        checkpointCommit: string;
        freezeObject: string;
    }): Promise<ConfigRetireV2Response>;
    quiesce(opts: {
        migrationId: string;
        gatewayId: string;
        transportId?: string;
        slug: string;
        timeoutMs?: number;
    }): Promise<QuiesceResponse>;
    flushGateway(opts: {
        migrationId: string;
        gatewayId: string;
        transportId?: string;
        slug: string;
        reason: string;
    }): Promise<FlushGatewayResponse>;
    restoreTarget(opts: {
        migrationId: string;
        gatewayId: string;
        transportId?: string;
        uid: string;
        slug: string;
        snapshot: FleetBrokerUserSnapshot;
    }): Promise<RestoreMigrationResponse>;
    transferState(opts: {
        migrationId: string;
        fromGatewayId: string;
        toGatewayId: string;
        fromTransportId?: string;
        toTransportId?: string;
        slug: string;
        mode?: MigrationSyncMode;
        includeActivationManifest?: boolean;
    }): Promise<ImportResponse>;
    verifyTarget(opts: {
        migrationId: string;
        gatewayId: string;
        transportId?: string;
        slug: string;
        timeoutMs?: number;
    }): Promise<VerifyMigrationResponse>;
    unmount(opts: {
        migrationId: string;
        gatewayId: string;
        transportId?: string;
        slug: string;
    }): Promise<UnmountResponse>;
}
export interface LegacyConfigControlOpts {
    migrationId: string;
    gatewayId: string;
    transportId?: string;
    slug: string;
}
export interface LegacyConfigFreezeResponse {
    migrationId: string;
    slug: string;
    frozen: true;
    checkpointCommit: string;
    configHash: string;
}
export interface LegacyConfigRestoreProofResponse {
    migrationId: string;
    slug: string;
    restoredCommit: string;
    acceptedCommit: string;
    configHash: string;
    configReady: true;
    observedRevisionId: string;
    restoreProvenAt: number;
    configReadyAt: number;
    runtimeConfigHash: string;
}
export interface LegacyConfigUnfreezeResponse {
    migrationId: string;
    slug: string;
    unfrozen: true;
}
export interface ConfigControlOpts {
    migrationId: string;
    gatewayId: string;
    transportId?: string;
    slug: string;
    sourceRevisionId: string;
    targetRevisionId: string;
}
export interface MigrationRpcErrorOptions {
    status?: number;
    code?: string;
    ownerMigrationId?: string;
    slug?: string;
}
export declare class MigrationRpcError extends Error {
    readonly status?: number;
    readonly code?: string;
    readonly ownerMigrationId?: string;
    readonly slug?: string;
    constructor(message: string, options?: MigrationRpcErrorOptions);
}
export declare function isDefinitiveConfigRpcRejection(error: unknown): boolean;
export declare function isDefinitiveFreezeRejection(error: unknown): boolean;
export declare function isFreezeOwnerConflict(error: unknown): error is MigrationRpcError & {
    ownerMigrationId: string;
    slug: string;
};
export declare function createMigrationClient(deps: MigrationClientDeps): MigrationClient;
