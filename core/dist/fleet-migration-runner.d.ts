import { type MigrationPhase } from "./fleet-migration.js";
import { type MigrationClient } from "./fleet-migration-client.js";
import type { FleetBrokerProjectCheckoutScope } from "@octogee/shared/types/fleet-broker";
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
    recordSchedulesStaged?: () => Promise<void>;
    setMigrationPhase?: (phase: "preparing" | "waiting" | "transferring" | "connecting") => Promise<void>;
    readTargetSystemConfigCommit?: (gatewayId: string) => Promise<string | null>;
    persistForwardRecovery?: (state: {
        sourceSystemConfigCommit?: string;
    }) => Promise<void>;
    now?: () => number;
    wait?: (delayMs: number) => Promise<void>;
}
export declare function isTargetSchedulerNotReady(error: unknown): boolean;
export interface MigrationRunnerInput {
    resumeForwardRecovery?: {
        sourceSystemConfigCommit?: string;
    };
    migrationId: string;
    uid: string;
    slug: string;
    fromGatewayId: string;
    toGatewayId: string;
    crossGateway?: boolean;
    gateAssignment?: boolean;
    schedulerMigrationId?: string;
    acceptRetainedTargetJobs?: boolean;
    projectCheckoutScope?: FleetBrokerProjectCheckoutScope;
    includeActivationManifest?: boolean;
    stageSchedulesAfterCutover?: boolean;
    convergeTargetSystemConfig?: TargetSystemConfigConvergence;
}
export type TargetSystemConfigConvergence = "source-commit" | "target-commit";
export interface MigrationRunnerResult {
    waitingForBuilderIdle?: boolean;
    success: boolean;
    finalPhase: MigrationPhase;
    errorAt?: {
        phase: MigrationPhase;
        error: string;
    };
    rolledBack: boolean;
}
type SchedulerRequest = Parameters<MigrationClient["scheduler"]>[0];
type TargetSchedulerDeps = Pick<MigrationRunnerDeps, "client" | "log" | "now" | "wait">;
export declare function callReleasedTargetScheduler(deps: TargetSchedulerDeps, request: SchedulerRequest): Promise<void>;
export declare function runMigration(input: MigrationRunnerInput, deps: MigrationRunnerDeps): Promise<MigrationRunnerResult>;
export {};
