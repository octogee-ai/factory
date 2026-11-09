import { userEntitlements } from "@octogee/shared/types/user-entitlements";
import { MODEL_BROKER_USAGE_WINDOW_MS, MODEL_BROKER_WEEK_WINDOW_MS, spendWindowPercentUsed, usageWindowStartMs, weekWindowStartMs, } from "@octogee/shared/types/model-broker-usage";
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
function numberAt(src, key, fallback = 0) {
    const value = src[key];
    return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}
export function isoMillis(value) {
    return value === null ? null : new Date(value).toISOString();
}
function displayNameFor(account) {
    return account.displayName || account.username || (account.email ?? "").split("@")[0] || "(unknown)";
}
function builderSummaryFields(builder) {
    return {
        mattermostConnected: (builder.mattermostUserId ?? "").length > 0,
        agentCount: builder.agents.agentIds.length,
        createdAt: isoMillis(builder.createdAt),
        provisioningStatus: builder.openclaw.status ?? builder.provisioning.status ?? null,
        accountLifecycleStatus: builder.accountLifecycle?.status ?? "active",
    };
}
export function buildCustomerSummary(builder, account, broker = {}) {
    const now = broker.now ?? Date.now();
    const plan = userEntitlements().plan(account.planInputs, new Date(now));
    const usage = account.usage;
    const windowCostUsd = broker.windowCostUsd ?? 0;
    const weekCostUsd = broker.weekCostUsd ?? 0;
    const costUsd = broker.totalCostUsd ?? 0;
    // Owner-credential (BYOSUB/BYOT) traffic never lands in a spend window, so a
    // percentage against a zero budget would misleadingly read 100% — mirror the
    // customer surfaces and show 0. The broker never throttles them either.
    const onOwnerCredential = account.byotActive;
    const degraded = userEntitlements().spendThrottle(plan, {
        windowCostUsd,
        weekCostUsd,
        onOwnerCredential,
    }).degraded;
    return {
        ...userEntitlements().productProjection?.adminCustomerSummary(account.planInputs, {
            costUsd,
            now: new Date(now),
        }),
        uid: builder.uid,
        displayName: displayNameFor(account),
        email: account.email ?? "",
        username: account.username ?? "",
        byotActive: account.byotActive,
        windowCostUsd,
        windowBudgetUsd: plan.spendWindowUsd,
        weekCostUsd,
        weekBudgetUsd: plan.spendWeekUsd,
        weekPercentUsed: onOwnerCredential ? 0 : spendWindowPercentUsed(weekCostUsd, plan.spendWeekUsd),
        weekResetAt: new Date(weekWindowStartMs(now) + MODEL_BROKER_WEEK_WINDOW_MS).toISOString(),
        nextRefillAt: new Date(usageWindowStartMs(now) + MODEL_BROKER_USAGE_WINDOW_MS).toISOString(),
        totalTokensUsed: numberAt(usage, "totalTokensUsed", numberAt(usage, "tokensUsed")),
        brokerTotalTokens: broker.totalTokens ?? 0,
        costUsd,
        degraded,
        lastActive: toISODate(usage.lastUpdated),
        mattermostUsername: account.mattermostUsername,
        percentUsed: onOwnerCredential ? 0 : spendWindowPercentUsed(windowCostUsd, plan.spendWindowUsd),
        ...builderSummaryFields(builder),
    };
}
