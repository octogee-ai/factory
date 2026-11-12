import { Router } from "express";
import { type Firestore } from "firebase-admin/firestore";
import type { PlatformUserRecord } from "./platform-state/users.js";
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
export interface UserDirectoryRouterLogger {
    info: (msg: string, meta?: Record<string, unknown>) => void;
    warn: (msg: string, meta?: Record<string, unknown>) => void;
}
export type AdminUserProductDetail = (uid: string) => Promise<Readonly<Record<string, unknown>>>;
export interface AdminUserDirectoryRouterDeps {
    db: Firestore;
    store: PlatformStateStore;
    FieldValue: {
        serverTimestamp: () => unknown;
    };
    logger: UserDirectoryRouterLogger;
    productUserDetail?: AdminUserProductDetail | undefined;
}
export interface AdminUserPlacementProjection {
    managedBy: "cowboy" | "operator";
    gatewayId: string | null;
    gatewayProfile: string | null;
}
export declare function projectUserPlacement(userRecord: PlatformUserRecord): AdminUserPlacementProjection;
export declare function addAdminUserDirectoryRoutes(router: Router, deps: AdminUserDirectoryRouterDeps): Router;
