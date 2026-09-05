import { createHash } from "node:crypto";
export const GATEWAY_ACCESS_GRANTS_COLLECTION = "gatewayAccessGrants";
export const GATEWAY_ACCESS_AUDIT_COLLECTION = "gatewayAccessAudit";
export const GATEWAY_PERMISSION_SET_IDS = [
    "agent-viewer.v1",
    "trusted-helper.v1",
    "co-owner.v1",
];
export const GATEWAY_PERMISSION_SETS = Object.freeze({
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
function record(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value)
        ? value
        : null;
}
function nonEmptyString(value) {
    return typeof value === "string" && value.length > 0;
}
export function isCanonicalWorkspaceMembership(value) {
    const membership = record(value);
    return membership?.canonicalSource === "mattermost-general" &&
        membership.canonicalState === "active" &&
        nonEmptyString(membership.mattermostChannelId) &&
        nonEmptyString(membership.mattermostUserId);
}
export function isGatewayPermissionSetId(value) {
    return typeof value === "string" &&
        GATEWAY_PERMISSION_SET_IDS.includes(value);
}
export function permissionSetIds(value) {
    if (!Array.isArray(value) || value.length === 0 || value.length > 4)
        return null;
    if (!value.every(isGatewayPermissionSetId))
        return null;
    const unique = [...new Set(value)];
    return unique.length === value.length ? unique : null;
}
export function timestampMillis(value) {
    if (value === null)
        return null;
    if (typeof value === "number" && Number.isFinite(value))
        return value;
    if (value instanceof Date)
        return value.getTime();
    const candidate = record(value);
    if (candidate && typeof candidate.toMillis === "function") {
        const millis = candidate.toMillis();
        return typeof millis === "number" && Number.isFinite(millis) ? millis : undefined;
    }
    if (candidate && typeof candidate.seconds === "number" && Number.isFinite(candidate.seconds)) {
        const nanos = typeof candidate.nanoseconds === "number" ? candidate.nanoseconds : 0;
        return candidate.seconds * 1_000 + nanos / 1_000_000;
    }
    return undefined;
}
function parseGrant(value) {
    const input = record(value);
    if (!input || input.schemaVersion !== 2)
        return null;
    const ids = permissionSetIds(input.permissionSetIds);
    const expiresAt = timestampMillis(input.expiresAt);
    if (!nonEmptyString(input.workspaceSlug) ||
        !nonEmptyString(input.ownerUid) ||
        !nonEmptyString(input.granteeUid) ||
        !ids ||
        (input.state !== "active" && input.state !== "revoked") ||
        !Number.isSafeInteger(input.revision) ||
        input.revision < 1 ||
        expiresAt === undefined)
        return null;
    return {
        workspaceSlug: input.workspaceSlug,
        ownerUid: input.ownerUid,
        granteeUid: input.granteeUid,
        permissionSetIds: ids,
        state: input.state,
        revision: input.revision,
        expiresAt,
    };
}
function delegateProfile(ids) {
    if (ids.includes("co-owner.v1"))
        return "native-co-owner";
    if (ids.includes("trusted-helper.v1"))
        return "delegated-config";
    if (ids.includes("agent-viewer.v1"))
        return "delegated-read";
    return null;
}
function grantMatchesPrincipal(grant, gateway, uid) {
    return grant.workspaceSlug === gateway.workspaceSlug &&
        grant.ownerUid === gateway.ownerUid &&
        grant.granteeUid === uid;
}
function resolveGrantedGatewayPrincipalAccess(input) {
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
    if (grant.state === "revoked")
        return { kind: "denied", reason: "grant_revoked" };
    if (grant.expiresAt !== null && grant.expiresAt <= (input.now ?? Date.now())) {
        return { kind: "denied", reason: "grant_expired" };
    }
    if (!input.isWorkspaceMember)
        return { kind: "denied", reason: "membership_required" };
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
export function resolveGatewayPrincipalAccess(input) {
    const access = resolveGrantedGatewayPrincipalAccess(input);
    if (access.kind === "owner" || !input.gateway.ownerUid || !input.gateway.workspaceSlug ||
        input.gateway.teamAccess !== true || !input.isWorkspaceMember)
        return access;
    if (access.kind === "delegate" && access.permissionSetIds.includes("co-owner.v1"))
        return access;
    if (access.kind === "delegate" && access.permissionSetIds.includes("trusted-helper.v1")) {
        return { ...access, brokerProfile: "native-member-helper" };
    }
    return {
        kind: "member", brokerProfile: "native-member", permissionSetIds: [],
        dashboard: true, config: false, workspaceManagement: false, grantRevision: null, expiresAt: null,
    };
}
export function workspaceAgentAccessGrantId(ownerUid, workspaceSlug, granteeUid) {
    return createHash("sha256")
        .update(ownerUid)
        .update("\0")
        .update(workspaceSlug)
        .update("\0")
        .update(granteeUid)
        .digest("hex");
}
