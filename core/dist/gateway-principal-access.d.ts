import { type UserEntitlementInputs } from "@octogee/shared/types/user-entitlements";
export declare const GATEWAY_ACCESS_AUDIT_COLLECTION = "gatewayAccessAudit";
export interface GatewayPrincipalGateway {
    perUserIdentity?: boolean;
    gatewayId: string;
    ownerUid: string | null;
    workspaceSlug: string | null;
}
export interface ResolvedGatewayAccess {
    kind: "owner" | "member";
    dashboard: boolean;
    workspaceManagement: boolean;
}
export type GatewayAccessDenialReason = "gateway_unowned" | "membership_required" | "identity_required";
export type GatewayPrincipalAccess = ResolvedGatewayAccess | {
    kind: "denied";
    reason: GatewayAccessDenialReason;
};
export declare function isCanonicalWorkspaceMembership(value: unknown): boolean;
export declare function resolveGatewayPrincipalAccess(input: {
    gateway: GatewayPrincipalGateway;
    uid: string;
    membership: unknown;
}): GatewayPrincipalAccess;
export declare function workspacePermissionsEnabled(config: {
    gatewayClass?: string;
    builderAccess?: {
        controlIdentity?: string;
    } | null;
}, owner: UserEntitlementInputs, now?: Date): boolean;
