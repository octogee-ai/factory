import { isDeepStrictEqual } from "node:util";
import { Timestamp, type DocumentData, type DocumentReference, type DocumentSnapshot, type Query } from "firebase-admin/firestore";
import {
  ANONYMOUS_OPERATIONAL_ARCHIVES_COLLECTION,
  CUSTOMER_DELETION_JOBS_COLLECTION,
} from "@octogee/shared/types/account-lifecycle";
import { MalformedRecordError, MissingRecordError, type RecordKey } from "../errors.js";
import type {
  AgentImportPointer,
  AgentImportPointerName,
  AgentImportRecord,
  AgentImportsRepository,
  AnonymousOperationalArchive,
  AnonymousOperationalArchivesRepository,
  CustomerDeletionJob,
  CustomerDeletionJobPatch,
  CustomerDeletionJobsRepository,
  CustomerDeletionJobStatus,
  JobRepositories,
} from "../jobs.js";
import type { ClearField, OpaqueMap, Revision, Stored } from "../store.js";
import { assertFenceOneOf, assertRevisionFence } from "./fences.js";
import type { FirestoreSession } from "./session.js";
import {
  decodeDocumentData,
  encodeDocument,
  encodeMergeDocument,
  encodePatch,
  isClearField,
  STORED_AS_NUMBERS,
  storedAsTimestamps,
} from "./values.js";
import { FirestoreFields, withStoredRevision } from "./workspaces.js";

const PRODUCT_CONTEXT_FIELDS = ["stripeCustomerIds", "stripeSubscriptionIds", "posthogErasure"] as const;
const STORED_PRODUCT_VERIFICATION_STATUS = "posthog_verification_pending";
const DELETION_STATUSES: readonly CustomerDeletionJobStatus[] = [
  "suspension_pending",
  "suspending",
  "hibernating",
  "product_verification_pending",
  "verified_pending_completion",
  "verified",
];
const OPTIONAL_DELETION_STRINGS = ["uid", "requestedBy", "erasureOperationId", "suspensionOperationId", "archiveId"] as const;
const OPTIONAL_DELETION_NULLABLE_STRINGS = ["slug", "currentGatewayId"] as const;
const OPTIONAL_DELETION_MAPS = ["cleanupContext", "sharedAgentStoreCleanup", "retiredGatewayProofs"] as const;
const OPTIONAL_DELETION_TIMES = ["suspendedAt", "cloudErasedAt", "verifiedAt", "completedAt", "updatedAt"] as const;
const GATEWAY_ID_SEGMENT = /^[A-Za-z0-9_-]+$/;
const AGENT_IMPORT_TIMES = storedAsTimestamps("cleanupAt");
const EXPORT_RECORD_KIND = "authored-agent-export";
const CLEAR: ClearField = { clear: true };

type PlainObject = Record<string, unknown>;

function isPlainObject(value: unknown): value is PlainObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isPresent<T>(value: T | null): value is T {
  return value !== null;
}

const deletionKey = (deletionId: string): RecordKey => ({ aggregate: "customer-deletion-job", key: deletionId });
const archiveKey = (archiveId: string): RecordKey => ({ aggregate: "anonymous-operational-archive", key: archiveId });
const agentImportKey = (uid: string, importId: string): RecordKey => ({ aggregate: "agent-import", key: `${uid}/${importId}` });
const agentImportPointerKey = (uid: string, pointer: AgentImportPointerName): RecordKey => ({
  aggregate: "agent-import-pointer",
  key: `${uid}/${pointer}`,
});

export function storedDeletionStatus(status: CustomerDeletionJobStatus): string {
  return status === "product_verification_pending" ? STORED_PRODUCT_VERIFICATION_STATUS : status;
}

const STORED_DELETION_STATUSES = DELETION_STATUSES.map(storedDeletionStatus);

function domainDeletionStatus(fields: FirestoreFields): CustomerDeletionJobStatus {
  const stored = fields.oneOf("status", STORED_DELETION_STATUSES);
  return stored === STORED_PRODUCT_VERIFICATION_STATUS ? "product_verification_pending" : (stored as CustomerDeletionJobStatus);
}

