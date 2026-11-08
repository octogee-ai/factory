export declare const MODEL_BROKER_USAGE_EVENTS_COLLECTION = "modelBrokerUsageEvents";
export declare const MODEL_BROKER_USAGE_ROLLUPS_COLLECTION = "modelBrokerUsageRollups";
export declare const MODEL_BROKER_USAGE_WINDOWS_COLLECTION = "modelBrokerUsageWindows";
export declare const MODEL_BROKER_WEEK_WINDOWS_COLLECTION = "modelBrokerWeekWindows";
export declare const MODEL_BROKER_RATE_WINDOWS_COLLECTION = "modelBrokerRateWindows";
export declare const MODEL_BROKER_CREDITS_COLLECTION = "modelBrokerCredits";
export declare const MODEL_BROKER_CREDIT_TOPUPS_COLLECTION = "modelBrokerCreditTopups";
export declare const MODEL_BROKER_TOKENS_COLLECTION = "modelBrokerTokens";
export declare const MODEL_BROKER_GATEWAY_POINTERS_COLLECTION = "modelBrokerGatewayTokens";
export type ModelBrokerCreditTopUpSource = "checkout" | "auto_top_up";
export interface ModelBrokerCreditAutoTopUp {
    enabled: boolean;
    thresholdUsd: number;
    amountUsd: number;
}
export declare const WINDOW_LENGTH_HOURS = 4;
export declare const MODEL_BROKER_USAGE_WINDOW_MS: number;
export declare const MODEL_BROKER_WEEK_WINDOW_MS: number;
export declare const MODEL_BROKER_RATE_WINDOW_MS: number;
export declare function windowOwnerKey(input: {
    ownerUid?: string | null;
    gatewayId: string;
}): string;
export declare function usageWindowStartMs(now: number): number;
export declare function weekWindowStartMs(now: number): number;
export declare function rateWindowStartMs(now: number): number;
export declare function modelBrokerWindowDocId(ownerKey: string, windowStartMs: number): string;
export type ModelAccess = "house_only" | "catalog";
export declare function spendWindowPercentUsed(costUsd: number, budgetUsd: number): number;
export type SpendBudgetWindow = "week" | "window";
export declare function exhaustedSpendBudget(input: {
    windowCostUsd: number;
    windowBudgetUsd: number;
    weekCostUsd: number;
    weekBudgetUsd: number;
}): SpendBudgetWindow | null;
export interface SpendThrottleState {
    degraded: boolean;
    blocked: boolean;
    reason: string | null;
}
