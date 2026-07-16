interface ConfigFreezeOwner {
    migrationId: string;
    slug: string;
}
export interface SystemConfigSyncLeaseOptions {
    openclawDir: string;
    lockName?: string;
    heartbeatMs?: number;
    staleAfterMs?: number;
    now?: () => number;
    afterGateAcquired?: () => void;
}
export interface SystemConfigShellCapabilityOptions extends SystemConfigSyncLeaseOptions {
    shellId: string;
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
    code: "shell-active";
    shellIds: string[];
} | {
    ok: false;
    code: "config-frozen";
    freezeOwner: ConfigFreezeOwner;
};
export type SystemConfigShellCapabilityResult = {
    ok: true;
    created: boolean;
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
export declare function activeSystemConfigShellIds(openclawDir: string): string[];
export declare function acquireSystemConfigShellCapabilitySync(options: SystemConfigShellCapabilityOptions): SystemConfigShellCapabilityResult;
export declare function releaseSystemConfigShellCapabilitySync(options: SystemConfigShellCapabilityOptions): boolean;
export declare function acquireSystemConfigControlLeaseSync(options: SystemConfigSyncLeaseOptions): SystemConfigSyncLease | null;
export declare function acquireSystemConfigMutationLease(options: SystemConfigSyncLeaseOptions): Promise<SystemConfigMutationLeaseResult>;
export {};