function decodeDeletionJob(snapshot: DocumentSnapshot): Stored<CustomerDeletionJob> | null {
  if (!snapshot.exists) return null;
  const key = deletionKey(snapshot.id);
  const data = decodeDocumentData(snapshot);
  const fields = new FirestoreFields(key, data);
  if (fields.value("version") !== 1) throw new MalformedRecordError(key, "version must be 1");
  const job: Record<string, unknown> = {
    deletionId: snapshot.id,
    version: 1,
    status: domainDeletionStatus(fields),
    requestedAt: fields.number("requestedAt"),
    eraseAfter: fields.number("eraseAfter"),
  };
  for (const field of OPTIONAL_DELETION_STRINGS) if (field in data) job[field] = fields.string(field);
  for (const field of OPTIONAL_DELETION_NULLABLE_STRINGS) if (field in data) job[field] = fields.nullableString(field);
  for (const field of OPTIONAL_DELETION_TIMES) if (field in data) job[field] = fields.number(field);
  for (const field of OPTIONAL_DELETION_MAPS) if (field in data) job[field] = fields.map(field);
  if ("postgresAgentStoreTargets" in data) {
    const targets = data.postgresAgentStoreTargets;
    if (!Array.isArray(targets) || !targets.every(isPlainObject)) {
      throw new MalformedRecordError(key, "postgresAgentStoreTargets must be a list of maps");
    }
    job.postgresAgentStoreTargets = targets;
  }
  const productContext = Object.fromEntries(PRODUCT_CONTEXT_FIELDS.filter((field) => field in data).map((field) => [field, data[field]]));
  if (Object.keys(productContext).length > 0) job.productContext = productContext;
  return withStoredRevision(snapshot, job as unknown as CustomerDeletionJob);
}

function assertProductContextFields(operation: string, productContext: OpaqueMap): void {
  const unknown = Object.keys(productContext).filter((field) => !(PRODUCT_CONTEXT_FIELDS as readonly string[]).includes(field));
  if (unknown.length > 0) {
    throw new TypeError(`${operation}: product context fields ${unknown.join(", ")} have no Firestore mapping; allowed: ${PRODUCT_CONTEXT_FIELDS.join(", ")}`);
  }
}

function encodeDeletionJob(job: CustomerDeletionJob): DocumentData {
  const { deletionId: _deletionId, productContext, status, ...fields } = job;
  if (productContext !== undefined) assertProductContextFields("jobs.deletions.create", productContext);
  return encodeDocument({ ...fields, ...productContext, status: storedDeletionStatus(status) }, STORED_AS_NUMBERS, ["revision"]);
}

function productContextPatch(productContext: OpaqueMap | ClearField): PlainObject {
  if (isClearField(productContext)) return Object.fromEntries(PRODUCT_CONTEXT_FIELDS.map((field) => [field, CLEAR]));
  assertProductContextFields("jobs.deletions.patch", productContext);
  return Object.fromEntries(PRODUCT_CONTEXT_FIELDS.map((field) => [field, field in productContext ? productContext[field] : CLEAR]));
}

function encodeDeletionPatch(patch: CustomerDeletionJobPatch): DocumentData {
  const { productContext, status, ...rest } = patch;
  return encodePatch(
    {
      ...rest,
      ...(status === undefined ? {} : { status: storedDeletionStatus(status) }),
      ...(productContext === undefined ? {} : productContextPatch(productContext)),
    },
    STORED_AS_NUMBERS,
  );
}

function createDeletionJobsRepository(session: FirestoreSession): CustomerDeletionJobsRepository {
  const collection = () => session.db.collection(CUSTOMER_DELETION_JOBS_COLLECTION);
  const ref = (deletionId: string) => collection().doc(deletionId);

  return {
    async get(deletionId) {
      return decodeDeletionJob(await session.read("jobs.deletions.get", ref(deletionId)));
    },

    async listForUid(uid) {
      const snapshot = await session.query("jobs.deletions.listForUid", collection().where("uid", "==", uid));
      return snapshot.docs.map(decodeDeletionJob).filter(isPresent);
    },

    async create(job) {
      await session.create("jobs.deletions.create", deletionKey(job.deletionId), ref(job.deletionId), encodeDeletionJob(job));
    },

    async patch(deletionId, patch, fence) {
      const name = "jobs.deletions.patch";
      const key = deletionKey(deletionId);
      const data = encodeDeletionPatch(patch);
      if (fence?.revision === undefined && fence?.status === undefined) {
        await session.update(name, key, ref(deletionId), data);
        return;
      }
      await session.atomically(name, async (fenced) => {
        const current = decodeDeletionJob(await fenced.readForFence(name, ref(deletionId)));
        if (current === null) throw new MissingRecordError(key);
        assertRevisionFence(key, fence.revision, current.revision);
        assertFenceOneOf(key, "status", fence.status, current.status);
        await fenced.update(name, key, ref(deletionId), data);
      });
    },

    async recordRetiredGatewayProof(deletionId, gatewayId, proof) {
      if (!GATEWAY_ID_SEGMENT.test(gatewayId)) {
        throw new TypeError(`jobs.deletions.recordRetiredGatewayProof: ${JSON.stringify(gatewayId)} cannot name a map key`);
      }
      await session.update(
        "jobs.deletions.recordRetiredGatewayProof",
        deletionKey(deletionId),
        ref(deletionId),
        encodePatch({ [gatewayId]: proof }, STORED_AS_NUMBERS, "retiredGatewayProofs"),
      );
    },
  };
}

