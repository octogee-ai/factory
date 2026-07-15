import { getTierConfig } from "@octogee/shared/types/billing-tiers";
import { resolveEffectivePlan, spendDegradeState, spendWindowPercentUsed, } from "@octogee/shared/types/billing";
import { MODEL_BROKER_USAGE_WINDOW_MS, MODEL_BROKER_WEEK_WINDOW_MS, usageWindowStartMs, weekWindowStartMs, } from "@octogee/shared/types/model-broker-usage";
export function toISODate(val) {
    if (!val)
        return null;
    if (typeof val.toDate === "function") {
        return val.toDate().toISOString();
    }
    if (val instanceof Date)
        return val.toISOString();
    return null;
}
export function isActiveStatus(status) {
    return status === "active" || status === "trialing";
}
function objectAt(src, key) {
    const value = src[key];
    return value && typeof value === "object" ? value : {};
}
function stringAt(src, key, fallback = "") {
    const value = src[key];
    return typeof value === "string" ? value : fallback;
}
function nullableStringAt(src, key) {
    const value = src[key];
    return typeof value === "string" ? value : null;
}
function numberAt(src, key, fallback = 0) {
    const value = src[key];
    return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}
function stringArrayAt(src, key) {
    const value = src[key];
    return Array.isArray(value) ? value.filter((item) => typeof item === "string") : [];
}
function displayNameFor(d) {
    const email = stringAt(d, "email");
    return stringAt(d, "displayName") || stringAt(d, "username") || email.split("@")[0] || "(unknown)";
}
export function buildCustomerSummary(uid, d, broker = {}) {
    const subscription = objectAt(d, "subscription");
    const now = broker.now ?? Date.now();
    const plan = resolveEffectivePlan(d, new Date(now));
    const tierConfig = getTierConfig(plan.tier);
    const subscriptionStatus = stringAt(subscription, "status", "trial");
    const usage = objectAt(d, "usage");
    const provisioning = objectAt(d, "provisioning");
    const openclaw = objectAt(provisioning, "openclaw");
    const mattermost = objectAt(d, "mattermost");
    const windowCostUsd = broker.windowCostUsd ?? 0;
    const weekCostUsd = broker.weekCostUsd ?? 0;
    const costUsd = broker.totalCostUsd ?? 0;
    // Owner-credential (BYOSUB/BYOT) traffic never lands in a spend window, so a
    // percentage against a zero budget would misleadingly read 100% — mirror the
    // customer surfaces and show 0. The broker never throttles them either.
    const onOwnerCredential = d.byotActive === true;
    const degraded = spendDegradeState({
        modelAccess: plan.modelAccess,
        windowCostUsd,
        windowBudgetUsd: plan.windowBudgetUsd,
        weekCostUsd,
        weekBudgetUsd: plan.weeklyBudgetUsd,
        onOwnerCredential,
    }).degraded;
    const agentIds = stringArrayAt(openclaw, "agentIds");
    const revenueUsd = isActiveStatus(subscriptionStatus)
        ? tierConfig.monthlyPrice
        : 0;
    return {
        uid,
        displayName: displayNameFor(d),
        email: stringAt(d, "email"),
        username: stringAt(d, "username"),
        tier: plan.tier,
        effectiveTier: plan.effectiveTier,
        trialDaysRemaining: plan.trialDaysRemaining,
        subscriptionStatus,
        byotActive: d.byotActive === true,
        windowCostUsd,
        windowBudgetUsd: plan.windowBudgetUsd,
        weekCostUsd,
        weekBudgetUsd: plan.weeklyBudgetUsd,
        weekPercentUsed: onOwnerCredential ? 0 : spendWindowPercentUsed(weekCostUsd, plan.weeklyBudgetUsd),
        weekResetAt: new Date(weekWindowStartMs(now) + MODEL_BROKER_WEEK_WINDOW_MS).toISOString(),
        nextRefillAt: new Date(usageWindowStartMs(now) + MODEL_BROKER_USAGE_WINDOW_MS).toISOString(),
        totalTokensUsed: numberAt(usage, "totalTokensUsed", numberAt(usage, "tokensUsed")),
        brokerTotalTokens: broker.totalTokens ?? 0,
        costUsd,
        degraded,
        lastActive: toISODate(usage.lastUpdated),
        mattermostConnected: typeof mattermost.userId === "string" && mattermost.userId.length > 0,
        mattermostUsername: nullableStringAt(mattermost, "username"),
        agentCount: agentIds.length,
        createdAt: toISODate(d.createdAt),
        percentUsed: onOwnerCredential ? 0 : spendWindowPercentUsed(windowCostUsd, plan.windowBudgetUsd),
        revenueUsd,
        marginUsd: revenueUsd - costUsd,
        provisioningStatus: nullableStringAt(openclaw, "status") ??
            nullableStringAt(provisioning, "status"),
    };
}
