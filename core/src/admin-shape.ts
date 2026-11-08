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
import type { BuilderAccount } from "./builder-account.js";
import type { BuilderRecord } from "./platform-state/builders.js";

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

type CustomerDoc = Readonly<Record<string, unknown>>;

function objectAt(src: CustomerDoc, key: string): CustomerDoc {
  const value = src[key];
  return value && typeof value === "object" ? value as CustomerDoc : {};
}

function stringAt(src: CustomerDoc, key: string, fallback = ""): string {
  const value = src[key];
  return typeof value === "string" ? value : fallback;
}

function numberAt(src: CustomerDoc, key: string, fallback = 0): number {
  const value = src[key];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

export function isoMillis(value: number | null): string | null {
  return value === null ? null : new Date(value).toISOString();
}

function displayNameFor(account: BuilderAccount): string {
  return account.displayName || account.username || (account.email ?? "").split("@")[0] || "(unknown)";
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
  accountLifecycleStatus: string;
}

function builderSummaryFields(builder: BuilderRecord) {
  return {
    mattermostConnected: (builder.mattermostUserId ?? "").length > 0,
    agentCount: builder.agents.agentIds.length,
    createdAt: isoMillis(builder.createdAt),
    provisioningStatus: builder.openclaw.status ?? builder.provisioning.status ?? null,
    accountLifecycleStatus: builder.accountLifecycle?.status ?? "active",
  };
}

export function buildCustomerSummary(
  builder: BuilderRecord,
  account: BuilderAccount,
  broker: BrokerCustomerUsage = {},
): CustomerSummary {
  const subscription = objectAt(account.planInputs as CustomerDoc, "subscription");
  const now = broker.now ?? Date.now();
  const plan = resolveBillingProfile(account.planInputs, new Date(now));
  const tierConfig = getTierConfig(plan.tier);
  const subscriptionStatus = stringAt(subscription, "status", "trial");
  const usage = account.usage;
  const windowCostUsd = broker.windowCostUsd ?? 0;
  const weekCostUsd = broker.weekCostUsd ?? 0;
  const costUsd = broker.totalCostUsd ?? 0;
  // Owner-credential (BYOSUB/BYOT) traffic never lands in a spend window, so a
  // percentage against a zero budget would misleadingly read 100% — mirror the
  // customer surfaces and show 0. The broker never throttles them either.
  const onOwnerCredential = account.byotActive;
  const degraded = spendDegradeState({
    modelAccess: plan.modelAccess,
    windowCostUsd,
    windowBudgetUsd: plan.windowBudgetUsd,
    weekCostUsd,
    weekBudgetUsd: plan.weeklyBudgetUsd,
    onOwnerCredential,
    houseFallback: plan.houseFallback,
  }).degraded;
  const revenueUsd: number = isActiveStatus(subscriptionStatus)
    ? tierConfig.monthlyPrice
    : 0;

  return {
    uid: builder.uid,
    displayName: displayNameFor(account),
    email: account.email ?? "",
    username: account.username ?? "",
    tier: plan.tier,
    effectiveTier: plan.effectiveTier,
    trialDaysRemaining: plan.trialDaysRemaining,
    subscriptionStatus,
    byotActive: account.byotActive,
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
    mattermostUsername: account.mattermostUsername,
    percentUsed: onOwnerCredential ? 0 : spendWindowPercentUsed(windowCostUsd, plan.windowBudgetUsd),
    revenueUsd,
    marginUsd: revenueUsd - costUsd,
    ...builderSummaryFields(builder),
  };
}