function decodeArchive(snapshot: DocumentSnapshot): AnonymousOperationalArchive {
  const data = decodeDocumentData(snapshot);
  const fields = new FirestoreFields(archiveKey(snapshot.id), data);
  const { archivedAt: _archivedAt, ...record } = data;
  return { id: snapshot.id, archivedAt: fields.number("archivedAt"), record };
}

function assertNoArchivedAt(operation: string, record: OpaqueMap): void {
  if ("archivedAt" in record) throw new TypeError(`${operation}: archivedAt is a typed field and cannot appear in the record`);
}

function createArchivesRepository(session: FirestoreSession): AnonymousOperationalArchivesRepository {
  const collection = () => session.db.collection(ANONYMOUS_OPERATIONAL_ARCHIVES_COLLECTION);

  return {
    async create(archive) {
      assertNoArchivedAt("jobs.archives.create", archive.record);
      const doc = collection().doc();
      await session.create(
        "jobs.archives.create",
        archiveKey(doc.id),
        doc,
        encodeDocument({ ...archive.record, archivedAt: archive.archivedAt }, STORED_AS_NUMBERS),
      );
      return doc.id;
    },

    async merge(archiveId, record) {
      assertNoArchivedAt("jobs.archives.merge", record);
      await session.merge("jobs.archives.merge", archiveKey(archiveId), collection().doc(archiveId), encodeMergeDocument(record, STORED_AS_NUMBERS));
    },

    async list(page) {
      const name = "jobs.archives.list";
      let query: Query = collection().orderBy("archivedAt", "desc");
      if (page.after !== undefined) {
        const cursor = await session.read(name, collection().doc(page.after));
        if (!cursor.exists) throw new MissingRecordError(archiveKey(page.after));
        query = query.startAfter(cursor);
      }
      const docs = (await session.query(name, query.limit(page.limit + 1))).docs;
      const pageDocs = docs.slice(0, page.limit);
      return {
        items: pageDocs.map(decodeArchive),
        next: docs.length > page.limit ? pageDocs[pageDocs.length - 1].id : null,
      };
    },
  };
}

function isoMillis(key: RecordKey, fields: FirestoreFields, path: string): number {
  const millis = Date.parse(fields.string(path));
  if (Number.isNaN(millis)) throw new MalformedRecordError(key, `${path} must be an ISO-8601 time`);
  return millis;
}

function agentImportFields(uid: string, importId: string, record: OpaqueMap, cleanupAt: number | null): Omit<AgentImportRecord, "record"> {
  const key = agentImportKey(uid, importId);
  const fields = new FirestoreFields(key, record);
  return {
    uid,
    importId,
    kind: fields.value("kind") === EXPORT_RECORD_KIND ? "export" : "import",
    slug: fields.nullableString("slug"),
    status: fields.string("status"),
    importCommit: fields.nullableString("importCommit"),
    cleanupAt,
    createdAt: isoMillis(key, fields, "createdAt"),
    updatedAt: isoMillis(key, fields, "updatedAt"),
  };
}

function agentImportPath(path: string): { uid: string; importId: string } | null {
  const parts = path.split("/");
  if (parts.length !== 4 || parts[0] !== "users" || parts[2] !== "agentImports") return null;
  return { uid: parts[1], importId: parts[3] };
}

function decodeAgentImport(snapshot: DocumentSnapshot): Stored<AgentImportRecord> | null {
  if (!snapshot.exists) return null;
  const location = agentImportPath(snapshot.ref.path);
  if (location === null) {
    throw new MalformedRecordError({ aggregate: "agent-import", key: snapshot.ref.path }, "is not under users/{uid}/agentImports");
  }
  const data = decodeDocumentData(snapshot);
  const cleanup = new FirestoreFields(agentImportKey(location.uid, location.importId), data).nullableNumber("cleanupAt");
  const { cleanupAt: _cleanupAt, ...record } = data;
  return withStoredRevision<AgentImportRecord>(snapshot, {
    ...agentImportFields(location.uid, location.importId, record, cleanup),
    record,
  });
}

