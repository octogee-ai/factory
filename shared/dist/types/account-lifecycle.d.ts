export declare const ACCOUNT_DELETION_RETENTION_MS: number;
export type AccountLifecycleStatus = "active" | "suspended" | "deletion_scheduled" | "erasing";
export interface AccountLifecycle {
    status: AccountLifecycleStatus;
    deletionId?: string;
    suspendedAt?: number;
    eraseAfter?: number;
}
export declare const USER_DELETION_JOBS_COLLECTION = "customerDeletionJobs";
export declare const ANONYMOUS_OPERATIONAL_ARCHIVES_COLLECTION = "anonymousOperationalArchives";
export declare function isAnonymousOperationalModelDimension(provider: unknown, model: unknown): boolean;
export declare function anonymousOperationalEnvironment(value: unknown): string;
export declare function anonymousOperationalPlanTier(value: unknown): string | null;
export declare function anonymousOperationalGatewayClass(value: unknown): string | null;
export declare function accountAllowsInteractiveAccess(userData: Record<string, unknown> | undefined): boolean;
export declare function buildUserDeletionSchedule(input: {
    now: number;
    eraseNow: boolean;
}): {
    requestedAt: number;
    eraseAfter: number;
};
