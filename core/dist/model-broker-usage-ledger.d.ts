import pg from "pg";
export type ModelBrokerSpendPeriod = "window" | "week";
export interface ModelBrokerSpendTotals {
    readonly requestCount: number;
    readonly totalTokens: number;
    readonly costUsd: number;
    readonly chargeUsd: number;
}
export interface ModelBrokerUsageLedgerEntry {
    readonly eventId: string;
    readonly ownerKey: string;
    readonly createdAt: number;
    readonly expiresAt: number;
    readonly event: Readonly<Record<string, unknown>>;
    readonly totalTokens: number;
    readonly costUsd: number;
    readonly chargeUsd: number;
    readonly spendPeriods: readonly {
        readonly period: ModelBrokerSpendPeriod;
        readonly startMs: number;
    }[];
}
export interface ModelBrokerUsageLedger {
    record(entry: ModelBrokerUsageLedgerEntry): Promise<boolean>;
    readSpend(ownerKey: string, period: ModelBrokerSpendPeriod, startMs: number): Promise<ModelBrokerSpendTotals>;
    reserveRequest(rateKey: string, startMs: number): Promise<number>;
}
export declare function createPostgresModelBrokerUsageLedger(pool: Pick<pg.Pool, "query">, schema?: string): ModelBrokerUsageLedger;
