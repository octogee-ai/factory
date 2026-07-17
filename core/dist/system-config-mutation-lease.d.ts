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
export interface SystemConfigShellCapabilityReleaseOptions extends SystemConfigShellCapabilityOptions {
    ownerToken: string;
}
export interface SystemConfigShellCapability {
    shellId: string;
    ownerToken: string;
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
};
export type SystemConfigShellCapabilityResult = {
    ok: true;
    created: boolean;
    ownerToken: string;
} | {
    ok: false;
    code: "writer-lock-busy";
};
export declare function systemConfigSyncLockPath(openclawDir: string, lockName?: string): string;
export declare function acquireSystemConfigSyncLeaseSync(options: SystemConfigSyncLeaseOptions): SystemConfigSyncLease | null;
export declare function readSystemConfigShellCapability(openclawDir: string, shellId: string): SystemConfigShellCapability | null;
export declare function activeSystemConfigShellCapabilities(openclawDir: string): SystemConfigShellCapability[];
export declare function activeSystemConfigShellIds(openclawDir: string): string[];
export declare function acquireSystemConfigShellCapabilitySync(options: SystemConfigShellCapabilityOptions): SystemConfigShellCapabilityResult;
export declare function releaseSystemConfigShellCapabilitySync(options: SystemConfigShellCapabilityReleaseOptions): boolean;
export declare function acquireSystemConfigMutationLease(options: SystemConfigSyncLeaseOptions): Promise<SystemConfigMutationLeaseResult>;
