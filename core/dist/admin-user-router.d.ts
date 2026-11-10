import type { Request, Router } from "express";
import type { ManagedChannelHost } from "./channel-host/types.js";
import type { ManagedGitHost } from "./git-host/types.js";
import type { NormalFleetMutationResult } from "./normal-fleet-mutation.js";
import type { OperationAuditActionClaim } from "./operation-audit.js";
import type { PlatformStateStore } from "./platform-state/store.js";
export interface NewUserAccount {
    userId: string;
    name: string;
    email: string;
}
export type UserAccountCreation = {
    kind: "created";
    userId: string;
} | {
    kind: "taken";
    field: "name" | "email";
};
export interface UserAccounts {
    create(account: NewUserAccount): Promise<UserAccountCreation>;
}
export interface UserSignInHosts {
    channels: Pick<ManagedChannelHost, "setUserPassword">;
    git: Pick<ManagedGitHost, "setUserPassword">;
}
interface JournaledUserMutation<T> {
    req: Request;
    what: string;
    why: string;
    target: Record<string, unknown>;
    preActionStatus: Record<string, unknown>;
    mutation: Record<string, unknown>;
    action: (claim: OperationAuditActionClaim) => Promise<T>;
    classifyResult?: (result: T) => NormalFleetMutationResult;
}
export interface AdminUserRouterDeps {
    store: Pick<PlatformStateStore, "builders" | "workspaces" | "transaction">;
    accounts?: UserAccounts;
    signIn?: UserSignInHosts;
    journal: <T>(input: JournaledUserMutation<T>) => Promise<T>;
}
export declare function addAdminUserRoutes(router: Router, deps: AdminUserRouterDeps): void;
export {};
