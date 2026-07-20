import { createHash, randomBytes } from "node:crypto";
import {
  permissionSetIds,
  type GatewayPermissionSetId,
  type OpenClawBrokerProfile,
} from "./gateway-principal-access.js";

export const OPENCLAW_CONTROL_TICKETS_COLLECTION = "openclawControlTickets";
export const OPENCLAW_CONTROL_AUDIT_COLLECTION = "openclawControlAudit";
export const OPENCLAW_CONTROL_TICKET_TTL_MS = 120_000;

export interface OpenClawControlTicketDocument {
  uid: string;
  gatewayId: string;
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
  revisionId: string;
  brokerProfile: OpenClawBrokerProfile;
  permissionSetIds: GatewayPermissionSetId[];
  grantRevision: number | null;
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
  brokerProfile: OpenClawBrokerProfile;
  permissionSetIds: GatewayPermissionSetId[];
  grantRevision: number | null;
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
      brokerProfile: args.brokerProfile,
      permissionSetIds: args.permissionSetIds,
      grantRevision: args.grantRevision,
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
        brokerProfile: inspected.brokerProfile,
        permissionSetIds: inspected.permissionSetIds,
        grantRevision: inspected.grantRevision,
        expiresAt: inspected.expiresAt,
      }
    : null;
}

interface ParsedOpenClawControlTicket {
  uid: string;
  gatewayId: string;
  revisionId: string;
  brokerProfile: OpenClawBrokerProfile;
  permissionSetIds: GatewayPermissionSetId[];
  grantRevision: number | null;
  expiresAt: number;
  redeemedAt: unknown;
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function finiteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function brokerProfile(value: unknown): OpenClawBrokerProfile | null {
  return value === "native-owner" || value === "native-co-owner" ||
    value === "delegated-config" || value === "delegated-read"
    ? value
    : null;
}

function ticketBinding(
  profile: OpenClawBrokerProfile,
  rawPermissionSetIds: unknown,
  grantRevision: unknown,
): { ids: GatewayPermissionSetId[]; grantRevision: number | null } | null {
  if (profile === "native-owner") {
    return Array.isArray(rawPermissionSetIds) && rawPermissionSetIds.length === 0 &&
      grantRevision === null
      ? { ids: [], grantRevision: null }
      : null;
  }
  const ids = permissionSetIds(rawPermissionSetIds);
  return ids && Number.isSafeInteger(grantRevision) && (grantRevision as number) >= 1
    ? { ids, grantRevision: grantRevision as number }
    : null;
}

function parseOpenClawControlTicket(
  document: Record<string, unknown> | undefined,
): ParsedOpenClawControlTicket | null {
  if (!document) return null;
  const {
    uid,
    gatewayId,
    revisionId,
    brokerProfile: rawProfile,
    permissionSetIds: rawPermissionSetIds,
    grantRevision,
    expiresAt,
    redeemedAt,
  } = document;
  const profile = brokerProfile(rawProfile);
  const binding = profile ? ticketBinding(profile, rawPermissionSetIds, grantRevision) : null;
  if (
    !nonEmptyString(uid) ||
    !nonEmptyString(gatewayId) ||
    !nonEmptyString(revisionId) ||
    !finiteNumber(expiresAt) ||
    !profile ||
    !binding
  ) {
    return null;
  }
  return {
    uid,
    gatewayId,
    revisionId,
    brokerProfile: profile,
    permissionSetIds: binding.ids,
    grantRevision: binding.grantRevision,
    expiresAt,
    redeemedAt,
  };
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
    brokerProfile: ticket.brokerProfile,
    permissionSetIds: ticket.permissionSetIds,
    grantRevision: ticket.grantRevision,
    expiresAt: ticket.expiresAt,
  };
}
