import * as crypto from "crypto";
import { db, FieldValue, Timestamp } from "./db.js";
import { platformStateStore } from "./platform-state.js";

// Unified "mint centrally, manage at the gateway" ticket primitive. One
// collection, purpose-scoped. See docs/specs/GATEWAY-ROUTING-PATTERN-SPEC.md.

export const GATEWAY_TICKET_PURPOSES = [
  "mattermost-ws",
  "openclaw-ws",
  "preview",
  "voice-ws",
] as const;
export type GatewayTicketPurpose = (typeof GATEWAY_TICKET_PURPOSES)[number];

export function isGatewayTicketPurpose(v: unknown): v is GatewayTicketPurpose {
  return typeof v === "string" && (GATEWAY_TICKET_PURPOSES as readonly string[]).includes(v);
}

export interface GatewayTicket {
  ticket: string;
  uid: string;
  gatewayId: string;
  purpose: GatewayTicketPurpose;
  expiresAt: number;
  // Feature-specific fields. The primitive owns ticket semantics; the feature owns payload.
  payload: Record<string, unknown>;
}

export class TicketCapExceededError extends Error {
  override readonly name = "TicketCapExceededError";
  constructor(
    readonly uid: string,
    readonly purpose: GatewayTicketPurpose,
    readonly cap: number,
  ) {
    super(`gateway ticket cap exceeded for uid ${uid} purpose ${purpose} (cap=${cap})`);
  }
}

export class HourlyMintQuotaExceededError extends Error {
  override readonly name = "HourlyMintQuotaExceededError";
  constructor(
    readonly uid: string,
    readonly purpose: GatewayTicketPurpose,
    readonly quota: number,
    readonly windowMs: number,
  ) {
    super(`hourly mint quota exceeded for uid ${uid} purpose ${purpose} (quota=${quota}/${windowMs}ms)`);
  }
}

interface PurposePolicy {
  ttlMs: number;
  // Optional abuse bounds for interactive session tickets; lighter WS purposes
  // mint freely.
  perUidCap?: number;
  hourlyQuota?: number;
}

const HOURLY_WINDOW_MS = 60 * 60 * 1000;

const POLICIES: Record<GatewayTicketPurpose, PurposePolicy> = {
  "mattermost-ws": { ttlMs: 30_000 },
  "openclaw-ws": { ttlMs: 30_000 },
  "preview": { ttlMs: 30_000 },
  "voice-ws": { ttlMs: 30_000, perUidCap: 5, hourlyQuota: 120 },
};

const COLLECTION = "gatewayTickets";
const MINT_LOG_COLLECTION = "gatewayTicketMintLog";

export async function mintTicket(args: {
  uid: string;
  gatewayId: string;
  purpose: GatewayTicketPurpose;
  payload?: Record<string, unknown>;
  now?: number;
}): Promise<GatewayTicket> {
  const { uid, gatewayId, purpose } = args;
  const now = args.now ?? Date.now();
  const payload = args.payload ?? {};

  if (!isGatewayTicketPurpose(purpose)) {
    throw new Error(`mintTicket: invalid purpose "${String(purpose)}"`);
  }
  if (typeof uid !== "string" || !uid) throw new Error("mintTicket: uid required");
  // gatewayId is stored on every ticket but may be "" for not-yet-provisioned
  // callers (oc/ws legacy path). Requiring it non-empty — and routing by it —
  // is the per-instance-routing follow-up, not this migration.
  if (typeof gatewayId !== "string") throw new Error("mintTicket: gatewayId must be a string");

  const policy = POLICIES[purpose];
  const ticketId = crypto.randomUUID();
  const expiresAt = now + policy.ttlMs;
  const result: GatewayTicket = { ticket: ticketId, uid, gatewayId, purpose, expiresAt, payload };

  if (policy.perUidCap === undefined && policy.hourlyQuota === undefined) {
    await platformStateStore.access.gatewayTickets.create({
      ticketId,
      uid,
      gatewayId,
      expiresAt,
      grant: { purpose, payload, createdAt: { serverNow: true } },
    });
    return result;
  }

  const ticketRef = db.collection(COLLECTION).doc(ticketId);
  const docData = {
    uid,
    gatewayId,
    purpose,
    expiresAt,
    // Timestamp twin of expiresAt so a Firestore TTL policy GCs unredeemed
    // tickets — redeem leaves expired/invalid docs in place by design, so
    // without TTL they'd retain uid/gateway/payload metadata indefinitely.
    expireAt: Timestamp.fromMillis(expiresAt),
    payload,
    createdAt: FieldValue.serverTimestamp(),
  };

  // Transactional read-then-write so concurrent mints can't both pass a stale
  // count — Firestore optimistic concurrency forces retry-and-reread. Caps and
  // quota are scoped per (uid, purpose): exhausting one purpose never starves
  // another. (Reads precede writes, as Firestore transactions require.)
  const windowStart = now - HOURLY_WINDOW_MS;
  const mintLogRef = db.collection(MINT_LOG_COLLECTION).doc();
  const liveQuery = db
    .collection(COLLECTION)
    .where("uid", "==", uid)
    .where("purpose", "==", purpose)
    .where("expiresAt", ">", now);
  const mintLogQuery = db
    .collection(MINT_LOG_COLLECTION)
    .where("uid", "==", uid)
    .where("purpose", "==", purpose)
    .where("mintedAt", ">", windowStart);

  await db.runTransaction(async (tx) => {
    if (policy.hourlyQuota !== undefined) {
      const logSnap = await tx.get(mintLogQuery);
      if (logSnap.size >= policy.hourlyQuota) {
        throw new HourlyMintQuotaExceededError(uid, purpose, policy.hourlyQuota, HOURLY_WINDOW_MS);
      }
    }
    if (policy.perUidCap !== undefined) {
      const liveSnap = await tx.get(liveQuery);
      if (liveSnap.size >= policy.perUidCap) {
        throw new TicketCapExceededError(uid, purpose, policy.perUidCap);
      }
    }
    tx.set(ticketRef, docData);
    if (policy.hourlyQuota !== undefined) {
      tx.set(mintLogRef, {
        uid,
        purpose,
        mintedAt: now,
        expireAt: Timestamp.fromMillis(now + HOURLY_WINDOW_MS),
      });
    }
  });

  return result;
}

export const _testInternal = {
  COLLECTION,
  MINT_LOG_COLLECTION,
  POLICIES,
  HOURLY_WINDOW_MS,
};
