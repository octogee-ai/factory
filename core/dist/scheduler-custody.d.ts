import { type Operation } from "@octogee/shared/types/glm";
import type { MigrationClient } from "./fleet-migration-client.js";
export type SchedulerCustodyOwner = Pick<Operation, "kind" | "status" | "input" | "cutoverCommittedAt" | "completedAt">;
export interface SchedulerCustodyScope {
    uid: string;
    slug: string;
    gatewayId: string;
    operationId: string;
    ownedSince: number;
}
export interface SchedulerCustodyDeps {
    scheduler: MigrationClient["scheduler"];
    readOperation: (operationId: string) => Promise<SchedulerCustodyOwner | null>;
    assertOwner: () => Promise<void>;
    log: (message: string) => void;
}
export type SchedulerFenceOutcome = {
    agentId: string;
    outcome: "released";
    holder: string | null;
} | {
    agentId: string;
    outcome: "clear";
} | {
    agentId: string;
    outcome: "kept";
    holder: string;
    reason: string;
} | {
    agentId: string;
    outcome: "failed";
    holder: string | null;
    error: string;
    transient: boolean;
};
export declare function heldSchedulerMigration(error: string): {
    agentId: string;
    migrationId: string;
} | null;
export declare function schedulerReleaseId(operationId: string, agentId: string): string;
export declare function releaseSchedulerCustody(deps: SchedulerCustodyDeps, scope: SchedulerCustodyScope, agentIds: readonly string[]): Promise<SchedulerFenceOutcome[]>;
