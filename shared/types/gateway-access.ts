export const GATEWAY_ACCESS_PERMISSION_SET_IDS = [
  "agent-viewer.v1",
  "trusted-helper.v1",
  "co-owner.v1",
  "builder-shell.v1",
] as const;

export type GatewayAccessPermissionSetId =
  (typeof GATEWAY_ACCESS_PERMISSION_SET_IDS)[number];

export type GatewayAccessRole =
  | "owner"
  | "co-owner"
  | "trusted-helper"
  | "agent-viewer"
  | "shell-only";

export interface GatewayAccessCapabilities {
  dashboard: boolean;
  config: boolean;
  shell: boolean;
  workspaceManagement: boolean;
}

export interface GatewayAccessIdentity {
  uid: string;
  displayName: string;
  email: string;
  emailVerified: boolean;
  avatarUrl: string | null;
}

export interface GatewayAccessGrantView {
  gatewayId: string;
  workspaceSlug: string;
  grantee: GatewayAccessIdentity;
  permissionSetIds: GatewayAccessPermissionSetId[];
  labels: string[];
  role: GatewayAccessRole;
  state: "active" | "revoked" | "expired";
  revision: number;
  reason: string;
  expiresAt: string | null;
  capabilities: GatewayAccessCapabilities;
}

export interface GatewayAccessListResponse {
  gatewayId: string;
  workspaceSlug: string;
  owner: boolean;
  grants: GatewayAccessGrantView[];
  eligibleMembers: GatewayAccessIdentity[];
  history: GatewayAccessAuditView[];
}

export interface GatewayAccessAuditView {
  id: string;
  event: "prepared" | "confirmed" | "granted" | "changed" | "revoked" | "expired" | "denied";
  source: "settings" | "agent" | "membership" | "system";
  beforePermissionSetIds: GatewayAccessPermissionSetId[];
  afterPermissionSetIds: GatewayAccessPermissionSetId[];
  beforeRevision: number | null;
  afterRevision: number | null;
  reason: string;
  createdAt: string | null;
}

export interface GatewayAccessMutationResponse {
  grant: GatewayAccessGrantView;
}

export interface GatewayAccessApprovalView {
  id: string;
  operation: "grant" | "change" | "revoke";
  state: "pending" | "confirmed" | "expired" | "cancelled";
  workspaceSlug: string;
  grantee: GatewayAccessIdentity;
  permissionSetIds: GatewayAccessPermissionSetId[];
  labels: string[];
  requestedExpiresAt: string | null;
  approvalExpiresAt: string;
  reason: string;
}
