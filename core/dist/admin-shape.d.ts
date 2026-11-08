import type { BuilderAccount } from "./builder-account.js";
import type { BuilderRecord } from "./platform-state/builders.js";
export declare function toISODate(val: unknown): string | null;
export declare function isActiveStatus(status: string): boolean;
export declare function isoMillis(value: number | null): string | null;
export interface BrokerCustomerUsage {
    windowCostUsd?: number;
    weekCostUsd?: number;
    totalCostUsd?: number;
    totalTokens?: number;
    now?: number;
}
export interface CustomerSummary {
    uid: string;
    displayName: string;
    email: string;
    username: string;
    tier: string;
    effectiveTier: string;
    trialDaysRemaining: number | null;
    subscriptionStatus: string;
    byotActive: boolean;
    windowCostUsd: number;
    windowBudgetUsd: number;
    weekCostUsd: number;
    weekBudgetUsd: number;
    weekPercentUsed: number;
    weekResetAt: string | null;
    nextRefillAt: string | null;
    totalTokensUsed: number;
    brokerTotalTokens: number;
    costUsd: number;
    degraded: boolean;
    lastActive: string | null;
    mattermostConnected: boolean;
    mattermostUsername: string | null;
    agentCount: number;
    createdAt: string | null;
    percentUsed: number;
    revenueUsd: number;
    marginUsd: number;
    provisioningStatus: string | null;
    accountLifecycleStatus: string;
}
export declare function buildCustomerSummary(builder: BuilderRecord, account: BuilderAccount, broker?: BrokerCustomerUsage): CustomerSummary;
