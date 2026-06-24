import {
  TIERS,
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

type CustomerDoc = Record<string, unknown>;

function objectAt(src: CustomerDoc, key: string): CustomerDoc {
  const value = src[key];
  return value && typeof value === "object" ? value as CustomerDoc : {};
}

function stringAt(src: CustomerDoc, key: string, fallback = ""): string {
  const value = src[key];
  return typeof value === "string" ? value : fallback;
}

function nullableStringAt(src: CustomerDoc, key: string): string | null {
  const value = src[key];
  return typeof value === "string" ? value : null;
}

function numberAt(src: CustomerDoc, key: string, fallback = 0): number {
  const value = src[key];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function tierAt(src: CustomerDoc): TierName {
  const value = src.tier;
  return typeof value === "string" && value in TIERS ? value as TierName : "trial";
}

function stringArrayAt(src: CustomerDoc, key: string): string[] {
  const value = src[key];
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function displayNameFor(d: CustomerDoc): string {
  const email = stringAt(d, "email");
  return stringAt(d, "displayName") || stringAt(d, "username") || email.split("@")[0] || "(unknown)";
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
  d: CustomerDoc,
): CustomerSummary {
  const subscription = objectAt(d, "subscription");
  const tier = tierAt(subscription);
  const tierConfig = getTierConfig(tier);
  const subscriptionStatus = stringAt(subscription, "status", "trial");
  const usage = objectAt(d, "usage");
  const provisioning = objectAt(d, "provisioning");
  const openclaw = objectAt(provisioning, "openclaw");
  const mattermost = objectAt(d, "mattermost");
  const costUsd = numberAt(usage, "costUsd");
  const throttleLevel = numberAt(usage, "throttleLevel");
  const agentIds = stringArrayAt(openclaw, "agentIds");
  const revenueUsd: number = isActiveStatus(subscriptionStatus)
    ? tierConfig.monthlyPrice
    : 0;
  const windowTokensUsed = numberAt(usage, "windowTokensUsed");
  const windowStartedAt = toDateOrNull(usage.windowStartedAt);
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
    displayName: displayNameFor(d),
    email: stringAt(d, "email"),
    username: stringAt(d, "username"),
    tier,
    subscriptionStatus,
    byotActive: d.byotActive === true,
    windowTokensUsed,
    windowSize,
    available,
    nextRefillAt: nextRefillAt?.toISOString() ?? null,
    weeklyBudget: tierConfig.weeklyTokenBudget,
    totalTokensUsed: numberAt(usage, "totalTokensUsed", numberAt(usage, "tokensUsed")),
    costUsd,
    throttleLevel,
    faceModel: nullableStringAt(d, "faceModel"),
    brainModel: nullableStringAt(d, "brainModel"),
    lastActive: toISODate(usage.lastUpdated),
    mattermostConnected: typeof mattermost.userId === "string" && mattermost.userId.length > 0,
    mattermostUsername: nullableStringAt(mattermost, "username"),
    agentCount: agentIds.length,
    createdAt: toISODate(d.createdAt),
    percentUsed,
    revenueUsd,
    marginUsd: revenueUsd - costUsd,
    tokensUsed: windowTokensUsed,
    tokensLimit: windowSize,

    provisioningStatus:
      nullableStringAt(openclaw, "status") ??
      nullableStringAt(provisioning, "status"),
  };
}

function toDateOrNull(value: unknown): Date | null {
  if (value instanceof Date) return value;
  if (value && typeof (value as { toDate?: unknown }).toDate === "function") {
    return (value as { toDate: () => Date }).toDate();
  }
  return null;
}
