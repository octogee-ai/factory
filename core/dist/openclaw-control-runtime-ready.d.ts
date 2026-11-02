import type { GatewayArtifact } from "./gateway-live-release.js";
export declare const OPENCLAW_CONTROL_RUNTIME_FRESH_MS: number;
export declare function isOpenClawControlRevisionRuntimeReady(value: unknown, input: {
    gatewayId: string;
    revisionId: string;
    now?: number;
}): boolean;
export declare function isOpenClawControlServingRevision(root: unknown, runtime: unknown, input: {
    gatewayId: string;
    revisionId: string;
    now?: number;
    readArtifact: (release: number) => Promise<GatewayArtifact | null>;
}): Promise<boolean>;
