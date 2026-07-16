import type { Firestore } from "firebase-admin/firestore";
import { type GatewayRetirementConfigCheckpoint, type GatewayRetirementConfigTerminal } from "@octogee/shared/types/gateway-releases";
export declare class GatewayRetirementConflictError extends Error {
    constructor(message: string);
}
interface RetirementOperation {
    input?: unknown;
    [key: string]: unknown;
}
interface ClaimGatewayRetirementInput {
    db: Firestore;
    gatewayId: string;
    operationId: string;
    operation: RetirementOperation;
    now: number;
    updatedBy: string;
}
interface VerifyGatewayRetirementClaimInput {
    db: Firestore;
    gatewayId: string;
    operationId: string;
    version: number;
    now: number;
    updatedBy: string;
}
interface AttestGatewayRetirementAfterWakeInput extends VerifyGatewayRetirementClaimInput {
}
interface BindGatewayRetirementConfigCheckpointInput extends VerifyGatewayRetirementClaimInput {
    checkpoint: GatewayRetirementConfigCheckpoint;
}
interface VerifyGatewayRetirementConfigCheckpointInput {
    db: Firestore;
    gatewayId: string;
    operationId: string;
    version: number;
    checkpoint: GatewayRetirementConfigCheckpoint;
    now: number;
}
interface BindGatewayRetirementConfigTerminalInput extends VerifyGatewayRetirementClaimInput {
    checkpoint: GatewayRetirementConfigCheckpoint;
    terminal: GatewayRetirementConfigTerminal;
    recovery?: true;
}
interface VerifyGatewayRetirementConfigTerminalInput {
    db: Firestore;
    gatewayId: string;
    operationId: string;
    version: number;
    checkpoint: GatewayRetirementConfigCheckpoint;
    terminal: GatewayRetirementConfigTerminal;
    now: number;
}
export type GatewayRetirementVerification = {
    ok: true;
} | {
    ok: false;
    error: string;
};
export type GatewayRetirementWakeAttestation = {
    ok: true;
    wakeRequired: boolean;
} | {
    ok: false;
    error: string;
    retryable: boolean;
};
export declare function hasGatewayRetirementConfigObligation(status: unknown): boolean;
export declare function claimGatewayRetirementAtomic(input: ClaimGatewayRetirementInput): Promise<{
    version: number;
    wakeRequired: boolean;
}>;
export declare function attestGatewayRetirementAfterWakeAtomic(input: AttestGatewayRetirementAfterWakeInput): Promise<GatewayRetirementWakeAttestation>;
export declare function verifyGatewayRetirementClaimAtomic(input: VerifyGatewayRetirementClaimInput): Promise<GatewayRetirementVerification>;
export declare function bindGatewayRetirementConfigCheckpointAtomic(input: BindGatewayRetirementConfigCheckpointInput): Promise<GatewayRetirementVerification>;
export declare function verifyGatewayRetirementConfigCheckpointAtomic(input: VerifyGatewayRetirementConfigCheckpointInput): Promise<GatewayRetirementVerification>;
export declare function bindGatewayRetirementConfigTerminalAtomic(input: BindGatewayRetirementConfigTerminalInput): Promise<GatewayRetirementVerification>;
export declare function verifyGatewayRetirementConfigTerminalAtomic(input: VerifyGatewayRetirementConfigTerminalInput): Promise<GatewayRetirementVerification>;
export {};
