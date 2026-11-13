import { isDeepStrictEqual } from "node:util";
import { MalformedRecordError } from "../errors.js";
import { FirestoreFields } from "./workspaces.js";
export const STORED_PRODUCT_VERIFICATION_STATUS = "posthog_verification_pending";
export const EXPORT_RECORD_KIND = "authored-agent-export";
export const archiveKey = (archiveId) => ({ aggregate: "anonymous-operational-archive", key: archiveId });
export const agentImportKey = (uid, importId) => ({ aggregate: "agent-import", key: `${uid}/${importId}` });
export const agentImportPointerKey = (uid, pointer) => ({
    aggregate: "agent-import-pointer",
    key: `${uid}/${pointer}`,
});
export function storedDeletionStatus(status) {
    return status === "product_verification_pending" ? STORED_PRODUCT_VERIFICATION_STATUS : status;
}
export function anonymousArchiveFromData(id, data) {
    const fields = new FirestoreFields(archiveKey(id), data);
    const { archivedAt: _archivedAt, ...record } = data;
    return { id, archivedAt: fields.number("archivedAt"), record };
}
export function isoMillis(key, fields, path) {
    const millis = Date.parse(fields.string(path));
    if (Number.isNaN(millis))
        throw new MalformedRecordError(key, `${path} must be an ISO-8601 time`);
    return millis;
}
export function agentImportFields(uid, importId, record, cleanupAt) {
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
export function agentImportRecordFromPayload(uid, importId, payload, cleanupAt) {
    return { ...agentImportFields(uid, importId, payload, cleanupAt), record: payload };
}
export function agentImportRecordFromData(uid, importId, data) {
    const cleanupAt = new FirestoreFields(agentImportKey(uid, importId), data).nullableNumber("cleanupAt");
    const { cleanupAt: _cleanupAt, ...record } = data;
    return agentImportRecordFromPayload(uid, importId, record, cleanupAt);
}
export function agentImportDocument(record) {
    if ("cleanupAt" in record.record) {
        throw new TypeError("jobs.agentImports.put: cleanupAt is a typed field and cannot appear in the record");
    }
    const { record: payload, revision: _revision, ...typed } = record;
    const derived = agentImportFields(record.uid, record.importId, payload, record.cleanupAt);
    if (!isDeepStrictEqual(derived, typed)) {
        throw new TypeError(`jobs.agentImports.put: typed fields ${JSON.stringify(typed)} disagree with the record, which carries ${JSON.stringify(derived)}`);
    }
    return record.cleanupAt === null ? { ...payload } : { ...payload, cleanupAt: record.cleanupAt };
}
export function agentImportPointerFromData(uid, pointer, data) {
    const key = agentImportPointerKey(uid, pointer);
    const fields = new FirestoreFields(key, data);
    const owner = fields.nullableString("uid");
    if (owner !== null && owner !== uid)
        throw new MalformedRecordError(key, `uid ${owner} does not own the pointer`);
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
export function agentImportPointerDocument(uid, value) {
    return {
        id: value.importId,
        ...(value.slug === null ? {} : { uid, slug: value.slug }),
        ...(value.updatedAt === null ? {} : { updatedAt: new Date(value.updatedAt).toISOString() }),
    };
}
