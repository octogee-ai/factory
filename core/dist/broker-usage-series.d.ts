import type { Firestore } from "firebase-admin/firestore";
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
export declare function readOwnerBrokerUsageSeries(db: Pick<Firestore, "collection">, ownerUid: string, cutoffMs: number, logger?: {
    warn: (msg: string, meta?: Record<string, unknown>) => void;
}): Promise<BrokerUsageSeries>;
