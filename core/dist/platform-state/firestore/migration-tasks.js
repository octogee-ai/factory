import { GLM_MIGRATION_TRANSFER_TASKS_COLLECTION } from "@octogee/shared/types/glm";
import { MalformedRecordError, MissingRecordError } from "../errors.js";
import { assertAbsentFence, assertFenceEquals, assertFenceOneOf, assertRevisionFence } from "./fences.js";
import { decodeDocumentData, encodeDocument, encodePatch, revisionOf, STORED_AS_NUMBERS } from "./values.js";
const TASK_STATUSES = ["running", "succeeded", "failed"];
const TRANSFER_MODES = ["keys", "pre", "final"];
const taskKey = (taskId) => ({ aggregate: "migration-transfer-task", key: taskId });
function isLeasePod(value) {
    if (value === null || typeof value !== "object")
        return false;
    const pod = value;
    return typeof pod.name === "string" && typeof pod.uid === "string";
}
function optional(key, data, field, accepts) {
    const value = data[field];
    if (value === undefined || value === null)
        return null;
    if (!accepts(value))
        throw new MalformedRecordError(key, `${field} is ${JSON.stringify(value)}`);
    return value;
}
const isString = (value) => typeof value === "string";
const isNumber = (value) => typeof value === "number" && Number.isFinite(value);
export function migrationTransferTaskFromData(id, data, revision) {
    const key = taskKey(id);
    const required = (field, accepts) => {
        const value = data[field];
        if (!accepts(value))
            throw new MalformedRecordError(key, `${field} is ${JSON.stringify(value)}`);
        return value;
    };
    return {
        id,
        kind: required("kind", isString),
        migrationId: required("migrationId", isString),
        slug: required("slug", isString),
        mode: required("mode", (value) => TRANSFER_MODES.includes(value)),
        sourceGatewayId: required("sourceGatewayId", isString),
        targetGatewayId: required("targetGatewayId", isString),
        status: required("status", (value) => TASK_STATUSES.includes(value)),
        attempt: required("attempt", isNumber),
        attemptId: required("attemptId", isString),
        leaseOwner: optional(key, data, "leaseOwner", isString),
        leasePod: optional(key, data, "leasePod", isLeasePod),
        leaseExpiresAt: optional(key, data, "leaseExpiresAt", isNumber),
        leaseRestartCount: optional(key, data, "leaseRestartCount", isNumber),
        createdAt: required("createdAt", isNumber),
        updatedAt: required("updatedAt", isNumber),
        startedAt: required("startedAt", isNumber),
        completedAt: optional(key, data, "completedAt", isNumber),
        error: optional(key, data, "error", isString),
        revision,
    };
}
export function decodeMigrationTransferTask(snapshot) {
    if (!snapshot.exists)
        return null;
    return migrationTransferTaskFromData(snapshot.id, decodeDocumentData(snapshot), revisionOf(snapshot));
}
function encodeTask(task) {
    const present = Object.fromEntries(Object.entries(task).filter(([, value]) => value !== null));
    return encodeDocument(present, STORED_AS_NUMBERS, ["id", "revision"]);
}
function statusQuery(collection, statuses) {
    return statuses.length === 1 ? collection.where("status", "==", statuses[0]) : collection.where("status", "in", statuses);
}
function isPresent(value) {
    return value !== null;
}
export function createFirestoreMigrationTasksRepository(session) {
    const collection = () => session.db.collection(GLM_MIGRATION_TRANSFER_TASKS_COLLECTION);
    const ref = (taskId) => collection().doc(taskId);
    return {
        async get(taskId) {
            return decodeMigrationTransferTask(await session.read("migrationTasks.get", ref(taskId)));
        },
        async listByStatus(statuses) {
            if (statuses.length === 0)
                return [];
            const snapshot = await session.query("migrationTasks.listByStatus", statusQuery(collection(), statuses));
            return snapshot.docs.map(decodeMigrationTransferTask).filter(isPresent);
        },
        async claim(task, expected) {
            const name = "migrationTasks.claim";
            const key = taskKey(task.id);
            await session.atomically(name, async (fenced) => {
                const snapshot = await fenced.readForFence(name, ref(task.id));
                const existing = snapshot.exists ? revisionOf(snapshot) : null;
                if (expected === "absent") {
                    assertAbsentFence(key, existing);
                }
                else {
                    if (existing === null)
                        throw new MissingRecordError(key);
                    assertRevisionFence(key, expected, existing);
                }
                await fenced.set(name, key, ref(task.id), encodeTask(task));
            });
        },
        async finish(taskId, claim, completedAt, error) {
            const name = "migrationTasks.finish";
            const key = taskKey(taskId);
            await session.atomically(name, async (fenced) => {
                const current = decodeMigrationTransferTask(await fenced.readForFence(name, ref(taskId)));
                if (current === null)
                    throw new MissingRecordError(key);
                assertFenceOneOf(key, "status", ["running"], current.status);
                assertFenceEquals(key, "attemptId", claim, {
                    attempt: current.attempt,
                    attemptId: current.attemptId,
                    leaseOwner: current.leaseOwner,
                });
                const clear = { clear: true };
                await fenced.update(name, key, ref(taskId), encodePatch({
                    status: error === null ? "succeeded" : "failed",
                    completedAt,
                    updatedAt: completedAt,
                    leaseOwner: clear,
                    leasePod: clear,
                    leaseRestartCount: clear,
                    leaseExpiresAt: clear,
                    error: error ?? clear,
                }, STORED_AS_NUMBERS));
            });
        },
    };
}
export const firestoreMigrationTasksWatchSource = (db, filter) => {
    const collection = db.collection(GLM_MIGRATION_TRANSFER_TASKS_COLLECTION);
    const statuses = filter.statuses;
    return {
        operation: "watch migrationTasks",
        targets: statuses !== undefined && statuses.length === 0
            ? []
            : [
                {
                    query: statuses === undefined ? collection : statusQuery(collection, statuses),
                    key: (snapshot) => snapshot.id,
                    decode: decodeMigrationTransferTask,
                },
            ],
    };
};
