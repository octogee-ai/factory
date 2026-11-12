export declare const BROKER_USAGE_SERIES_READ_LIMIT = 20000;
export interface BrokerModelUsage {
    model: string;
    tokens: number;
    costUsd: number;
    calls: number;
    lastUsedAt: number | null;
}
export interface BrokerDateUsage {
    date: string;
    tokens: number;
    costUsd: number;
    calls: number;
}
export interface BrokerUsageSeries {
    models: BrokerModelUsage[];
    sessions: BrokerDateUsage[];
    totalTokens: number;
    totalCostUsd: number;
    totalCalls: number;
    truncated: boolean;
}
export declare function brokerUsageSeries(events: readonly Readonly<Record<string, unknown>>[]): BrokerUsageSeries;
