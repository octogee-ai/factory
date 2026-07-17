import { createHash, randomBytes } from "node:crypto";

export const OPENCLAW_CONTROL_TICKETS_COLLECTION = "openclawControlTickets";
export const OPENCLAW_CONTROL_AUDIT_COLLECTION = "openclawControlAudit";
export const OPENCLAW_CONTROL_TICKET_TTL_MS = 120_000;

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

interface ParsedOpenClawControlTicket {
  uid: string;
  gatewayId: string;
  revisionId: string;
  expiresAt: number;
  redeemedAt: unknown;
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function finiteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function parseOpenClawControlTicket(
  document: Record<string, unknown> | undefined,
): ParsedOpenClawControlTicket | null {
  if (!document) return null;
  const { uid, gatewayId, revisionId, expiresAt, redeemedAt } = document;
  if (
    !nonEmptyString(uid) ||
    !nonEmptyString(gatewayId) ||
    !nonEmptyString(revisionId) ||
    !finiteNumber(expiresAt)
  ) {
    return null;
  }
  return { uid, gatewayId, revisionId, expiresAt, redeemedAt };
}

export function inspectOpenClawControlTicket(args: {
  document: Record<string, unknown> | undefined;
  gatewayId: string;
  revisionId: string;
  now?: number;
}): OpenClawControlTicketInspection {
  const ticket = parseOpenClawControlTicket(args.document);
  if (!ticket) return { kind: "rejected", reason: "ticket_invalid" };
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
    revisionId: args.revisionId,
    expiresAt: ticket.expiresAt,
  };
}
