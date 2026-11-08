import { Router } from "express";
import { type Firestore } from "firebase-admin/firestore";
import type { BuilderRecord } from "./platform-state/builders.js";
import type { PlatformStateStore } from "./platform-state/store.js";
export interface BrokerDailyUsage {
    date: string;
    costUsd: number;
    totalTokens: number;
    requestCount: number;
}
export interface BrokerDiagnostics {
    windows: Array<{
        windowStartMs: number;
        totalTokens: number;
        requestCount: number;
        costUsd: number;
    }>;
    days: Array<{
        date: string;
        model: string;
        totalTokens: number;
        requestCount: number;
        costUsd: number;
        cacheWriteUsd: number;
    }>;
    decomposition: {
        input: number;
        output: number;
        cacheRead: number;
        cacheWrite: number;
    };
    recentCalls: Array<{
        at: number;
        model: string;
        inputTokens: number;
        outputTokens: number;
        cacheWriteTokens: number;
        cacheReadTokens: number;
        costUsd: number;
        degraded: boolean;
        brokerTokenSecretName: string | null;
    }>;
}
export declare function aggregateBrokerDiagnostics(events: Array<Record<string, unknown>>, recentLimit?: number): Pick<BrokerDiagnostics, "days" | "decomposition" | "recentCalls">;
export declare function mergeDailyUsage(legacyLogs: Array<Record<string, unknown>>, brokerDaily: Map<string, BrokerDailyUsage>): Array<Record<string, unknown>>;
export interface CustomerRouterLogger {
    info: (msg: string, meta?: Record<string, unknown>) => void;
    warn: (msg: string, meta?: Record<string, unknown>) => void;
}
export interface AdminCustomerRouterDeps {
    db: Firestore;
    store: PlatformStateStore;
    FieldValue: {
        serverTimestamp: () => unknown;
    };
    logger: CustomerRouterLogger;
}
export interface AdminCustomerPlacementProjection {
    managedBy: "cowboy" | "operator";
    gatewayId: string | null;
    gatewayProfile: string | null;
}
export declare function projectCustomerPlacement(builder: BuilderRecord): AdminCustomerPlacementProjection;
export declare function addAdminCustomerRoutes(router: Router, deps: AdminCustomerRouterDeps): Router;
