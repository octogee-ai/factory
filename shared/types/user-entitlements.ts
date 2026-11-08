import {
  exhaustedSpendBudget,
  type ModelAccess,
  type SpendThrottleState,
} from "./model-broker-usage.js";
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
  ownedPromotionBudget(
    user: UserEntitlementInputs,
    ownerUid: string,
    now?: Date,
  ): OwnedSignupOfferBudget | null;
}

const UNMETERED_BUDGET_USD = Number.MAX_SAFE_INTEGER;
const STATIC_SIZING_KEY = "default";

export const staticUserEntitlements: UserEntitlementResolver = {
  plan: () => ({
    planId: "operator",
    activePlanId: "operator",
    dedicatedPlanId: STATIC_SIZING_KEY,
    modelAccess: "catalog",
    spendWeekUsd: UNMETERED_BUDGET_USD,
    spendWindowUsd: UNMETERED_BUDGET_USD,
    introductoryDaysRemaining: null,
    toolAccess: true,
    houseFallback: false,
    contextTemplate: "paid",
  }),
  sizingKey: () => STATIC_SIZING_KEY,
  projectMode: () => "active",
  maxProjects: () => "unlimited",
  spendThrottle: (plan, observation) => {
    const exhausted = observation.onOwnerCredential
      ? null
      : exhaustedSpendBudget({
          windowCostUsd: observation.windowCostUsd,
          windowBudgetUsd: plan.spendWindowUsd,
          weekCostUsd: observation.weekCostUsd,
          weekBudgetUsd: plan.spendWeekUsd,
        });
    if (!exhausted) return { degraded: false, blocked: false, reason: null };
    return {
      degraded: plan.houseFallback,
      blocked: !plan.houseFallback,
      reason: `${exhausted}_exhausted`,
    };
  },
  monthlyPriceUsd: () => 0,
  pickInputs: () => ({}),
  ownedPromotionBudget: () => null,
};

const RESOLVER_SLOT = Symbol.for("octogee.userEntitlements");
type ResolverHost = typeof globalThis & { [RESOLVER_SLOT]?: UserEntitlementResolver };

export function installUserEntitlements(resolver: UserEntitlementResolver): void {
  (globalThis as ResolverHost)[RESOLVER_SLOT] = resolver;
}

export function installDefaultUserEntitlements(): void {
  (globalThis as ResolverHost)[RESOLVER_SLOT] ??= staticUserEntitlements;
}

export function userEntitlements(): UserEntitlementResolver {
  const resolver = (globalThis as ResolverHost)[RESOLVER_SLOT];
  if (!resolver) throw new Error("User entitlements resolver is not installed");
  return resolver;
}
