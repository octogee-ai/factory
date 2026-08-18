export declare const POD_REPLACEMENT_RECENT_WINDOW_MS: number;
export declare const POD_REPLACEMENT_WARNING_THRESHOLD_24H = 3;
export declare const POD_REPLACEMENT_MAX_RETAINED = 64;
export declare const GATEWAY_POD_REPLACEMENT_SCHEMA: "octogee.gateway-pod-replacement.v1";
export interface GatewayPodPlacement {
    uid: string;
    nodeName: string | null;
    instanceId: string | null;
    nodePool: string | null;
}
export interface GatewayPodReplacements {
    recentAt: number[];
    lastAt: number | null;
    lastVacatedPodUid: string | null;
    lastVacatedNodeName: string | null;
    lastVacatedInstanceId: string | null;
    lastVacatedNodePool: string | null;
    total: number;
}
export interface GatewayPodReplacementSummary {
    count24h: number;
    count7d: number;
    lastAt: number | null;
    lastVacatedPodUid: string | null;
    lastVacatedNodeName: string | null;
    lastVacatedInstanceId: string | null;
    lastVacatedNodePool: string | null;
    total: number;
    warn: boolean;
}
export declare const EMPTY_GATEWAY_POD_REPLACEMENTS: GatewayPodReplacements;
export declare function isGatewayPodReplacements(value: unknown): value is GatewayPodReplacements;
export declare function summarizeGatewayPodReplacements(value: GatewayPodReplacements | null | undefined, now: number): GatewayPodReplacementSummary;
export declare function pruneGatewayPodReplacementWindow(recentAt: readonly number[], now: number): number[];
