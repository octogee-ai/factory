export declare const POD_REPLACEMENT_RECENT_WINDOW_MS: number;
export declare const POD_REPLACEMENT_WARNING_THRESHOLD_24H = 3;
export declare const POD_REPLACEMENT_MAX_RETAINED = 64;
export interface GatewayPodReplacements {
    recentAt: number[];
    lastAt: number | null;
    lastPodUid: string | null;
    total: number;
}
export interface GatewayPodReplacementSummary {
    count24h: number;
    count7d: number;
    lastAt: number | null;
    lastPodUid: string | null;
    total: number;
    warn: boolean;
}
export declare function isGatewayPodReplacements(value: unknown): value is GatewayPodReplacements;
export declare function summarizeGatewayPodReplacements(value: GatewayPodReplacements | null | undefined, now: number): GatewayPodReplacementSummary;
export declare function pruneGatewayPodReplacementWindow(recentAt: readonly number[], now: number): number[];
