import { Firestore } from "firebase-admin/firestore";
import { type LogFn, type UsageData } from "./usage-log-tailer.js";
export { extractRole, findSessionFiles, parseLineForUsage } from "./usage-log-tailer.js";
export type { LogFn, UsageData, UsageEvent } from "./usage-log-tailer.js";
export declare function workspaceUsageDocumentIds(model: string, today: string): {
    sessionId: string;
    modelId: string;
    summaryId: string;
};
export interface ReportUsageInput {
    db: Firestore;
    agentId: string;
    role: string;
    agentDir: string;
    usage: UsageData;
    agentToUid: Map<string, string>;
    log: LogFn;
    gatewayId: string;
}
export interface ReportUsageForUidInput {
    db: Firestore;
    uid: string;
    agentId: string;
    role?: string;
    usage: UsageData;
    log: LogFn;
    gatewayId: string;
}
export interface StartUsageTrackingOptions {
    db: Firestore;
    agentPrefix: string;
    agentsDir: string;
    agentToUid: Map<string, string>;
    log: LogFn;
    gatewayId?: string;
}
export declare function reportUsageForUid(input: ReportUsageForUidInput): Promise<void>;
export declare function reportUsage(input: ReportUsageInput): Promise<void>;
export declare function startUsageTracking(options: StartUsageTrackingOptions): NodeJS.Timeout;
