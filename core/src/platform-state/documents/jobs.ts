import { isDeepStrictEqual } from "node:util";
import { MalformedRecordError, type RecordKey } from "../errors.js";
import type { AgentImportPointer, AgentImportPointerName, AgentImportRecord, AnonymousOperationalArchive, UserDeletionJobStatus } from "../jobs.js";
import type { OpaqueMap, Revision } from "../store.js";
import { FirestoreFields } from "./workspaces.js";

export const STORED_PRODUCT_VERIFICATION_STATUS = "posthog_verification_pending";
export const EXPORT_RECORD_KIND = "authored-agent-export";
export type PlainObject = Record<string, unknown>;

export const archiveKey = (archiveId: string): RecordKey => ({ aggregate: "anonymous-operational-archive", key: archiveId });
export const agentImportKey = (uid: string, importId: string): RecordKey => ({ aggregate: "agent-import", key: `${uid}/${importId}` });
export const agentImportPointerKey = (uid: string, pointer: AgentImportPointerName): RecordKey => ({
  aggregate: "agent-import-pointer",
  key: `${uid}/${pointer}`,
});

export function storedDeletionStatus(status: UserDeletionJobStatus): string {
  return status === "product_verification_pending" ? STORED_PRODUCT_VERIFICATION_STATUS : status;
}

export function anonymousArchiveFromData(id: string, data: Record<string, unknown>): AnonymousOperationalArchive {
  const fields = new FirestoreFields(archiveKey(id), data);
  const { archivedAt: _archivedAt, ...record } = data;
  return { id, archivedAt: fields.number("archivedAt"), record };
}

export function isoMillis(key: RecordKey, fields: FirestoreFields, path: string): number {
  const millis = Date.parse(fields.string(path));
  if (Number.isNaN(millis)) throw new MalformedRecordError(key, `${path} must be an ISO-8601 time`);
  return millis;
}

export function agentImportFields(uid: string, importId: string, record: OpaqueMap, cleanupAt: number | null): Omit<AgentImportRecord, "record"> {
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

export function agentImportRecordFromPayload(
  uid: string,
  importId: string,
  payload: OpaqueMap,
  cleanupAt: number | null,
): AgentImportRecord {
  return { ...agentImportFields(uid, importId, payload, cleanupAt), record: payload };
}

export function agentImportRecordFromData(uid: string, importId: string, data: PlainObject): AgentImportRecord {
  const cleanupAt = new FirestoreFields(agentImportKey(uid, importId), data).nullableNumber("cleanupAt");
  const { cleanupAt: _cleanupAt, ...record } = data;
  return agentImportRecordFromPayload(uid, importId, record, cleanupAt);
}

export function agentImportDocument(record: AgentImportRecord & { readonly revision?: Revision }): PlainObject {
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
  return record.cleanupAt === null ? { ...payload } : { ...payload, cleanupAt: record.cleanupAt };
}

export function agentImportPointerFromData(uid: string, pointer: AgentImportPointerName, data: PlainObject): AgentImportPointer {
  const key = agentImportPointerKey(uid, pointer);
  const fields = new FirestoreFields(key, data);
  const owner = fields.nullableString("uid");
  if (owner !== null && owner !== uid) throw new MalformedRecordError(key, `uid ${owner} does not own the pointer`);
  const updatedAt = fields.nullableString("updatedAt");
  const updatedAtMillis = updatedAt === null ? null : Date.parse(updatedAt);
  if (updatedAtMillis !== null && Number.isNaN(updatedAtMillis)) {
    throw new MalformedRecordError(key, "updatedAt must be an ISO-8601 time");
  }
  return {
    importId: fields.string("id"),
    slug: fields.nullableString("slug"),
    updatedAt: updatedAtMillis,
  };
}

export function agentImportPointerDocument(uid: string, value: AgentImportPointer): PlainObject {
  return {
    id: value.importId,
    ...(value.slug === null ? {} : { uid, slug: value.slug }),
    ...(value.updatedAt === null ? {} : { updatedAt: new Date(value.updatedAt).toISOString() }),
  };
}
