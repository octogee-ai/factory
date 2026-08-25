import type { GatewayAccessCapabilities, GatewayAccessPermissionSetId, GatewayAccessRole } from "./gateway-access.js";
export interface GatewayControlListEntry {
    gatewayId: string;
    workspaceSlug: string;
    profile: string;
    gatewayClass?: string;
    imageProfile?: string;
    desiredStatus: string;
    imageTag?: string;
    controlUiEnabled: boolean;
    controlUiReady: boolean;
    isCurrentAssignment: boolean;
    configStatus?: GatewayConfigStatus;
    via: GatewayAccessRole;
    permissionSetIds: GatewayAccessPermissionSetId[];
    capabilities: GatewayAccessCapabilities;
    grantRevision: number | null;
    accessExpiresAt: string | null;
}
export type GatewayConfigState = "clean" | "dirty" | "syncing" | "error" | "unavailable";
export interface GatewayConfigStatus {
    state: GatewayConfigState;
    acceptedCommit?: string;
    lastSyncedAt?: string;
    lastErrorCode?: string;
}
export interface OpenClawControlTicketResponse {
    launchUrl: string;
    expiresAt: number;
}
export interface GatewayControlListResponse {
    gateways: GatewayControlListEntry[];
}
