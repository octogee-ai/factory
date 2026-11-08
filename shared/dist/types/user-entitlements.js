import { exhaustedSpendBudget, } from "./model-broker-usage.js";
const UNMETERED_BUDGET_USD = Number.MAX_SAFE_INTEGER;
const STATIC_SIZING_KEY = "default";
export const staticUserEntitlements = {
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
        if (!exhausted)
            return { degraded: false, blocked: false, reason: null };
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
export function installUserEntitlements(resolver) {
    globalThis[RESOLVER_SLOT] = resolver;
}
export function installDefaultUserEntitlements() {
    globalThis[RESOLVER_SLOT] ??= staticUserEntitlements;
}
export function userEntitlements() {
    const resolver = globalThis[RESOLVER_SLOT];
    if (!resolver)
        throw new Error("User entitlements resolver is not installed");
    return resolver;
}
