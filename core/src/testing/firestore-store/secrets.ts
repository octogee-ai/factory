import type { CollectionReference, DocumentData, DocumentReference, DocumentSnapshot, Query } from "firebase-admin/firestore";
import { MODEL_BROKER_GATEWAY_POINTERS_COLLECTION, MODEL_BROKER_TOKENS_COLLECTION } from "@octogee/shared/types/model-broker-usage";
import { GATEWAY_ACCESS_AUDIT_COLLECTION } from "../../gateway-principal-access.js";
import { OPENCLAW_CONTROL_TICKETS_COLLECTION } from "../../openclaw-control-tickets.js";
import { MissingRecordError, type RecordKey, UnsupportedOperationError } from "../../platform-state/errors.js";
import type { AccessRepositories, ControlSession, ControlSessionsRepository, ControlTicket, ControlTicketsRepository, GatewayAccessAuditRepository, GatewayTicket, GatewayTicketsRepository, ModelBrokerGatewayToken, ModelBrokerGatewayTokensRepository, ModelBrokerToken, ModelBrokerTokensRepository, SecretsRepository, UserSecret, UserSecretInput } from "../../platform-state/secrets.js";
import type { OpaqueMap, Stored } from "../../platform-state/store.js";
import { assertFenceEquals } from "../../platform-state/documents/fences.js";
import { assertRevisionFence } from "./fences.js";
import type { FirestoreSession } from "./session.js";
import { STORED_AS_NUMBERS, decodeDocumentData, encodeDocument, encodePatch, revisionOf, storedAsTimestamps } from "./values.js";
import { withStoredRevision } from "./workspaces.js";
import { ACCESS_DENIAL_BUCKET_MS, CONTROL_SESSION_FIELDS, CONTROL_TICKET_FIELDS, GATEWAY_TICKET_FIELDS, controlSessionFromData, controlSessionKey, controlTicketFromData, controlTicketKey, gatewayAccessDenialAuditId, gatewayTicketFromData, gatewayTicketKey, modelBrokerGatewayTokenFromData, modelBrokerPointerKey, modelBrokerTokenDocument, modelBrokerTokenFromData, modelBrokerTokenKey, nonNull, secretKey, secretKindOf, userSecretFromData, userSecretToData } from "../../platform-state/documents/secrets.js";

export const GATEWAY_TICKETS_COLLECTION = "gatewayTickets";
export const GATEWAY_TICKET_MINT_LOG_COLLECTION = "gatewayTicketMintLog";
export const OPENCLAW_CONTROL_SESSIONS_COLLECTION = "openclawControlSessions";

const SECRET_TIMES = storedAsTimestamps("createdAt", "rotatedAt", "updatedAt");
const TICKET_TIMES = storedAsTimestamps("expireAt");
const CONTROL_TICKET_TIMES = storedAsTimestamps("createdAt", "expireAt");
function isPresent<T>(value: T | null): value is T {
  return value !== null;
}

function assertNoReservedKeys(operation: string, map: OpaqueMap, reserved: readonly string[]): void {
  const collisions = Object.keys(map).filter((key) => reserved.includes(key));
  if (collisions.length > 0) {
    throw new TypeError(`${operation}: ${collisions.join(", ")} are typed fields and cannot appear in the opaque map`);
  }
}

const accessAuditKey = (id: string): RecordKey => ({ aggregate: "gateway-access-audit", key: id });
function secretsCollection(session: FirestoreSession, uid: string): CollectionReference {
  return session.db.collection("users").doc(uid).collection("secrets");
}

function decodeSecret(uid: string, snapshot: DocumentSnapshot): Stored<UserSecret> | null {
  if (!snapshot.exists) return null;
  return withStoredRevision(snapshot, userSecretFromData(uid, snapshot.id, decodeDocumentData(snapshot)));
}

function encodeSecret(secret: UserSecretInput): DocumentData {
  return encodeDocument(userSecretToData(secret), SECRET_TIMES);
}

export function createFirestoreSecretsRepository(session: FirestoreSession): SecretsRepository {
  const ref = (uid: string, secretId: string) => secretsCollection(session, uid).doc(secretId);

  return {
    async get(uid, secretId) {
      return decodeSecret(uid, await session.read("secrets.get", ref(uid, secretId)));
    },

    async list(uid, kind) {
      const snapshot = await session.query("secrets.list", secretsCollection(session, uid));
      const docs = kind === undefined ? snapshot.docs : snapshot.docs.filter((doc) => secretKindOf(doc.id) === kind);
      return docs.map((doc) => decodeSecret(uid, doc)).filter(isPresent);
    },

    async put(uid, secret) {
      await session.set("secrets.put", secretKey(uid, secret.secretId), ref(uid, secret.secretId), encodeSecret(secret));
    },

    async delete(uid, secretId) {
      await session.delete("secrets.delete", secretKey(uid, secretId), ref(uid, secretId));
    },
  };
}

