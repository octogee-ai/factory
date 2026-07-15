import { createHash, randomBytes } from "node:crypto";
export const OPENCLAW_CONTROL_TICKETS_COLLECTION = "openclawControlTickets";
export const OPENCLAW_CONTROL_TICKET_TTL_MS = 30_000;
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
            revisionId: args.revisionId,
            expiresAt: now + OPENCLAW_CONTROL_TICKET_TTL_MS,
            createdAt: now,
        },
    };
}
export function redeemableOpenClawControlTicket(args) {
    const { document, gatewayId, revisionId } = args;
    if (!document)
        return null;
    if (document.gatewayId !== gatewayId || document.revisionId !== revisionId)
        return null;
    const uid = document.uid;
    const expiresAt = document.expiresAt;
    if (typeof uid !== "string" || uid.length === 0)
        return null;
    if (typeof expiresAt !== "number" || expiresAt <= (args.now ?? Date.now()))
        return null;
    return { uid, gatewayId, revisionId, expiresAt };
}
