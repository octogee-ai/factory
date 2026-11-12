import { type ModelAccess, type SpendThrottleState } from "./model-broker-usage.js";
export type UserEntitlementInputs = object;
export type MaxProjects = number | "unlimited";
export type ProjectAccessMode = "active" | "archive_read";
export interface UserPolicy {
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
    agentSupportUser(user: UserEntitlementInputs): ProductFields;
    agentModels(user: UserEntitlementInputs): ProductFields;
    adminUserSummary(user: UserEntitlementInputs, usage: {
        costUsd: number;
        now: Date;
    }): ProductFields;
    adminUserDetail(user: UserEntitlementInputs): ProductFields;
    adminUserStats(summaries: readonly ProductFields[]): ProductFields;
    adminUserArchive(record: Readonly<Record<string, unknown>>): ProductFields;
    provisionedUser(user: UserEntitlementInputs): ProductFields;
}
export interface UserSpendObservation {
    windowCostUsd: number;
    weekCostUsd: number;
    onOwnerCredential: boolean;
    creditBalanceUsd?: number | null;
}
export type PreviousImageWire = "user-snapshot" | "restore-snapshot" | "model-pick-push" | "model-credential-push";
export type IsolatedGatewayAdmission = {
    readonly admitted: true;
    readonly sizingKey: string;
} | {
    readonly admitted: false;
    readonly code: string;
    readonly reason: string;
};
export interface UserEntitlementResolver {
    policy(user: UserEntitlementInputs, now?: Date): UserPolicy;
    sizingKey(user: UserEntitlementInputs, now?: Date): string | null;
    isolatedGatewayAdmission(user: UserEntitlementInputs, now?: Date): IsolatedGatewayAdmission;
    projectMode(user: UserEntitlementInputs, now?: Date): ProjectAccessMode;
    maxProjects(user: UserEntitlementInputs, now?: Date): MaxProjects;
    spendThrottle(policy: UserPolicy, observation: UserSpendObservation): SpendThrottleState;
    pickInputs(source: Record<string, unknown>): Record<string, unknown>;
    contextFilePolicy(user: UserEntitlementInputs, now?: Date): ContextFilePolicy;
    seedContextTemplateKey(user: UserEntitlementInputs): string;
    previousImageFields(wire: PreviousImageWire, source: Record<string, unknown>): Record<string, unknown>;
    readonly productProjection?: UserProductProjection;
}
export declare const staticUserEntitlements: UserEntitlementResolver;
export declare function installUserEntitlements(resolver: UserEntitlementResolver): void;
export declare function installDefaultUserEntitlements(): void;
export declare function userEntitlements(): UserEntitlementResolver;
