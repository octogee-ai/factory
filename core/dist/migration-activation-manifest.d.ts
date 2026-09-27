import { type ConfigCache } from "./apply-config-patch.js";
import type { GatewayRpcClient } from "./gateway-rpc.js";
import { type GatewayConfigClass } from "./system-config-invariants.js";
export declare const MIGRATION_ACTIVATION_DIR = ".octogee-migration-activation";
export declare const MIGRATION_ACTIVATION_FILE = "activation.json";
export interface MigrationActivationManifestProjectAgent {
    agentId: string;
    accountId: string;
    agent: Record<string, unknown>;
    mattermostAccount: Record<string, unknown>;
    bindings: unknown[];
}
export interface MigrationActivationManifest {
    version: 2;
    slug: string;
    appliedFingerprint: string;
    agentId: string;
    accountId: string;
    agent: Record<string, unknown>;
    mattermostAccount: Record<string, unknown>;
    bindings: unknown[];
    projectAgents: MigrationActivationManifestProjectAgent[];
}
export declare function activationManifestTarPath(slug: string): string;
export declare function extractOpenClawActivationManifest(configPath: string, slug: string, opts: {
    appliedFingerprint: string;
    botToken?: string;
    resolveBotToken?: (accountId: string) => Promise<string | undefined>;
}): Promise<MigrationActivationManifest>;
/**
 * Every agent id the activation installs. The caller compares it against the
 * target's live roster: residue the manifest does not carry has to leave by
 * `agents.delete` before the patch, because 2026.7.2 refuses a config write
 * that drops roster entries.
 */
export declare function activationManifestAgentIds(manifest: MigrationActivationManifest): string[];
export declare function writeActivationManifest(rootDir: string, manifest: MigrationActivationManifest): Promise<{
    cwd: string;
    path: string;
}>;
export declare function readActivationManifest(openclawDir: string, slug: string): Promise<MigrationActivationManifest>;
export declare function removeActivationManifest(openclawDir: string, slug: string): Promise<void>;
type OwnerCommandsPatch = (current: unknown) => {
    ownerAllowFrom: string[];
} | undefined;
export declare function applyOpenClawActivationManifest(manifest: MigrationActivationManifest, opts: {
    rpc: GatewayRpcClient;
    cache?: ConfigCache;
    signal?: AbortSignal;
    log: (msg: string) => void;
    gatewayClass?: GatewayConfigClass;
    onRoutingActivationRequired?: (accountIds: readonly string[]) => void;
    authInheritanceAnchor?: {
        agentId: string;
        agent: Record<string, unknown>;
    };
    ownerCommandsPatch?: OwnerCommandsPatch;
}): Promise<{
    elapsedMs: number;
    routingActivationRequired: boolean;
    restartExistingAccountIds: string[];
    configNoop: boolean;
}>;
export {};
