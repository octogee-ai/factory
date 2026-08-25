import { createHash } from "node:crypto";

export const GATEWAY_ACCESS_GRANTS_COLLECTION = "gatewayAccessGrants";
export const GATEWAY_ACCESS_AUDIT_COLLECTION = "gatewayAccessAudit";

export const GATEWAY_PERMISSION_SET_IDS = [
  "agent-viewer.v1",
  "trusted-helper.v1",
  "co-owner.v1",
] as const;

export type GatewayPermissionSetId = (typeof GATEWAY_PERMISSION_SET_IDS)[number];
export type OpenClawBrokerProfile =
  | "native-owner"
  | "native-co-owner"
  | "delegated-config"
  | "delegated-read";

export interface GatewayPermissionSetDefinition {
  label: string;
  purpose: string;
  can: readonly string[];
  cannot: readonly string[];
}

export const GATEWAY_PERMISSION_SETS: Readonly<
  Record<GatewayPermissionSetId, GatewayPermissionSetDefinition>
> = Object.freeze({
  "agent-viewer.v1": Object.freeze({
    label: "Agent viewer",
    purpose: "Check agent health and non-secret settings.",
    can: Object.freeze([
      "Check health and runtime status",
      "Review non-secret settings",
      "See connection readiness",
    ]),
    cannot: Object.freeze([
      "Change settings",
      "Read private conversations or secrets",
    ]),
  }),
  "trusted-helper.v1": Object.freeze({
    label: "Trusted Helper",
    purpose: "Help care for your agent.",
    can: Object.freeze([
      "Check health",
      "Update safe agent settings",
      "Help start connection setup",
    ]),
    cannot: Object.freeze([
      "See passwords or tokens",
      "Approve personal account access",
      "Manage billing or give access",
    ]),
  }),
  "co-owner.v1": Object.freeze({
    label: "Co-owner",
    purpose: "Operate the OpenClaw Dashboard with you.",
    can: Object.freeze([
      "Use the full OpenClaw Dashboard",
      "Manage ordinary workspace settings",
    ]),
    cannot: Object.freeze([
      "Manage billing or ownership",
      "Give or remove Agent access",
    ]),
  }),
});

export interface GatewayPrincipalGateway {
  gatewayId: string;
  ownerUid: string | null;
  workspaceSlug: string | null;
}

export interface ResolvedGatewayAccess {
  kind: "owner" | "delegate";
  permissionSetIds: GatewayPermissionSetId[];
  brokerProfile: OpenClawBrokerProfile | null;
  dashboard: boolean;
  config: boolean;
  workspaceManagement: boolean;
  grantRevision: number | null;
  expiresAt: number | null;
}

export type GatewayAccessDenialReason =
  | "gateway_unowned"
  | "grant_missing"
  | "grant_invalid"
  | "grant_revoked"
  | "grant_expired"
  | "membership_required";

export type GatewayPrincipalAccess =
  | ResolvedGatewayAccess
  | { kind: "denied"; reason: GatewayAccessDenialReason };

interface ParsedGrant {
  gatewayId: string;
  workspaceSlug: string;
  ownerUid: string;
  granteeUid: string;
  permissionSetIds: GatewayPermissionSetId[];
  state: "active" | "revoked";
  revision: number;
  expiresAt: number | null;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

export function isCanonicalWorkspaceMembership(value: unknown): boolean {
  const membership = record(value);
  return membership?.canonicalSource === "mattermost-general" &&
    membership.canonicalState === "active" &&
    nonEmptyString(membership.mattermostChannelId) &&
    nonEmptyString(membership.mattermostUserId);
}

export function isGatewayPermissionSetId(value: unknown): value is GatewayPermissionSetId {
  return typeof value === "string" &&
    (GATEWAY_PERMISSION_SET_IDS as readonly string[]).includes(value);
}

export function permissionSetIds(value: unknown): GatewayPermissionSetId[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > 4) return null;
  if (!value.every(isGatewayPermissionSetId)) return null;
  const unique = [...new Set(value)];
  return unique.length === value.length ? unique : null;
}

