export declare const OPENCLAW_CONTROL_TICKETS_COLLECTION = "openclawControlTickets";
export declare const OPENCLAW_CONTROL_TICKET_TTL_MS = 30000;
export interface OpenClawControlTicketDocument {
    uid: string;
    gatewayId: string;
    revisionId: string;
    expiresAt: number;
    createdAt: unknown;
}
export interface OpenClawControlRedemption {
    uid: string;
    gatewayId: string;
    revisionId: string;
    expiresAt: number;
}
export declare function openClawControlTicketHash(ticket: string): string;
export declare function createOpenClawControlTicket(args: {
    uid: string;
    gatewayId: string;
    revisionId: string;
    now?: number;
    random?: (size: number) => Buffer;
}): {
    ticket: string;
    ticketHash: string;
    document: OpenClawControlTicketDocument;
};
export declare function redeemableOpenClawControlTicket(args: {
    document: Record<string, unknown> | undefined;
    gatewayId: string;
    revisionId: string;
    now?: number;
}): OpenClawControlRedemption | null;
