import { createHash } from "node:crypto";
export const GATEWAY_ACCESS_GRANTS_COLLECTION = "gatewayAccessGrants";
export const GATEWAY_ACCESS_AUDIT_COLLECTION = "gatewayAccessAudit";
export const GATEWAY_PERMISSION_SET_IDS = [
    "agent-viewer.v1",
    "trusted-helper.v1",
    "co-owner.v1",
    "builder-shell.v1",
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
            "Use Builder Shell",
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
            "Use Builder Shell, manage billing, or give access",
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
            "Use Builder Shell without a separate grant",
        ]),
    }),
    "builder-shell.v1": Object.freeze({
        label: "Builder Shell",
        purpose: "Debug directly in the agent runtime.",
        can: Object.freeze([
            "Read and edit runtime files",
            "Run commands as the non-root runtime user",
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
    if (!input || input.schemaVersion !== 1)
        return null;
    const ids = permissionSetIds(input.permissionSetIds);
    const expiresAt = timestampMillis(input.expiresAt);
    if (!nonEmptyString(input.gatewayId) ||
        !nonEmptyString(input.workspaceSlug) ||
        !nonEmptyString(input.ownerUid) ||
        !nonEmptyString(input.granteeUid) ||
        !ids ||
        (input.state !== "active" && input.state !== "revoked") ||
        !Number.isSafeInteger(input.revision) ||
        input.revision < 1 ||
        expiresAt === undefined)
        return null;
    return {
        gatewayId: input.gatewayId,
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
export function resolveGatewayPrincipalAccess(input) {
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
            shell: true,
            workspaceManagement: true,
            grantRevision: null,
            expiresAt: null,
        };
    }
    if (input.grant === null || input.grant === undefined) {
        return { kind: "denied", reason: "grant_missing" };
    }
    const grant = parseGrant(input.grant);
    if (!grant ||
        grant.gatewayId !== input.gateway.gatewayId ||
        grant.workspaceSlug !== input.gateway.workspaceSlug ||
        grant.ownerUid !== input.gateway.ownerUid ||
        grant.granteeUid !== input.uid)
        return { kind: "denied", reason: "grant_invalid" };
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
        shell: grant.permissionSetIds.includes("builder-shell.v1"),
        workspaceManagement: grant.permissionSetIds.includes("co-owner.v1"),
        grantRevision: grant.revision,
        expiresAt: grant.expiresAt,
    };
}
export function gatewayAccessGrantId(gatewayId, granteeUid) {
    return createHash("sha256").update(gatewayId).update("\0").update(granteeUid).digest("hex");
}
