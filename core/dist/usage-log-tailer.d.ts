import type { FleetBrokerUsageData, FleetBrokerUsageEvent } from "@octogee/shared/types/fleet-broker";
export type LogFn = (msg: string) => void;
export type UsageData = FleetBrokerUsageData;
export type UsageEvent = FleetBrokerUsageEvent & {
    role: string;
    agentDir: string;
    filePath: string;
};
export type UsageEventSink = (event: UsageEvent) => Promise<void>;
export interface UsageEventTailerOptions {
    agentPrefix: string;
    agentsDir: string;
    submit: UsageEventSink;
    log: LogFn;
    gatewayId?: string;
    pollIntervalMs?: number;
}
export declare function extractRole(agentId: string): string;
export declare function parseLineForUsage(line: string): UsageData | null;
export declare function findSessionFiles(agentsDir: string, agentPrefix: string): string[];
export declare function startUsageEventTailer(options: UsageEventTailerOptions): NodeJS.Timeout;
