import { type ModelAccess, type SpendThrottleState } from "./model-broker-usage.js";
export type UserEntitlementInputs = object;
export type MaxProjects = number | "unlimited";
export type ProjectAccessMode = "active" | "archive_read";
export interface UserPlan {
    modelAccess: ModelAccess;
    spendWeekUsd: number;
    spendWindowUsd: number;
    toolAccess: boolean;
    houseFallback: boolean;
}
export interface ContextFilePolicy {
    templateKey: string;
    removedFiles: readonly string[];
}
export type ProductFields = Readonly<Record<string, unknown>>;
export interface UserProductProjection {
    agentUsageStatus(user: UserEntitlementInputs, now: Date): ProductFields;
    agentSupportBuilder(user: UserEntitlementInputs): ProductFields;
    agentModels(user: UserEntitlementInputs): ProductFields;
    adminCustomerSummary(user: UserEntitlementInputs, usage: {
        costUsd: number;
        now: Date;
    }): ProductFields;
    adminCustomerDetail(user: UserEntitlementInputs): ProductFields;
    adminCustomerStats(summaries: readonly ProductFields[]): ProductFields;
}
export interface UserSpendObservation {
    windowCostUsd: number;
    weekCostUsd: number;
    onOwnerCredential: boolean;
    creditBalanceUsd?: number | null;
}
export interface UserEntitlementResolver {
    plan(user: UserEntitlementInputs, now?: Date): UserPlan;
    sizingKey(user: UserEntitlementInputs, now?: Date): string | null;
    projectMode(user: UserEntitlementInputs, now?: Date): ProjectAccessMode;
    maxProjects(user: UserEntitlementInputs, now?: Date): MaxProjects;
    spendThrottle(plan: UserPlan, observation: UserSpendObservation): SpendThrottleState;
    pickInputs(source: Record<string, unknown>): Record<string, unknown>;
    contextFilePolicy(user: UserEntitlementInputs, now?: Date): ContextFilePolicy;
    seedContextTemplateKey(provisionedTier: string): string;
    readonly productProjection?: UserProductProjection;
}
export declare const staticUserEntitlements: UserEntitlementResolver;
export declare function installUserEntitlements(resolver: UserEntitlementResolver): void;
export declare function installDefaultUserEntitlements(): void;
export declare function userEntitlements(): UserEntitlementResolver;