function encodeAgentImport(record: AgentImportRecord & { readonly revision?: Revision }): DocumentData {
  if ("cleanupAt" in record.record) {
    throw new TypeError("jobs.agentImports.put: cleanupAt is a typed field and cannot appear in the record");
  }
  const { record: payload, revision: _revision, ...typed } = record;
  const derived = agentImportFields(record.uid, record.importId, payload, record.cleanupAt);
  if (!isDeepStrictEqual(derived, typed)) {
    throw new TypeError(
      `jobs.agentImports.put: typed fields ${JSON.stringify(typed)} disagree with the record, which carries ${JSON.stringify(derived)}`,
    );
  }
  return encodeDocument(
    record.cleanupAt === null ? payload : { ...payload, cleanupAt: record.cleanupAt },
    AGENT_IMPORT_TIMES,
  );
}

function decodeAgentImportPointer(
  uid: string,
  pointer: AgentImportPointerName,
  snapshot: DocumentSnapshot,
): Stored<AgentImportPointer> | null {
  if (!snapshot.exists) return null;
  const key = agentImportPointerKey(uid, pointer);
  const fields = new FirestoreFields(key, decodeDocumentData(snapshot));
  const owner = fields.nullableString("uid");
  if (owner !== null && owner !== uid) throw new MalformedRecordError(key, `uid ${owner} does not own the pointer`);
  const updatedAt = fields.nullableString("updatedAt");
  const updatedAtMillis = updatedAt === null ? null : Date.parse(updatedAt);
  if (updatedAtMillis !== null && Number.isNaN(updatedAtMillis)) {
    throw new MalformedRecordError(key, "updatedAt must be an ISO-8601 time");
  }
  return withStoredRevision<AgentImportPointer>(snapshot, {
    importId: fields.string("id"),
    slug: fields.nullableString("slug"),
    updatedAt: updatedAtMillis,
  });
}

function createAgentImportsRepository(session: FirestoreSession): AgentImportsRepository {
  const userRef = (uid: string) => session.db.collection("users").doc(uid);
  const ref = (uid: string, importId: string) => userRef(uid).collection("agentImports").doc(importId);
  const pointerRef = (uid: string, pointer: AgentImportPointerName): DocumentReference =>
    userRef(uid).collection("agentImportState").doc(pointer);

  return {
    async get(uid, importId) {
      return decodeAgentImport(await session.read("jobs.agentImports.get", ref(uid, importId)));
    },

    async listExpired(now, limit) {
      const query = session.db
        .collectionGroup("agentImports")
        .where("cleanupAt", "<", Timestamp.fromMillis(now))
        .limit(limit);
      return (await session.query("jobs.agentImports.listExpired", query)).docs.map(decodeAgentImport).filter(isPresent);
    },

    async listForUid(uid) {
      const snapshot = await session.query("jobs.agentImports.listForUid", userRef(uid).collection("agentImports"));
      return snapshot.docs.map(decodeAgentImport).filter(isPresent);
    },

    async put(record) {
      await session.set(
        "jobs.agentImports.put",
        agentImportKey(record.uid, record.importId),
        ref(record.uid, record.importId),
        encodeAgentImport(record),
      );
    },

    async delete(uid, importId) {
      await session.delete("jobs.agentImports.delete", agentImportKey(uid, importId), ref(uid, importId));
    },

    async getPointer(uid, pointer) {
      return decodeAgentImportPointer(uid, pointer, await session.read("jobs.agentImports.getPointer", pointerRef(uid, pointer)));
    },

    async putPointer(uid, pointer, value) {
      await session.set("jobs.agentImports.putPointer", agentImportPointerKey(uid, pointer), pointerRef(uid, pointer), {
        id: value.importId,
        ...(value.slug === null ? {} : { uid, slug: value.slug }),
        ...(value.updatedAt === null ? {} : { updatedAt: new Date(value.updatedAt).toISOString() }),
      });
    },

    async deletePointer(uid, pointer) {
      await session.delete("jobs.agentImports.deletePointer", agentImportPointerKey(uid, pointer), pointerRef(uid, pointer));
    },
  };
}

export function createFirestoreJobRepositories(session: FirestoreSession): JobRepositories {
  return {
    deletions: createDeletionJobsRepository(session),
    archives: createArchivesRepository(session),
    agentImports: createAgentImportsRepository(session),
  };
}
