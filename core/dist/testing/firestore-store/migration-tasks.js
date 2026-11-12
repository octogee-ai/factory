import { GLM_MIGRATION_TRANSFER_TASKS_COLLECTION } from "@octogee/shared/types/glm";
import { MissingRecordError } from "../../platform-state/errors.js";
import { assertAbsentFence, assertFenceEquals, assertFenceOneOf } from "../../platform-state/documents/fences.js";
import { assertRevisionFence } from "./fences.js";
import { STORED_AS_NUMBERS, decodeDocumentData, encodeDocument, encodePatch, revisionOf } from "./values.js";
import { migrationTransferTaskFromData, taskKey } from "../../platform-state/documents/migration-tasks.js";
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
