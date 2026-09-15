export type GatewayAccessRole = "owner" | "member";
export interface GatewayAccessCapabilities {
    dashboard: boolean;
    workspaceManagement: boolean;
}
