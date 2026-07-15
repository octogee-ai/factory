import { createHash, randomBytes } from "node:crypto";

export const OPENCLAW_CONTROL_TICKETS_COLLECTION = "openclawControlTickets";
export const OPENCLAW_CONTROL_AUDIT_COLLECTION = "openclawControlAudit";
export const OPENCLAW_CONTROL_TICKET_TTL_MS = 30_000;

export interface OpenClawControlTicketDocument {
  uid: string;
  gatewayId: string;
  revisionId: string;
  expiresAt: number;
  createdAt: unknown;
  redeemedAt?: number;
}

export interface OpenClawControlRedemption {
  uid: string;
  gatewayId: string;
  revisionId: string;
  expiresAt: number;
}

export type OpenClawControlTicketRejectionReason =
  | "ticket_invalid"
  | "gateway_mismatch"
  | "revision_mismatch"
  | "ticket_replay"
  | "ticket_expired";

export type OpenClawControlTicketInspection =
  | ({ kind: "redeemable" } & OpenClawControlRedemption)
  | {
      kind: "rejected";
      reason: OpenClawControlTicketRejectionReason;
      uid?: string;
    };

export function openClawControlTicketHash(ticket: string): string {
  return createHash("sha256").update(ticket, "utf8").digest("hex");
}

export function createOpenClawControlTicket(args: {
  uid: string;
  gatewayId: string;
  revisionId: string;
  now?: number;
  random?: (size: number) => Buffer;
}): { ticket: string; ticketHash: string; document: OpenClawControlTicketDocument } {
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

export function redeemableOpenClawControlTicket(args: {
  document: Record<string, unknown> | undefined;
  gatewayId: string;
  revisionId: string;
  now?: number;
}): OpenClawControlRedemption | null {
  const inspected = inspectOpenClawControlTicket(args);
  return inspected.kind === "redeemable"
    ? {
        uid: inspected.uid,
        gatewayId: inspected.gatewayId,
        revisionId: inspected.revisionId,
        expiresAt: inspected.expiresAt,
      }
    : null;
}

export function inspectOpenClawControlTicket(args: {
  document: Record<string, unknown> | undefined;
  gatewayId: string;
  revisionId: string;
  now?: number;
}): OpenClawControlTicketInspection {
  const { document, gatewayId, revisionId } = args;
  if (!document) return { kind: "rejected", reason: "ticket_invalid" };
  const uid = document.uid;
  const storedGatewayId = document.gatewayId;
  const storedRevisionId = document.revisionId;
  const expiresAt = document.expiresAt;
  if (
    typeof uid !== "string" ||
    uid.length === 0 ||
    typeof storedGatewayId !== "string" ||
    storedGatewayId.length === 0 ||
    typeof storedRevisionId !== "string" ||
    storedRevisionId.length === 0 ||
    typeof expiresAt !== "number" ||
    !Number.isFinite(expiresAt)
  ) {
    return { kind: "rejected", reason: "ticket_invalid" };
  }
  if (storedGatewayId !== gatewayId) {
    return { kind: "rejected", reason: "gateway_mismatch", uid };
  }
  if (storedRevisionId !== revisionId) {
    return { kind: "rejected", reason: "revision_mismatch", uid };
  }
  if (document.redeemedAt !== undefined) {
    return typeof document.redeemedAt === "number" && Number.isFinite(document.redeemedAt)
      ? { kind: "rejected", reason: "ticket_replay", uid }
      : { kind: "rejected", reason: "ticket_invalid", uid };
  }
  if (expiresAt <= (args.now ?? Date.now())) {
    return { kind: "rejected", reason: "ticket_expired", uid };
  }
  return { kind: "redeemable", uid, gatewayId, revisionId, expiresAt };
}
