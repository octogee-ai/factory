import { type MigrationPhase } from "./fleet-migration.js";
import type { MigrationClient } from "./fleet-migration-client.js";
import type { FleetBrokerUserSnapshot } from "@octogee/shared/types/fleet-broker";
import type { ConfigFreezeResponse, ConfigRestoreProofResponse, SystemConfigMigrationMode } from "@octogee/shared/types/fleet-controller";
export interface ReportedStep {
    name: string;
    status: "running" | "done" | "failed" | "skipped";
    error?: string;
}
export interface CutoverAssignmentRevision {
    revisionId: string;
    release: number;
}
export interface MigrationRollFence {
    uid: string;
    gatewayId: string;
    rollOperationId: string;
    targetRevisionId: string;
    targetRelease: number;
    sourceRevisionId: string;
    sourceEpoch: number;
    configReady?: {
        observedRevisionId: string;
        acceptedCommit: string;
        configReadyAt: number;
        runtimeConfigHash: string;
    };
}
export interface CutoverCommit {
    uid: string;
    slug: string;
    toGatewayId: string;
    fromGatewayId: string;
    flipMirror: boolean;
    revision: CutoverAssignmentRevision | null;
    rollFence?: MigrationRollFence;
}
export interface MigrationRunnerDeps {
    client: MigrationClient;
    commitCutover: (commit: CutoverCommit) => Promise<void>;
    setAssignmentState?: (input: {
        gatewayId: string;
        uid: string;
        state: "serving" | "quiescing" | "migrating";
    }) => Promise<void>;
    acceptConfigProof?: (input: {
        migrationId: string;
        slug: string;
        sourceRevisionId: string;
        targetRevisionId: string;
        checkpoint: Pick<ConfigFreezeResponse, "checkpointCommit" | "configHash">;
        proof: Pick<ConfigRestoreProofResponse, "restoredCommit" | "acceptedCommit" | "configHash" | "configReady" | "observedRevisionId" | "restoreProvenAt" | "configReadyAt" | "runtimeConfigHash">;
    }) => Promise<void>;
    log: (msg: string) => void;
    reportStep?: (step: ReportedStep) => Promise<void> | void;
}
export interface MigrationRunnerInput {
    migrationId: string;
    uid: string;
    slug: string;
    fromGatewayId: string;
    toGatewayId: string;
    fromTransportId?: string;
    toTransportId?: string;
    toRevision?: CutoverAssignmentRevision | null;
    fromRevision?: CutoverAssignmentRevision | null;
    crossGateway?: boolean;
    restoreSnapshot: FleetBrokerUserSnapshot;
    includeActivationManifest?: boolean;
    systemConfigMigrationMode?: SystemConfigMigrationMode;
    rollFence?: MigrationRollFence;
}
export interface ConfigCleanupObligation {
    migrationId: string;
    slug: string;
    sourceGatewayId: string;
    sourceTransportId: string;
    completeSourceUnmount: boolean;
    resume: {
        success: boolean;
        rolledBack: boolean;
        error?: string;
        configCheckpoint?: Pick<ConfigFreezeResponse, "checkpointCommit" | "configHash">;
        configProof?: Pick<ConfigRestoreProofResponse, "restoredCommit" | "acceptedCommit" | "configHash" | "configReady" | "observedRevisionId" | "restoreProvenAt" | "configReadyAt" | "runtimeConfigHash">;
    };
}
export interface MigrationRunnerResult {
    success: boolean;
    finalPhase: MigrationPhase;
    errorAt?: {
        phase: MigrationPhase;
        error: string;
    };
    rolledBack: boolean;
    configCheckpoint?: Pick<ConfigFreezeResponse, "checkpointCommit" | "configHash">;
    configProof?: Pick<ConfigRestoreProofResponse, "restoredCommit" | "acceptedCommit" | "configHash" | "configReady" | "observedRevisionId" | "restoreProvenAt" | "configReadyAt" | "runtimeConfigHash">;
    configCleanup?: ConfigCleanupObligation;
}
export declare function runMigration(input: MigrationRunnerInput, deps: MigrationRunnerDeps): Promise<MigrationRunnerResult>;
