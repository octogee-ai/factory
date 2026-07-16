import { type ConfigCache } from "./apply-config-patch.js";
import type { GatewayRpcClient } from "./gateway-rpc.js";
export declare const MIGRATION_ACTIVATION_DIR = ".octogee-migration-activation";
export declare const MIGRATION_ACTIVATION_FILE = "activation.json";
export interface MigrationActivationManifest {
    version: 1;
    slug: string;
    agentId: string;
    accountId: string;
    agent: Record<string, unknown>;
    mattermostAccount: Record<string, unknown>;
    bindings: unknown[];
}
export declare function activationManifestTarPath(slug: string): string;
export declare function extractOpenClawActivationManifest(configPath: string, slug: string, opts?: {
    botToken?: string;
}): Promise<MigrationActivationManifest>;
export declare function writeActivationManifest(rootDir: string, manifest: MigrationActivationManifest): Promise<{
    cwd: string;
    path: string;
}>;
export declare function readActivationManifest(openclawDir: string, slug: string): Promise<MigrationActivationManifest>;
export declare function removeActivationManifest(openclawDir: string, slug: string): Promise<void>;
export declare function applyOpenClawActivationManifest(manifest: MigrationActivationManifest, opts: {
    rpc: GatewayRpcClient;
    cache?: ConfigCache;
    signal?: AbortSignal;
    log: (msg: string) => void;
}): Promise<{
    elapsedMs: number;
}>;
