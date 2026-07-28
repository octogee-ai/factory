import { type GatewayPermissionSetId, type OpenClawBrokerProfile } from "./gateway-principal-access.js";
export declare const OPENCLAW_CONTROL_TICKETS_COLLECTION = "openclawControlTickets";
export declare const OPENCLAW_CONTROL_AUDIT_COLLECTION = "openclawControlAudit";
export declare const OPENCLAW_CONTROL_TICKET_TTL_MS = 120000;
export interface OpenClawControlTicketDocument {
    uid: string;
    gatewayId: string;
    workspaceSlug: string;
    revisionId: string;
    brokerProfile: OpenClawBrokerProfile;
    permissionSetIds: GatewayPermissionSetId[];
    grantRevision: number | null;
    expiresAt: number;
    createdAt: unknown;
    redeemedAt?: number;
}
export interface OpenClawControlRedemption {
    uid: string;
    gatewayId: string;
    workspaceSlug: string;
    revisionId: string;
    brokerProfile: OpenClawBrokerProfile;
    permissionSetIds: GatewayPermissionSetId[];
    grantRevision: number | null;
    expiresAt: number;
}
export type OpenClawControlTicketRejectionReason = "ticket_invalid" | "gateway_mismatch" | "revision_mismatch" | "ticket_replay" | "ticket_expired";
export type OpenClawControlTicketInspection = ({
    kind: "redeemable";
} & OpenClawControlRedemption) | {
    kind: "rejected";
    reason: OpenClawControlTicketRejectionReason;
    uid?: string;
};
export declare function openClawControlTicketHash(ticket: string): string;
export declare function createOpenClawControlTicket(args: {
    uid: string;
    gatewayId: string;
    workspaceSlug: string;
    revisionId: string;
    brokerProfile: OpenClawBrokerProfile;
    permissionSetIds: GatewayPermissionSetId[];
    grantRevision: number | null;
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
export declare function inspectOpenClawControlTicket(args: {
    document: Record<string, unknown> | undefined;
    gatewayId: string;
    revisionId: string;
    now?: number;
}): OpenClawControlTicketInspection;
