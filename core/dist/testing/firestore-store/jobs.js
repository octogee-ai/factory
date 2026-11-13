import { Timestamp } from "firebase-admin/firestore";
import { ANONYMOUS_OPERATIONAL_ARCHIVES_COLLECTION, USER_DELETION_JOBS_COLLECTION } from "@octogee/shared/types/account-lifecycle";
import { MalformedRecordError, MissingRecordError } from "../../platform-state/errors.js";
import { assertFenceOneOf } from "../../platform-state/documents/fences.js";
import { assertRevisionFence } from "./fences.js";
import { STORED_AS_NUMBERS, decodeDocumentData, encodeDocument, encodeMergeDocument, encodePatch, isClearField, storedAsTimestamps } from "./values.js";
import { FirestoreFields } from "../../platform-state/documents/workspaces.js";
import { withStoredRevision } from "./workspaces.js";
import { STORED_PRODUCT_VERIFICATION_STATUS, agentImportDocument, agentImportKey, agentImportPointerDocument, agentImportPointerFromData, agentImportPointerKey, agentImportRecordFromData, anonymousArchiveFromData, archiveKey, storedDeletionStatus } from "../../platform-state/documents/jobs.js";
const PRODUCT_CONTEXT_FIELDS = ["stripeCustomerIds", "stripeSubscriptionIds", "posthogErasure"];
const DELETION_STATUSES = [
    "suspension_pending",
    "suspending",
    "hibernating",
    "product_verification_pending",
    "verified_pending_completion",
    "verified",
];
const OPTIONAL_DELETION_STRINGS = ["uid", "requestedBy", "erasureOperationId", "suspensionOperationId", "archiveId"];
const OPTIONAL_DELETION_NULLABLE_STRINGS = ["slug", "currentGatewayId"];
const OPTIONAL_DELETION_MAPS = ["cleanupContext", "sharedAgentStoreCleanup", "retiredGatewayProofs"];
const OPTIONAL_DELETION_TIMES = ["suspendedAt", "cloudErasedAt", "verifiedAt", "completedAt", "updatedAt"];
const GATEWAY_ID_SEGMENT = /^[A-Za-z0-9_-]+$/;
const AGENT_IMPORT_TIMES = storedAsTimestamps("cleanupAt");
const CLEAR = { clear: true };
function isPlainObject(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}
function isPresent(value) {
    return value !== null;
}
const deletionKey = (deletionId) => ({ aggregate: "customer-deletion-job", key: deletionId });
const STORED_DELETION_STATUSES = DELETION_STATUSES.map(storedDeletionStatus);
function domainDeletionStatus(fields) {
    const stored = fields.oneOf("status", STORED_DELETION_STATUSES);
    return stored === STORED_PRODUCT_VERIFICATION_STATUS ? "product_verification_pending" : stored;
}
function decodeDeletionJob(snapshot) {
    if (!snapshot.exists)
        return null;
    const key = deletionKey(snapshot.id);
    const data = decodeDocumentData(snapshot);
    const fields = new FirestoreFields(key, data);
    if (fields.value("version") !== 1)
        throw new MalformedRecordError(key, "version must be 1");
    const job = {
        deletionId: snapshot.id,
        version: 1,
        status: domainDeletionStatus(fields),
        requestedAt: fields.number("requestedAt"),
        eraseAfter: fields.number("eraseAfter"),
    };
    for (const field of OPTIONAL_DELETION_STRINGS)
        if (field in data)
            job[field] = fields.string(field);
    for (const field of OPTIONAL_DELETION_NULLABLE_STRINGS)
        if (field in data)
            job[field] = fields.nullableString(field);
    for (const field of OPTIONAL_DELETION_TIMES)
        if (field in data)
            job[field] = fields.number(field);
    for (const field of OPTIONAL_DELETION_MAPS)
        if (field in data)
            job[field] = fields.map(field);
    if ("postgresAgentStoreTargets" in data) {
        const targets = data.postgresAgentStoreTargets;
        if (!Array.isArray(targets) || !targets.every(isPlainObject)) {
            throw new MalformedRecordError(key, "postgresAgentStoreTargets must be a list of maps");
        }
        job.postgresAgentStoreTargets = targets;
    }
    const productContext = Object.fromEntries(PRODUCT_CONTEXT_FIELDS.filter((field) => field in data).map((field) => [field, data[field]]));
    if (Object.keys(productContext).length > 0)
        job.productContext = productContext;
    return withStoredRevision(snapshot, job);
}
function assertProductContextFields(operation, productContext) {
    const unknown = Object.keys(productContext).filter((field) => !PRODUCT_CONTEXT_FIELDS.includes(field));
    if (unknown.length > 0) {
        throw new TypeError(`${operation}: product context fields ${unknown.join(", ")} have no Firestore mapping; allowed: ${PRODUCT_CONTEXT_FIELDS.join(", ")}`);
    }
}
function encodeDeletionJob(job) {
    const { deletionId: _deletionId, productContext, status, ...fields } = job;
    if (productContext !== undefined)
        assertProductContextFields("jobs.deletions.create", productContext);
    return encodeDocument({ ...fields, ...productContext, status: storedDeletionStatus(status) }, STORED_AS_NUMBERS, ["revision"]);
}
function productContextPatch(productContext) {
    if (isClearField(productContext))
        return Object.fromEntries(PRODUCT_CONTEXT_FIELDS.map((field) => [field, CLEAR]));
    assertProductContextFields("jobs.deletions.patch", productContext);
    return Object.fromEntries(PRODUCT_CONTEXT_FIELDS.map((field) => [field, field in productContext ? productContext[field] : CLEAR]));
}
function encodeDeletionPatch(patch) {
    const { productContext, status, ...rest } = patch;
    return encodePatch({
        ...rest,
        ...(status === undefined ? {} : { status: storedDeletionStatus(status) }),
        ...(productContext === undefined ? {} : productContextPatch(productContext)),
    }, STORED_AS_NUMBERS);
}
function createDeletionJobsRepository(session) {
    const collection = () => session.db.collection(USER_DELETION_JOBS_COLLECTION);
    const ref = (deletionId) => collection().doc(deletionId);
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
                if (current === null)
                    throw new MissingRecordError(key);
                assertRevisionFence(key, fence.revision, current.revision);
                assertFenceOneOf(key, "status", fence.status, current.status);
                await fenced.update(name, key, ref(deletionId), data);
            });
        },
        async recordRetiredGatewayProof(deletionId, gatewayId, proof) {
            if (!GATEWAY_ID_SEGMENT.test(gatewayId)) {
                throw new TypeError(`jobs.deletions.recordRetiredGatewayProof: ${JSON.stringify(gatewayId)} cannot name a map key`);
            }
            await session.update("jobs.deletions.recordRetiredGatewayProof", deletionKey(deletionId), ref(deletionId), encodePatch({ [gatewayId]: proof }, STORED_AS_NUMBERS, "retiredGatewayProofs"));
        },
    };
}
function decodeArchive(snapshot) {
    return anonymousArchiveFromData(snapshot.id, decodeDocumentData(snapshot));
}
function assertNoArchivedAt(operation, record) {
    if ("archivedAt" in record)
        throw new TypeError(`${operation}: archivedAt is a typed field and cannot appear in the record`);
}
function createArchivesRepository(session) {
    const collection = () => session.db.collection(ANONYMOUS_OPERATIONAL_ARCHIVES_COLLECTION);
    return {
        async create(archive) {
            assertNoArchivedAt("jobs.archives.create", archive.record);
            const doc = collection().doc();
            await session.create("jobs.archives.create", archiveKey(doc.id), doc, encodeDocument({ ...archive.record, archivedAt: archive.archivedAt }, STORED_AS_NUMBERS));
            return doc.id;
        },
        async merge(archiveId, record) {
            assertNoArchivedAt("jobs.archives.merge", record);
            await session.merge("jobs.archives.merge", archiveKey(archiveId), collection().doc(archiveId), encodeMergeDocument(record, STORED_AS_NUMBERS));
        },
        async list(page) {
            const name = "jobs.archives.list";
            let query = collection().orderBy("archivedAt", "desc");
            if (page.after !== undefined) {
                const cursor = await session.read(name, collection().doc(page.after));
                if (!cursor.exists)
                    throw new MissingRecordError(archiveKey(page.after));
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
function agentImportPath(path) {
    const parts = path.split("/");
    if (parts.length !== 4 || parts[0] !== "users" || parts[2] !== "agentImports")
        return null;
    return { uid: parts[1], importId: parts[3] };
}
function decodeAgentImport(snapshot) {
    if (!snapshot.exists)
        return null;
    const location = agentImportPath(snapshot.ref.path);
    if (location === null) {
        throw new MalformedRecordError({ aggregate: "agent-import", key: snapshot.ref.path }, "is not under users/{uid}/agentImports");
    }
    return withStoredRevision(snapshot, agentImportRecordFromData(location.uid, location.importId, decodeDocumentData(snapshot)));
}
function decodeAgentImportPointer(uid, pointer, snapshot) {
    if (!snapshot.exists)
        return null;
    return withStoredRevision(snapshot, agentImportPointerFromData(uid, pointer, decodeDocumentData(snapshot)));
}
function createAgentImportsRepository(session) {
    const userRef = (uid) => session.db.collection("users").doc(uid);
    const ref = (uid, importId) => userRef(uid).collection("agentImports").doc(importId);
    const pointerRef = (uid, pointer) => userRef(uid).collection("agentImportState").doc(pointer);
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
            await session.set("jobs.agentImports.put", agentImportKey(record.uid, record.importId), ref(record.uid, record.importId), encodeDocument(agentImportDocument(record), AGENT_IMPORT_TIMES));
        },
        async delete(uid, importId) {
            await session.delete("jobs.agentImports.delete", agentImportKey(uid, importId), ref(uid, importId));
        },
        async getPointer(uid, pointer) {
            return decodeAgentImportPointer(uid, pointer, await session.read("jobs.agentImports.getPointer", pointerRef(uid, pointer)));
        },
        async putPointer(uid, pointer, value) {
            await session.set("jobs.agentImports.putPointer", agentImportPointerKey(uid, pointer), pointerRef(uid, pointer), agentImportPointerDocument(uid, value));
        },
        async deletePointer(uid, pointer) {
            await session.delete("jobs.agentImports.deletePointer", agentImportPointerKey(uid, pointer), pointerRef(uid, pointer));
        },
    };
}
export function createFirestoreJobRepositories(session) {
    return {
        deletions: createDeletionJobsRepository(session),
        archives: createArchivesRepository(session),
        agentImports: createAgentImportsRepository(session),
    };
}
