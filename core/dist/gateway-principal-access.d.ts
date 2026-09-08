export declare const GATEWAY_ACCESS_GRANTS_COLLECTION = "gatewayAccessGrants";
export declare const GATEWAY_ACCESS_AUDIT_COLLECTION = "gatewayAccessAudit";
export declare const GATEWAY_PERMISSION_SET_IDS: readonly ["agent-viewer.v1", "trusted-helper.v1", "co-owner.v1"];
export type GatewayPermissionSetId = (typeof GATEWAY_PERMISSION_SET_IDS)[number];
export type OpenClawBrokerProfile = "native-owner" | "native-member" | "native-member-helper" | "native-co-owner" | "delegated-config" | "delegated-read";
export declare function hasNativeOpenClawChatAccess(profile: OpenClawBrokerProfile): boolean;
export interface GatewayPermissionSetDefinition {
    label: string;
    purpose: string;
    can: readonly string[];
    cannot: readonly string[];
}
export declare const GATEWAY_PERMISSION_SETS: Readonly<Record<GatewayPermissionSetId, GatewayPermissionSetDefinition>>;
export interface GatewayPrincipalGateway {
    teamAccess?: boolean;
    gatewayId: string;
    ownerUid: string | null;
    workspaceSlug: string | null;
}
export interface ResolvedGatewayAccess {
    kind: "owner" | "delegate" | "member";
    permissionSetIds: GatewayPermissionSetId[];
    brokerProfile: OpenClawBrokerProfile | null;
    dashboard: boolean;
    config: boolean;
    workspaceManagement: boolean;
    grantRevision: number | null;
    expiresAt: number | null;
}
export type GatewayAccessDenialReason = "gateway_unowned" | "grant_missing" | "grant_invalid" | "grant_revoked" | "grant_expired" | "membership_required";
export type GatewayPrincipalAccess = ResolvedGatewayAccess | {
    kind: "denied";
    reason: GatewayAccessDenialReason;
};
export declare function isCanonicalWorkspaceMembership(value: unknown): boolean;
export declare function isGatewayPermissionSetId(value: unknown): value is GatewayPermissionSetId;
export declare function permissionSetIds(value: unknown): GatewayPermissionSetId[] | null;
export declare function timestampMillis(value: unknown): number | null | undefined;
declare function resolveGrantedGatewayPrincipalAccess(input: {
    gateway: GatewayPrincipalGateway;
    uid: string;
    grant: unknown;
    isWorkspaceMember: boolean;
    now?: number;
}): GatewayPrincipalAccess;
export declare function resolveGatewayPrincipalAccess(input: Parameters<typeof resolveGrantedGatewayPrincipalAccess>[0]): GatewayPrincipalAccess;
export declare function workspaceAgentAccessGrantId(ownerUid: string, workspaceSlug: string, granteeUid: string): string;
export {};
