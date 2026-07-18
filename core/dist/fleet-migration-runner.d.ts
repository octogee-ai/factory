import { type MigrationPhase } from "./fleet-migration.js";
import type { MigrationClient } from "./fleet-migration-client.js";
import type { FleetBrokerUserSnapshot } from "@octogee/shared/types/fleet-broker";
export interface ReportedStep {
    name: string;
    status: "running" | "done" | "failed" | "skipped";
    error?: string;
}
export interface CutoverCommit {
    uid: string;
    slug: string;
    toGatewayId: string;
    fromGatewayId: string;
    flipMirror: boolean;
}
export interface MigrationRunnerDeps {
    client: MigrationClient;
    commitCutover: (commit: CutoverCommit) => Promise<void>;
    setAssignmentState?: (input: {
        gatewayId: string;
        uid: string;
        state: "serving" | "quiescing" | "migrating";
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
    crossGateway?: boolean;
    gateAssignment?: boolean;
    restoreSnapshot: FleetBrokerUserSnapshot;
    includeActivationManifest?: boolean;
}
export interface MigrationRunnerResult {
    success: boolean;
    finalPhase: MigrationPhase;
    errorAt?: {
        phase: MigrationPhase;
        error: string;
    };
    rolledBack: boolean;
}
export declare function runMigration(input: MigrationRunnerInput, deps: MigrationRunnerDeps): Promise<MigrationRunnerResult>;
