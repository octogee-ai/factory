import { exhaustedSpendBudget, } from "./model-broker-usage.js";
const UNMETERED_BUDGET_USD = Number.MAX_SAFE_INTEGER;
const STATIC_SIZING_KEY = "default";
const STATIC_CONTEXT_TEMPLATE_KEY = "default";
export const staticUserEntitlements = {
    policy: () => ({
        modelAccess: "catalog",
        spendWeekUsd: UNMETERED_BUDGET_USD,
        spendWindowUsd: UNMETERED_BUDGET_USD,
        toolAccess: true,
        houseFallback: false,
    }),
    sizingKey: () => STATIC_SIZING_KEY,
    isolatedGatewayAdmission: () => ({
        admitted: false,
        code: "isolated-gateway-operator-grant-required",
        reason: "No admission policy is installed; an operator grants isolated gateways through the Admin API",
    }),
    projectMode: () => "active",
    maxProjects: () => "unlimited",
    spendThrottle: (policy, observation) => {
        const exhausted = observation.onOwnerCredential
            ? null
            : exhaustedSpendBudget({
                windowCostUsd: observation.windowCostUsd,
                windowBudgetUsd: policy.spendWindowUsd,
                weekCostUsd: observation.weekCostUsd,
                weekBudgetUsd: policy.spendWeekUsd,
            });
        if (!exhausted)
            return { degraded: false, blocked: false, reason: null };
        return {
            degraded: policy.houseFallback,
            blocked: !policy.houseFallback,
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
