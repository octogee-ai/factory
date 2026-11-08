import { isDeepStrictEqual } from "node:util";
import { MalformedRecordError, MissingRecordError } from "../errors.js";
import { mintOperationId } from "./journal.js";
import { deleteRecord, insertRecord, oneOfFence, revisionFence, selectByKey, selectRecords, serverNow, updateRecord, } from "./records.js";
import { SqlParameters } from "./sql.js";
import { column, columnFor, containsServerNow, decodeStored, resolveJsonValue } from "./values.js";
import { resolveMergeValue } from "./workspaces.js";
const GATEWAY_ID_SEGMENT = /^[A-Za-z0-9_-]+$/;
const EXPORT_RECORD_KIND = "authored-agent-export";
const nullable = { nullAs: "null" };
const DELETION_JOBS_TABLE = {
    table: "customer_deletion_jobs",
    aggregate: "customer-deletion-job",
    keyColumns: ["deletion_id"],
    columns: [
        column("deletionId", "text"),
        column("version", "integer"),
        column("uid", "text"),
        column("slug", "text", nullable),
        column("status", "text"),
        column("requestedBy", "text"),
        column("requestedAt", "bigint"),
        column("eraseAfter", "bigint"),
        column("currentGatewayId", "text", nullable),
        column("erasureOperationId", "text"),
        column("suspensionOperationId", "text"),
        column("cleanupContext", "jsonb"),
        column("postgresAgentStoreTargets", "jsonb"),
        column("sharedAgentStoreCleanup", "jsonb"),
        column("retiredGatewayProofs", "jsonb"),
        column("archiveId", "text"),
        column("productContext", "jsonb"),
        column("suspendedAt", "bigint"),
        column("cloudErasedAt", "bigint"),
        column("verifiedAt", "bigint"),
        column("completedAt", "bigint"),
        column("updatedAt", "bigint"),
    ],
    immutableFields: ["deletionId", "version", "requestedAt"],
};
const ARCHIVES_TABLE = {
    table: "anonymous_operational_archives",
    aggregate: "anonymous-operational-archive",
    keyColumns: ["id"],
    columns: [column("id", "text"), column("archivedAt", "bigint"), column("record", "jsonb")],
};
const AGENT_IMPORTS_TABLE = {
    table: "agent_imports",
    aggregate: "agent-import",
    keyColumns: ["uid", "import_id"],
    columns: [
        column("uid", "text"),
        column("importId", "text"),
        column("kind", "text"),
        column("slug", "text", nullable),
        column("status", "text"),
        column("importCommit", "text", nullable),
        column("cleanupAt", "bigint", nullable),
        column("createdAt", "bigint"),
        column("updatedAt", "bigint"),
        column("record", "jsonb"),
    ],
};
const AGENT_IMPORT_POINTERS_TABLE = {
    table: "agent_import_pointers",
    aggregate: "agent-import-pointer",
    keyColumns: ["uid", "pointer"],
    columns: [
        column("uid", "text"),
        column("pointer", "text"),
        column("importId", "text"),
        column("slug", "text", nullable),
        column("updatedAt", "bigint", nullable),
    ],
};
const deletionKey = (deletionId) => ({ aggregate: "customer-deletion-job", key: deletionId });
const archiveKey = (archiveId) => ({ aggregate: "anonymous-operational-archive", key: archiveId });
const agentImportKey = (uid, importId) => ({ aggregate: "agent-import", key: `${uid}/${importId}` });
const DELETION_STATUS = columnFor(DELETION_JOBS_TABLE, deletionKey(""), "status");
function decodeDeletionJob(row) {
    return decodeStored(DELETION_JOBS_TABLE, row);
}
function createDeletionJobsRepository(session) {
    return {
        async get(deletionId) {
            const row = await selectByKey(session, "jobs.deletions.get", { table: DELETION_JOBS_TABLE, key: [deletionId] });
            return row === null ? null : decodeDeletionJob(row);
        },
        async listForUid(uid) {
            const rows = await selectRecords(session, "jobs.deletions.listForUid", "SELECT * FROM $schema.customer_deletion_jobs WHERE uid = $1::text ORDER BY deletion_id", [uid]);
            return rows.map(decodeDeletionJob);
        },
        async create(job) {
            await insertRecord(session, "jobs.deletions.create", DELETION_JOBS_TABLE, job, "create");
        },
        async patch(deletionId, patch, fence) {
            await updateRecord(session, "jobs.deletions.patch", { table: DELETION_JOBS_TABLE, key: [deletionId] }, patch, [
                ...revisionFence(fence?.revision),
                ...oneOfFence("status", DELETION_STATUS, fence?.status),
            ]);
        },
        async recordRetiredGatewayProof(deletionId, gatewayId, proof) {
            const operation = "jobs.deletions.recordRetiredGatewayProof";
            if (!GATEWAY_ID_SEGMENT.test(gatewayId))
                throw new TypeError(`${operation}: ${JSON.stringify(gatewayId)} cannot name a map key`);
            const now = containsServerNow(proof) ? await serverNow(session) : undefined;
            const record = deletionKey(deletionId);
            const rows = await session.write(operation, record, `UPDATE $schema.customer_deletion_jobs
            SET retired_gateway_proofs = COALESCE(retired_gateway_proofs, '{}'::jsonb) || jsonb_build_object($2::text, $3::jsonb)
          WHERE deletion_id = $1::text
          RETURNING revision`, [deletionId, gatewayId, JSON.stringify(resolveJsonValue(proof, now, "reject", "proof"))]);
            if (rows.length === 0)
                throw new MissingRecordError(record);
        },
    };
}
function assertNoArchivedAt(operation, record) {
    if ("archivedAt" in record)
        throw new TypeError(`${operation}: archivedAt is a typed field and cannot appear in the record`);
}
function decodeArchive(row) {
    const { revision: _revision, ...archive } = decodeStored(ARCHIVES_TABLE, row);
    return archive;
}
function createArchivesRepository(session) {
    return {
        async create(archive) {
            assertNoArchivedAt("jobs.archives.create", archive.record);
            const id = mintOperationId();
            await insertRecord(session, "jobs.archives.create", ARCHIVES_TABLE, { id, ...archive }, "create");
            return id;
        },
        async merge(archiveId, record) {
            const operation = "jobs.archives.merge";
            assertNoArchivedAt(operation, record);
            const now = containsServerNow(record) ? await serverNow(session) : undefined;
            const key = archiveKey(archiveId);
            const rows = await session.write(operation, key, `UPDATE $schema.anonymous_operational_archives SET record = $schema.jsonb_merge_deep(record, $2::jsonb)
          WHERE id = $1::text RETURNING revision`, [archiveId, JSON.stringify(resolveMergeValue(record, now, "record"))]);
            if (rows.length === 0)
                throw new MissingRecordError(key);
        },
        async list(page) {
            const operation = "jobs.archives.list";
            const parameters = new SqlParameters();
            const limit = parameters.add(page.limit + 1, "integer");
            let after = "";
            if (page.after !== undefined) {
                const anchor = await selectByKey(session, operation, { table: ARCHIVES_TABLE, key: [page.after] });
                if (anchor === null)
                    throw new MissingRecordError(archiveKey(page.after));
                after = `WHERE (archived_at, id) < (${parameters.add(anchor.archived_at, "bigint")}, ${parameters.add(page.after, "text")})`;
            }
            const rows = await selectRecords(session, operation, `SELECT * FROM $schema.anonymous_operational_archives ${after} ORDER BY archived_at DESC, id DESC LIMIT ${limit}`, parameters.values);
            const items = rows.slice(0, page.limit).map(decodeArchive);
            return { items, next: rows.length > page.limit ? items[items.length - 1].id : null };
        },
    };
}
function recordString(key, record, field) {
    const value = record[field];
    if (typeof value !== "string")
        throw new MalformedRecordError(key, `${field} must be a string, found ${JSON.stringify(value) ?? "absent"}`);
    return value;
}
function recordNullableString(key, record, field) {
    const value = record[field];
    if (value === undefined || value === null)
        return null;
    return recordString(key, record, field);
}
function recordIsoMillis(key, record, field) {
    const millis = Date.parse(recordString(key, record, field));
    if (Number.isNaN(millis))
        throw new MalformedRecordError(key, `${field} must be an ISO-8601 time`);
    return millis;
}
function assertTypedImportFields(record) {
    const operation = "jobs.agentImports.put";
    if ("cleanupAt" in record.record)
        throw new TypeError(`${operation}: cleanupAt is a typed field and cannot appear in the record`);
    const { record: payload, revision: _revision, ...typed } = record;
    const key = agentImportKey(record.uid, record.importId);
    const derived = {
        uid: record.uid,
        importId: record.importId,
        kind: payload.kind === EXPORT_RECORD_KIND ? "export" : "import",
        slug: recordNullableString(key, payload, "slug"),
        status: recordString(key, payload, "status"),
        importCommit: recordNullableString(key, payload, "importCommit"),
        cleanupAt: record.cleanupAt,
        createdAt: recordIsoMillis(key, payload, "createdAt"),
        updatedAt: recordIsoMillis(key, payload, "updatedAt"),
    };
    if (!isDeepStrictEqual(derived, typed)) {
        throw new TypeError(`${operation}: typed fields ${JSON.stringify(typed)} disagree with the record, which carries ${JSON.stringify(derived)}`);
    }
}
function decodeAgentImport(row) {
    return decodeStored(AGENT_IMPORTS_TABLE, row);
}
function decodeAgentImportPointer(row) {
    const { importId, slug, updatedAt, revision } = decodeStored(AGENT_IMPORT_POINTERS_TABLE, row);
    return { importId, slug, updatedAt, revision };
}
function pointerTarget(uid, pointer) {
    return { table: AGENT_IMPORT_POINTERS_TABLE, key: [uid, pointer] };
}
function createAgentImportsRepository(session) {
    const list = async (operation, text, values) => (await selectRecords(session, operation, text, values)).map(decodeAgentImport);
    return {
        async get(uid, importId) {
            const row = await selectByKey(session, "jobs.agentImports.get", { table: AGENT_IMPORTS_TABLE, key: [uid, importId] });
            return row === null ? null : decodeAgentImport(row);
        },
        listExpired(now, limit) {
            return list("jobs.agentImports.listExpired", `SELECT * FROM $schema.agent_imports WHERE cleanup_at IS NOT NULL AND cleanup_at < $1::bigint
          ORDER BY cleanup_at, uid, import_id LIMIT $2::integer`, [now, limit]);
        },
        listForUid(uid) {
            return list("jobs.agentImports.listForUid", "SELECT * FROM $schema.agent_imports WHERE uid = $1::text ORDER BY import_id", [uid]);
        },
        async put(record) {
            assertTypedImportFields(record);
            await insertRecord(session, "jobs.agentImports.put", AGENT_IMPORTS_TABLE, record, "put");
        },
        async delete(uid, importId) {
            await deleteRecord(session, "jobs.agentImports.delete", { table: AGENT_IMPORTS_TABLE, key: [uid, importId] });
        },
        async getPointer(uid, pointer) {
            const row = await selectByKey(session, "jobs.agentImports.getPointer", pointerTarget(uid, pointer));
            return row === null ? null : decodeAgentImportPointer(row);
        },
        async putPointer(uid, pointer, value) {
            await insertRecord(session, "jobs.agentImports.putPointer", AGENT_IMPORT_POINTERS_TABLE, { uid, pointer, ...value }, "put");
        },
        async deletePointer(uid, pointer) {
            await deleteRecord(session, "jobs.agentImports.deletePointer", pointerTarget(uid, pointer));
        },
    };
}
export function createPostgresJobRepositories(session) {
    return {
        deletions: createDeletionJobsRepository(session),
        archives: createArchivesRepository(session),
        agentImports: createAgentImportsRepository(session),
    };
}