function decodeGatewayTicket(snapshot: DocumentSnapshot): Stored<GatewayTicket> | null {
  if (!snapshot.exists) return null;
  return withStoredRevision(snapshot, gatewayTicketFromData(snapshot.id, decodeDocumentData(snapshot)));
}

function decodeControlTicket(snapshot: DocumentSnapshot): Stored<ControlTicket> | null {
  if (!snapshot.exists) return null;
  return withStoredRevision(snapshot, controlTicketFromData(snapshot.id, decodeDocumentData(snapshot)));
}

function decodeControlSession(snapshot: DocumentSnapshot): Stored<ControlSession> | null {
  if (!snapshot.exists) return null;
  return withStoredRevision(snapshot, controlSessionFromData(snapshot.id, decodeDocumentData(snapshot)));
}

function decodeModelBrokerToken(snapshot: DocumentSnapshot): Stored<ModelBrokerToken> | null {
  if (!snapshot.exists) return null;
  return withStoredRevision(snapshot, modelBrokerTokenFromData(snapshot.id, decodeDocumentData(snapshot)));
}

function decodeModelBrokerGatewayToken(snapshot: DocumentSnapshot): Stored<ModelBrokerGatewayToken> | null {
  if (!snapshot.exists) return null;
  return withStoredRevision(snapshot, modelBrokerGatewayTokenFromData(snapshot.id, decodeDocumentData(snapshot)));
}

async function fencedRead(
  session: FirestoreSession,
  name: string,
  key: RecordKey,
  ref: DocumentReference,
): Promise<DocumentSnapshot> {
  const current = await session.readForFence(name, ref);
  if (!current.exists) throw new MissingRecordError(key);
  return current;
}

function createGatewayTicketsRepository(session: FirestoreSession): GatewayTicketsRepository {
  const ref = (ticketId: string) => session.db.collection(GATEWAY_TICKETS_COLLECTION).doc(ticketId);
  const mintLog = () => session.db.collection(GATEWAY_TICKET_MINT_LOG_COLLECTION);

  return {
    async get(ticketId) {
      return decodeGatewayTicket(await session.read("access.gatewayTickets.get", ref(ticketId)));
    },

    async countLive(uid, purpose, now) {
      const query = session.db
        .collection(GATEWAY_TICKETS_COLLECTION)
        .where("uid", "==", uid)
        .where("purpose", "==", purpose)
        .where("expiresAt", ">", now);
      return (await session.query("access.gatewayTickets.countLive", query)).size;
    },

    async countMintsSince(uid, purpose, since) {
      const query = mintLog().where("uid", "==", uid).where("purpose", "==", purpose).where("mintedAt", ">", since);
      return (await session.query("access.gatewayTickets.countMintsSince", query)).size;
    },

    async recordMint(mint) {
      const entry = mintLog().doc();
      await session.set(
        "access.gatewayTickets.recordMint",
        gatewayTicketKey(entry.id),
        entry,
        encodeDocument({ uid: mint.uid, purpose: mint.purpose, mintedAt: mint.mintedAt, expireAt: mint.expiresAt }, TICKET_TIMES),
      );
    },

    async create(ticket) {
      assertNoReservedKeys("access.gatewayTickets.create", ticket.grant, GATEWAY_TICKET_FIELDS);
      await session.create(
        "access.gatewayTickets.create",
        gatewayTicketKey(ticket.ticketId),
        ref(ticket.ticketId),
        encodeDocument(
          {
            ...ticket.grant,
            uid: ticket.uid,
            gatewayId: ticket.gatewayId,
            expiresAt: ticket.expiresAt,
            expireAt: ticket.expiresAt,
          },
          TICKET_TIMES,
        ),
      );
    },

    async patchGrant(ticketId, patch, fence) {
      const name = "access.gatewayTickets.patchGrant";
      const key = gatewayTicketKey(ticketId);
      assertNoReservedKeys(name, patch, GATEWAY_TICKET_FIELDS);
      const data = encodePatch(patch, TICKET_TIMES);
      if (fence?.revision === undefined) {
        await session.update(name, key, ref(ticketId), data);
        return;
      }
      await session.atomically(name, async (fenced) => {
        const current = await fencedRead(fenced, name, key, ref(ticketId));
        assertRevisionFence(key, fence.revision, revisionOf(current));
        await fenced.update(name, key, ref(ticketId), data);
      });
    },

    async delete(ticketId, fence) {
      const name = "access.gatewayTickets.delete";
      const key = gatewayTicketKey(ticketId);
      if (fence?.revision === undefined) {
        await session.delete(name, key, ref(ticketId));
        return;
      }
      await session.atomically(name, async (fenced) => {
        const current = await fencedRead(fenced, name, key, ref(ticketId));
        assertRevisionFence(key, fence.revision, revisionOf(current));
        await fenced.delete(name, key, ref(ticketId));
      });
    },
  };
}

