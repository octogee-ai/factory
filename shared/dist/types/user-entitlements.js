import { exhaustedSpendBudget, } from "./model-broker-usage.js";
const UNMETERED_BUDGET_USD = Number.MAX_SAFE_INTEGER;
const STATIC_SIZING_KEY = "default";
const STATIC_CONTEXT_TEMPLATE_KEY = "default";
export const staticUserEntitlements = {
    plan: () => ({
        modelAccess: "catalog",
        spendWeekUsd: UNMETERED_BUDGET_USD,
        spendWindowUsd: UNMETERED_BUDGET_USD,
        toolAccess: true,
        houseFallback: false,
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
    pickInputs: () => ({}),
    contextFilePolicy: () => ({ templateKey: STATIC_CONTEXT_TEMPLATE_KEY, removedFiles: [] }),
    seedContextTemplateKey: () => STATIC_CONTEXT_TEMPLATE_KEY,
    previousImageFields: () => ({}),
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
