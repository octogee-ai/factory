import { getTierConfig } from "@octogee/shared/types/billing-tiers";
import {
  resolveBillingProfile,
  spendDegradeState,
  spendWindowPercentUsed,
} from "@octogee/shared/types/billing";
import {
  MODEL_BROKER_USAGE_WINDOW_MS,
  MODEL_BROKER_WEEK_WINDOW_MS,
  usageWindowStartMs,
  weekWindowStartMs,
} from "@octogee/shared/types/model-broker-usage";

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

function stringArrayAt(src: CustomerDoc, key: string): string[] {
  const value = src[key];
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function displayNameFor(d: CustomerDoc): string {
  const email = stringAt(d, "email");
  return stringAt(d, "displayName") || stringAt(d, "username") || email.split("@")[0] || "(unknown)";
}

// Per-owner figures from the broker ledger (modelBrokerUsage*) — the only
// source that may render a USD amount on the admin surface. Legacy
// users/{uid}.usage carries openclaw-reported $0 costs and survives as token
// telemetry only.
export interface BrokerCustomerUsage {
  windowCostUsd?: number;
  weekCostUsd?: number;
  totalCostUsd?: number;
  totalTokens?: number;
  now?: number;
}

export interface CustomerSummary {
  uid:                 string;
  displayName:         string;
  email:               string;
  username:            string;
  tier:                string;
  effectiveTier:       string;
  trialDaysRemaining:  number | null;
  subscriptionStatus:  string;
  byotActive:          boolean;
  windowCostUsd:       number;
  windowBudgetUsd:     number;
  weekCostUsd:         number;
  weekBudgetUsd:       number;
  weekPercentUsed:     number;
  weekResetAt:         string | null;
  nextRefillAt:        string | null;
  totalTokensUsed:     number;
  brokerTotalTokens:   number;
  costUsd:             number;
  degraded:            boolean;
  lastActive:          string | null;
  mattermostConnected: boolean;
  mattermostUsername:  string | null;
  agentCount:          number;
  createdAt:           string | null;
  percentUsed:         number;
  revenueUsd:          number;
  marginUsd:           number;

  provisioningStatus:  string | null;
}

export function buildCustomerSummary(
  uid: string,
  d: CustomerDoc,
  broker: BrokerCustomerUsage = {},
): CustomerSummary {
  const subscription = objectAt(d, "subscription");
  const now = broker.now ?? Date.now();
  const plan = resolveBillingProfile(d, new Date(now));
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
    houseFallback: plan.houseFallback,
  }).degraded;
  const agentIds = stringArrayAt(openclaw, "agentIds");
  const revenueUsd: number = isActiveStatus(subscriptionStatus)
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

    provisioningStatus:
      nullableStringAt(openclaw, "status") ??
      nullableStringAt(provisioning, "status"),
  };
}