function createControlTicketsRepository(session: FirestoreSession): ControlTicketsRepository {
  const ref = (ticketHash: string) => session.db.collection(OPENCLAW_CONTROL_TICKETS_COLLECTION).doc(ticketHash);

  return {
    async get(ticketHash) {
      return decodeControlTicket(await session.read("access.controlTickets.get", ref(ticketHash)));
    },

    async create(ticket) {
      assertNoReservedKeys("access.controlTickets.create", ticket.grant, CONTROL_TICKET_FIELDS);
      await session.create(
        "access.controlTickets.create",
        controlTicketKey(ticket.ticketHash),
        ref(ticket.ticketHash),
        encodeDocument(
          {
            ...ticket.grant,
            uid: ticket.uid,
            gatewayId: ticket.gatewayId,
            createdAt: ticket.createdAt,
            expiresAt: ticket.expiresAt,
            expireAt: ticket.expiresAt,
            ...nonNull({ redeemedAt: ticket.redeemedAt }),
          },
          CONTROL_TICKET_TIMES,
        ),
      );
    },

    async markRedeemed(ticketHash, redeemedAt, fence) {
      const name = "access.controlTickets.markRedeemed";
      const key = controlTicketKey(ticketHash);
      await session.atomically(name, async (fenced) => {
        const current = decodeControlTicket(await fencedRead(fenced, name, key, ref(ticketHash)));
        assertFenceEquals(key, "absent", fence.redeemedAt, current?.redeemedAt);
        await fenced.update(name, key, ref(ticketHash), { redeemedAt });
      });
    },
  };
}

function createControlSessionsRepository(session: FirestoreSession): ControlSessionsRepository {
  const ref = (sessionHash: string) => session.db.collection(OPENCLAW_CONTROL_SESSIONS_COLLECTION).doc(sessionHash);

  return {
    async get(sessionHash) {
      return decodeControlSession(await session.read("access.controlSessions.get", ref(sessionHash)));
    },

    async put(controlSession) {
      assertNoReservedKeys("access.controlSessions.put", controlSession.grant, CONTROL_SESSION_FIELDS);
      await session.set(
        "access.controlSessions.put",
        controlSessionKey(controlSession.sessionHash),
        ref(controlSession.sessionHash),
        encodeDocument(
          {
            ...controlSession.grant,
            uid: controlSession.uid,
            gatewayId: controlSession.gatewayId,
            ...nonNull({ createdAt: controlSession.createdAt, mobileEnrollmentId: controlSession.attachmentId }),
            expiresAt: controlSession.expiresAt,
            expireAt: controlSession.expiresAt,
          },
          TICKET_TIMES,
        ),
      );
    },

    async delete(sessionHash) {
      await session.delete("access.controlSessions.delete", controlSessionKey(sessionHash), ref(sessionHash));
    },
  };
}

function createAccessAuditRepository(session: FirestoreSession): GatewayAccessAuditRepository {
  return {
    async record(denial) {
      const id = gatewayAccessDenialAuditId(denial.gatewayId, denial.uid ?? "", denial.reason, denial.at);
      await session.set(
        "access.accessAudit.record",
        accessAuditKey(id),
        session.db.collection(GATEWAY_ACCESS_AUDIT_COLLECTION).doc(id),
        encodeDocument(
          {
            ...denial.detail,
            gatewayId: denial.gatewayId,
            granteeUid: denial.uid,
            event: "denied",
            reason: denial.reason,
            outcome: "denied",
            createdAt: Math.floor(denial.at / ACCESS_DENIAL_BUCKET_MS) * ACCESS_DENIAL_BUCKET_MS,
          },
          STORED_AS_NUMBERS,
        ),
      );
      return id;
    },
  };
}

