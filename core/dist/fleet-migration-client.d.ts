import { type FlushGatewayResponse, type ImportResponse, type MigrationProgressRequestBody, type QuiesceResponse, type RestoreMigrationResponse, type UnmountResponse, type VerifyMigrationResponse } from "@octogee/shared/types/fleet-controller";
import type { FleetBrokerProjectCheckoutScope, FleetBrokerUserSnapshot } from "@octogee/shared/types/fleet-broker";
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
}
export interface MigrationClient {
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
        expectedSystemConfigCommit?: string;
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
        projectCheckoutScope?: FleetBrokerProjectCheckoutScope;
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
}
export declare class MigrationRpcError extends Error {
    readonly status?: number;
    readonly code?: string;
    constructor(message: string, options?: MigrationRpcErrorOptions);
}
export declare class MigrationTransportError extends Error {
    readonly retryable = true;
    constructor(message: string, options?: {
        cause?: unknown;
    });
}
export declare function isDefinitiveConfigRpcRejection(error: unknown): boolean;
export declare function createMigrationClient(deps: MigrationClientDeps): MigrationClient;
export declare function reportMigrationProgress(deps: MigrationClientDeps, gatewayId: string, body: MigrationProgressRequestBody): Promise<void>;
