import { type ModelAccess, type SpendThrottleState } from "./model-broker-usage.js";
import type { OwnedSignupOfferBudget } from "./signup-offer.js";
export type UserEntitlementInputs = object;
export type MaxProjects = number | "unlimited";
export type ProjectAccessMode = "active" | "archive_read";
export type ContextTemplate = "trial" | "free" | "paid";
export interface UserPlan {
    planId: string;
    activePlanId: string;
    dedicatedPlanId: string | null;
    modelAccess: ModelAccess;
    spendWeekUsd: number;
    spendWindowUsd: number;
    introductoryDaysRemaining: number | null;
    toolAccess: boolean;
    houseFallback: boolean;
    contextTemplate: ContextTemplate;
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
    monthlyPriceUsd(planId: string): number;
    pickInputs(source: Record<string, unknown>): Record<string, unknown>;
    ownedPromotionBudget(user: UserEntitlementInputs, ownerUid: string, now?: Date): OwnedSignupOfferBudget | null;
}
export declare const staticUserEntitlements: UserEntitlementResolver;
export declare function installUserEntitlements(resolver: UserEntitlementResolver): void;
export declare function installDefaultUserEntitlements(): void;
export declare function userEntitlements(): UserEntitlementResolver;