function createModelBrokerTokensRepository(session: FirestoreSession): ModelBrokerTokensRepository {
  const collection = () => session.db.collection(MODEL_BROKER_TOKENS_COLLECTION);
  const ref = (tokenHash: string) => collection().doc(tokenHash);

  return {
    async get(tokenHash) {
      return decodeModelBrokerToken(await session.read("access.modelBrokerTokens.get", ref(tokenHash)));
    },

    async listForOwner(ownerUid) {
      const query: Query = collection().where("ownerUid", "==", ownerUid);
      const snapshot = await session.query("access.modelBrokerTokens.listForOwner", query);
      return snapshot.docs.map(decodeModelBrokerToken).filter(isPresent);
    },

    async create(token) {
      await session.create(
        "access.modelBrokerTokens.create",
        modelBrokerTokenKey(token.tokenHash),
        ref(token.tokenHash),
        encodeDocument(modelBrokerTokenDocument(token), STORED_AS_NUMBERS),
      );
    },

    async revoke(tokenHash, revokedAt) {
      await session.merge(
        "access.modelBrokerTokens.revoke",
        modelBrokerTokenKey(tokenHash),
        ref(tokenHash),
        { revoked: true, revokedAt },
      );
    },

    async delete(tokenHash) {
      await session.delete("access.modelBrokerTokens.delete", modelBrokerTokenKey(tokenHash), ref(tokenHash));
    },
  };
}

function createModelBrokerGatewayTokensRepository(session: FirestoreSession): ModelBrokerGatewayTokensRepository {
  const collection = () => session.db.collection(MODEL_BROKER_GATEWAY_POINTERS_COLLECTION);
  const ref = (pointerKey: string) => collection().doc(pointerKey);

  return {
    async get(pointerKey) {
      return decodeModelBrokerGatewayToken(await session.read("access.modelBrokerGatewayTokens.get", ref(pointerKey)));
    },

    async listForOwner(ownerUid) {
      const snapshot = await session.query(
        "access.modelBrokerGatewayTokens.listForOwner",
        collection().where("ownerUid", "==", ownerUid),
      );
      return snapshot.docs.map(decodeModelBrokerGatewayToken).filter(isPresent);
    },

    async put(pointer) {
      const { pointerKey, ...fields } = pointer;
      await session.set(
        "access.modelBrokerGatewayTokens.put",
        modelBrokerPointerKey(pointerKey),
        ref(pointerKey),
        encodeDocument(fields, STORED_AS_NUMBERS),
      );
    },

    async delete(pointerKey) {
      await session.delete("access.modelBrokerGatewayTokens.delete", modelBrokerPointerKey(pointerKey), ref(pointerKey));
    },
  };
}

const UID_REFERENCING_ACCESS_QUERIES = [
  { collection: GATEWAY_TICKETS_COLLECTION, field: "uid" },
  { collection: GATEWAY_TICKET_MINT_LOG_COLLECTION, field: "uid" },
  { collection: OPENCLAW_CONTROL_TICKETS_COLLECTION, field: "uid" },
  { collection: OPENCLAW_CONTROL_SESSIONS_COLLECTION, field: "uid" },
  { collection: GATEWAY_ACCESS_AUDIT_COLLECTION, field: "ownerUid" },
  { collection: GATEWAY_ACCESS_AUDIT_COLLECTION, field: "actorUid" },
  { collection: GATEWAY_ACCESS_AUDIT_COLLECTION, field: "granteeUid" },
] as const;

async function accessDocumentsForUid(session: FirestoreSession, uid: string): Promise<ReadonlyMap<string, DocumentReference>> {
  const snapshots = await Promise.all(UID_REFERENCING_ACCESS_QUERIES.map(({ collection, field }) =>
    session.query("access.listRecordsForUid", session.db.collection(collection).where(field, "==", uid))));
  return new Map(snapshots.flatMap((snapshot) => snapshot.docs).map((doc) => [doc.ref.path, doc.ref]));
}

export function createFirestoreAccessRepositories(session: FirestoreSession): AccessRepositories {
  return {
    gatewayTickets: createGatewayTicketsRepository(session),
    controlTickets: createControlTicketsRepository(session),
    controlSessions: createControlSessionsRepository(session),
    accessAudit: createAccessAuditRepository(session),
    modelBrokerTokens: createModelBrokerTokensRepository(session),
    modelBrokerGatewayTokens: createModelBrokerGatewayTokensRepository(session),

    async listRecordsForUid(uid) {
      return [...(await accessDocumentsForUid(session, uid)).keys()];
    },

    async eraseForUid(uid) {
      if (session.transactional) {
        throw new UnsupportedOperationError("firestore", "access.eraseForUid inside a transaction", "backend-capability");
      }
      const writer = session.db.bulkWriter();
      const refs = [...(await accessDocumentsForUid(session, uid)).values()];
      await Promise.all([...refs.map((ref) => writer.delete(ref)), writer.close()]);
    },
  };
}
