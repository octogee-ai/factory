import type { ConfigFreezeOwner } from "@octogee/shared/types/fleet-controller";
export interface SystemConfigSyncLeaseOptions {
    openclawDir: string;
    lockName?: string;
    heartbeatMs?: number;
    staleAfterMs?: number;
    now?: () => number;
}
export interface SystemConfigSyncLease {
    ownerToken: string;
    release(): void;
}
export interface SystemConfigMutationLease {
    ownerToken: string;
    release(): Promise<void>;
}
export type SystemConfigMutationLeaseResult = {
    ok: true;
    lease: SystemConfigMutationLease;
} | {
    ok: false;
    code: "writer-lock-busy";
} | {
    ok: false;
    code: "config-frozen";
    freezeOwner: ConfigFreezeOwner;
};
export declare function systemConfigSyncLockPath(openclawDir: string, lockName?: string): string;
export declare function acquireSystemConfigSyncLeaseSync(options: SystemConfigSyncLeaseOptions): SystemConfigSyncLease | null;
export declare function acquireSystemConfigMutationLease(options: SystemConfigSyncLeaseOptions): Promise<SystemConfigMutationLeaseResult>;
