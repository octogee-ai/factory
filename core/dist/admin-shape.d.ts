export declare function toISODate(val: unknown): string | null;
export declare function isActiveStatus(status: string): boolean;
type CustomerDoc = Record<string, unknown>;
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
}
export declare function buildCustomerSummary(uid: string, d: CustomerDoc, broker?: BrokerCustomerUsage): CustomerSummary;
export {};
