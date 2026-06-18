import {
  getTierConfig,
  calculateAvailableTokens,
  type TierName,
} from "../../shared/types/billing-tiers.js";

export function toISODate(val: unknown): string | null {
  if (!val) return null;
  if (typeof (val as { toDate?: unknown }).toDate === "function") {
    return (val as { toDate: () => Date }).toDate().toISOString();
  }
  if (val instanceof Date) return val.toISOString();
  return null;
}

export function isActiveStatus(status: string): boolean {
  return status === "active" || status === "trialing";
}

export interface CustomerSummary {
  uid:                 string;
  displayName:         string;
  email:               string;
  username:            string;
  tier:                string;
  subscriptionStatus:  string;
  byotActive:          boolean;
  windowTokensUsed:    number;
  windowSize:          number;
  available:           number;
  nextRefillAt:        string | null;
  weeklyBudget:        number;
  totalTokensUsed:     number;
  costUsd:             number;
  throttleLevel:       number;
  faceModel:           string | null;
  brainModel:          string | null;
  lastActive:          string | null;
  mattermostConnected: boolean;
  mattermostUsername:  string | null;
  agentCount:          number;
  createdAt:           string | null;
  percentUsed:         number;
  revenueUsd:          number;
  marginUsd:           number;

  tokensUsed:          number;
  tokensLimit:         number;

  provisioningStatus:  string | null;
}

export function buildCustomerSummary(
  uid: string,
  d: Record<string, any>,
): CustomerSummary {
  const subscription = d.subscription ?? {};
  const tier: TierName = subscription.tier ?? "trial";
  const tierConfig = getTierConfig(tier);
  const subscriptionStatus: string = subscription.status ?? "trial";
  const usage = d.usage ?? {};
  const costUsd: number = usage.costUsd ?? 0;
  const throttleLevel: number = usage.throttleLevel ?? 0;
  const agentIds: string[] = d.provisioning?.openclaw?.agentIds ?? [];
  const revenueUsd: number = isActiveStatus(subscriptionStatus)
    ? tierConfig.monthlyPrice
    : 0;
  const windowTokensUsed = usage.windowTokensUsed ?? 0;
  const windowStartedAt = usage.windowStartedAt?.toDate?.() ?? null;
  const { available, windowSize, nextRefillAt } = calculateAvailableTokens(
    tier,
    windowTokensUsed,
    windowStartedAt,
  );
  const percentUsed = windowSize > 0
    ? Math.min(100, Math.round((windowTokensUsed / windowSize) * 100))
    : 0;

  return {
    uid,
    displayName:
      d.displayName ?? d.username ?? d.email?.split("@")[0] ?? "(unknown)",
    email: d.email ?? "",
    username: d.username ?? "",
    tier,
    subscriptionStatus,
    byotActive: d.byotActive === true,
    windowTokensUsed,
    windowSize,
    available,
    nextRefillAt: nextRefillAt?.toISOString() ?? null,
    weeklyBudget: tierConfig.weeklyTokenBudget,
    totalTokensUsed: usage.totalTokensUsed ?? usage.tokensUsed ?? 0,
    costUsd,
    throttleLevel,
    faceModel: d.faceModel ?? null,
    brainModel: d.brainModel ?? null,
    lastActive: toISODate(usage.lastUpdated),
    mattermostConnected: !!d.mattermost?.userId,
    mattermostUsername: d.mattermost?.username ?? null,
    agentCount: agentIds.length,
    createdAt: toISODate(d.createdAt),
    percentUsed,
    revenueUsd,
    marginUsd: revenueUsd - costUsd,
    tokensUsed: windowTokensUsed,
    tokensLimit: windowSize,

    provisioningStatus:
      d.provisioning?.openclaw?.status ??
      d.provisioning?.status ??
      null,
  };
}
