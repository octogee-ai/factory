import { createHash, randomBytes } from "node:crypto";
import { permissionSetIds, } from "./gateway-principal-access.js";
export const OPENCLAW_CONTROL_TICKETS_COLLECTION = "openclawControlTickets";
export const OPENCLAW_CONTROL_TICKET_TTL_MS = 120_000;
export function openClawControlTicketHash(ticket) {
    return createHash("sha256").update(ticket, "utf8").digest("hex");
}
export function createOpenClawControlTicket(args) {
    const now = args.now ?? Date.now();
    const ticket = (args.random ?? randomBytes)(32).toString("base64url");
    return {
        ticket,
        ticketHash: openClawControlTicketHash(ticket),
        document: {
            uid: args.uid,
            gatewayId: args.gatewayId,
            workspaceSlug: args.workspaceSlug,
            revisionId: args.revisionId,
            brokerProfile: args.brokerProfile,
            permissionSetIds: args.permissionSetIds,
            grantRevision: args.grantRevision,
            expiresAt: now + OPENCLAW_CONTROL_TICKET_TTL_MS,
            createdAt: now,
        },
    };
}
export function redeemableOpenClawControlTicket(args) {
    const inspected = inspectOpenClawControlTicket(args);
    return inspected.kind === "redeemable"
        ? {
            uid: inspected.uid,
            gatewayId: inspected.gatewayId,
            workspaceSlug: inspected.workspaceSlug,
            revisionId: inspected.revisionId,
            brokerProfile: inspected.brokerProfile,
            permissionSetIds: inspected.permissionSetIds,
            grantRevision: inspected.grantRevision,
            expiresAt: inspected.expiresAt,
        }
        : null;
}
function nonEmptyString(value) {
    return typeof value === "string" && value.length > 0;
}
function finiteNumber(value) {
    return typeof value === "number" && Number.isFinite(value);
}
function brokerProfile(value) {
    return value === "native-owner" || value === "native-co-owner" ||
        value === "delegated-config" || value === "delegated-read"
        ? value
        : null;
}
function ticketBinding(profile, rawPermissionSetIds, grantRevision) {
    if (profile === "native-owner") {
        return Array.isArray(rawPermissionSetIds) && rawPermissionSetIds.length === 0 &&
            grantRevision === null
            ? { ids: [], grantRevision: null }
            : null;
    }
    const ids = permissionSetIds(rawPermissionSetIds);
    return ids && Number.isSafeInteger(grantRevision) && grantRevision >= 1
        ? { ids, grantRevision: grantRevision }
        : null;
}
function parseOpenClawControlTicket(document) {
    if (!document)
        return null;
    const { uid, gatewayId, workspaceSlug, revisionId, brokerProfile: rawProfile, permissionSetIds: rawPermissionSetIds, grantRevision, expiresAt, redeemedAt, } = document;
    const profile = brokerProfile(rawProfile);
    const binding = profile ? ticketBinding(profile, rawPermissionSetIds, grantRevision) : null;
    if (!nonEmptyString(uid) ||
        !nonEmptyString(gatewayId) ||
        !nonEmptyString(workspaceSlug) ||
        !nonEmptyString(revisionId) ||
        !finiteNumber(expiresAt) ||
        !profile ||
        !binding) {
        return null;
    }
    return {
        uid,
        gatewayId,
        workspaceSlug,
        revisionId,
        brokerProfile: profile,
        permissionSetIds: binding.ids,
        grantRevision: binding.grantRevision,
        expiresAt,
        redeemedAt,
    };
}
export function inspectOpenClawControlTicket(args) {
    const ticket = parseOpenClawControlTicket(args.document);
    if (!ticket)
        return { kind: "rejected", reason: "ticket_invalid" };
    if (ticket.gatewayId !== args.gatewayId) {
        return { kind: "rejected", reason: "gateway_mismatch", uid: ticket.uid };
    }
    if (ticket.revisionId !== args.revisionId) {
        return { kind: "rejected", reason: "revision_mismatch", uid: ticket.uid };
    }
    if (ticket.redeemedAt !== undefined) {
        return finiteNumber(ticket.redeemedAt)
            ? { kind: "rejected", reason: "ticket_replay", uid: ticket.uid }
            : { kind: "rejected", reason: "ticket_invalid", uid: ticket.uid };
    }
    if (ticket.expiresAt <= (args.now ?? Date.now())) {
        return { kind: "rejected", reason: "ticket_expired", uid: ticket.uid };
    }
    return {
        kind: "redeemable",
        uid: ticket.uid,
        gatewayId: args.gatewayId,
        workspaceSlug: ticket.workspaceSlug,
        revisionId: args.revisionId,
        brokerProfile: ticket.brokerProfile,
        permissionSetIds: ticket.permissionSetIds,
        grantRevision: ticket.grantRevision,
        expiresAt: ticket.expiresAt,
    };
}
