import type { NextFunction, Request, Response } from "express";
export declare const ADMIN_API_CAPABILITIES_HEADER = "Admin-Api-Capabilities";
export declare const ADMIN_API_DRY_RUN_CAPABILITY = "dry-run";
export interface AdminMutationPlan {
    what: string;
    why: string;
    kind: string | null;
    target: Record<string, unknown>;
    preActionStatus: Record<string, unknown>;
    mutation: Record<string, unknown>;
    forced: boolean;
}
export interface AdminMutationIntent {
    what: string;
    why: string;
    target: Record<string, unknown>;
    preActionStatus: Record<string, unknown>;
    mutation: Record<string, unknown>;
    forced?: boolean;
}
export declare class AdminDryRunPlanned extends Error {
    readonly plan: AdminMutationPlan;
    constructor(intent: AdminMutationIntent);
}
export declare function isAdminDryRun(req: Request): boolean;
export declare function adminDryRunBody(plans: readonly AdminMutationPlan[], context?: Record<string, unknown>): Record<string, unknown>;
export declare function admitAdminDryRunMarker(req: Request, res: Response, next: NextFunction): void;
export declare function refuseUnansweredAdminDryRun(req: Request, res: Response, next: NextFunction): void;
export declare function respondToAdminDryRun(error: unknown, res: Response): boolean;