export function timestampMillis(value: unknown): number | null | undefined {
  if (value === null) return null;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (value instanceof Date) return value.getTime();
  const candidate = record(value);
  if (candidate && typeof candidate.toMillis === "function") {
    const millis = (candidate.toMillis as () => unknown)();
    return typeof millis === "number" && Number.isFinite(millis) ? millis : undefined;
  }
  if (candidate && typeof candidate.seconds === "number" && Number.isFinite(candidate.seconds)) {
    const nanos = typeof candidate.nanoseconds === "number" ? candidate.nanoseconds : 0;
    return candidate.seconds * 1_000 + nanos / 1_000_000;
  }
  return undefined;
}

function parseGrant(value: unknown): ParsedGrant | null {
  const input = record(value);
  if (!input || input.schemaVersion !== 1) return null;
  const ids = permissionSetIds(input.permissionSetIds);
  const expiresAt = timestampMillis(input.expiresAt);
  if (
    !nonEmptyString(input.gatewayId) ||
    !nonEmptyString(input.workspaceSlug) ||
    !nonEmptyString(input.ownerUid) ||
    !nonEmptyString(input.granteeUid) ||
    !ids ||
    (input.state !== "active" && input.state !== "revoked") ||
    !Number.isSafeInteger(input.revision) ||
    (input.revision as number) < 1 ||
    expiresAt === undefined
  ) return null;
  return {
    gatewayId: input.gatewayId,
    workspaceSlug: input.workspaceSlug,
    ownerUid: input.ownerUid,
    granteeUid: input.granteeUid,
    permissionSetIds: ids,
    state: input.state,
    revision: input.revision as number,
    expiresAt,
  };
}

function delegateProfile(ids: readonly GatewayPermissionSetId[]): OpenClawBrokerProfile | null {
  if (ids.includes("co-owner.v1")) return "native-co-owner";
  if (ids.includes("trusted-helper.v1")) return "delegated-config";
  if (ids.includes("agent-viewer.v1")) return "delegated-read";
  return null;
}

function grantMatchesPrincipal(
  grant: ParsedGrant,
  gateway: GatewayPrincipalGateway,
  uid: string,
): boolean {
  return grant.gatewayId === gateway.gatewayId &&
    grant.workspaceSlug === gateway.workspaceSlug &&
    grant.ownerUid === gateway.ownerUid &&
    grant.granteeUid === uid;
}

export function resolveGatewayPrincipalAccess(input: {
  gateway: GatewayPrincipalGateway;
  uid: string;
  grant: unknown;
  isWorkspaceMember: boolean;
  now?: number;
}): GatewayPrincipalAccess {
  if (!input.gateway.ownerUid || !input.gateway.workspaceSlug) {
    return { kind: "denied", reason: "gateway_unowned" };
  }
  if (input.gateway.ownerUid === input.uid) {
    return {
      kind: "owner",
      permissionSetIds: [],
      brokerProfile: "native-owner",
      dashboard: true,
      config: true,
      workspaceManagement: true,
      grantRevision: null,
      expiresAt: null,
    };
  }
  if (input.grant === null || input.grant === undefined) {
    return { kind: "denied", reason: "grant_missing" };
  }
  const grant = parseGrant(input.grant);
  if (!grant || !grantMatchesPrincipal(grant, input.gateway, input.uid)) {
    return { kind: "denied", reason: "grant_invalid" };
  }
  if (grant.state === "revoked") return { kind: "denied", reason: "grant_revoked" };
  if (grant.expiresAt !== null && grant.expiresAt <= (input.now ?? Date.now())) {
    return { kind: "denied", reason: "grant_expired" };
  }
  if (!input.isWorkspaceMember) return { kind: "denied", reason: "membership_required" };
  const brokerProfile = delegateProfile(grant.permissionSetIds);
  return {
    kind: "delegate",
    permissionSetIds: grant.permissionSetIds,
    brokerProfile,
    dashboard: brokerProfile !== null,
    config: brokerProfile === "delegated-config" || brokerProfile === "native-co-owner",
    workspaceManagement: grant.permissionSetIds.includes("co-owner.v1"),
    grantRevision: grant.revision,
    expiresAt: grant.expiresAt,
  };
}

export function gatewayAccessGrantId(
  gatewayId: string,
  workspaceSlug: string,
  granteeUid: string,
): string {
  return createHash("sha256")
    .update(gatewayId)
    .update("\0")
    .update(workspaceSlug)
    .update("\0")
    .update(granteeUid)
    .digest("hex");
}
