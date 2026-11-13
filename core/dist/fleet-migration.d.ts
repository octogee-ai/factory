export type MigrationPhase = "initial" | "keys-synced" | "pre-synced" | "source-quiesced" | "source-flushed" | "final-synced" | "target-verified" | "cutover-done" | "source-unmounted" | "done";
export interface MigrationState {
    phase: MigrationPhase;
    slug: string;
    uid: string;
    fromGatewayId: string;
    toGatewayId: string;
}
export type MigrationSyncMode = "keys" | "pre" | "final";
export type MigrationStep = {
    action: "quiesce-source";
    gateway: string;
    slug: string;
} | {
    action: "flush-source";
    gateway: string;
    slug: string;
} | {
    action: "sync-state";
    mode: MigrationSyncMode;
    from: string;
    to: string;
    slug: string;
} | {
    action: "verify-target";
    gateway: string;
    slug: string;
} | {
    action: "cutover-firestore";
    uid: string;
    from: string;
    to: string;
} | {
    action: "unmount-gateway";
    role: "source" | "target";
    gateway: string;
    slug: string;
} | {
    action: "complete";
};
export declare function nextMigrationStep(state: MigrationState): MigrationStep;
export declare function advancePhase(p: MigrationPhase): MigrationPhase;
export declare function fullPlan(state: MigrationState): MigrationStep[];
export declare function rollbackPlan(state: MigrationState): MigrationStep[];
export declare function describeStep(step: MigrationStep): string;
