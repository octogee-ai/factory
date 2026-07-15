import { type FlushGatewayResponse, type ConfigFreezeResponse, type ConfigRestoreProofResponse, type ConfigUnfreezeResponse, type ImportResponse, type QuiesceResponse, type RestoreMigrationResponse, type UnmountResponse, type VerifyMigrationResponse } from "@octogee/shared/types/fleet-controller";
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
    freezeConfig(opts: {
        migrationId: string;
        gatewayId: string;
        transportId?: string;
        slug: string;
    }): Promise<ConfigFreezeResponse>;
    proveConfigRestore(opts: {
        migrationId: string;
        gatewayId: string;
        transportId?: string;
        slug: string;
        checkpointCommit: string;
    }): Promise<ConfigRestoreProofResponse>;
    reproveConfigRestore(opts: {
        migrationId: string;
        gatewayId: string;
        transportId?: string;
        slug: string;
        checkpointCommit: string;
    }): Promise<ConfigRestoreProofResponse>;
    unfreezeConfig(opts: {
        migrationId: string;
        gatewayId: string;
        transportId?: string;
        slug: string;
    }): Promise<ConfigUnfreezeResponse>;
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
