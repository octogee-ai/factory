import { FenceMismatchError, MissingRecordError } from "../errors.js";
import { upsertRecord } from "./fleet-registry.js";
import { revisionFence, selectByKey, selectRecords, updateRecord } from "./records.js";
import { column, decodeStored, revisionOf } from "./values.js";
const MIGRATION_TASKS_TABLE = {
    table: "migration_transfer_tasks",
    aggregate: "migration-transfer-task",
    keyColumns: ["id"],
    columns: [
        column("id", "text"),
        column("kind", "text"),
        column("migrationId", "text"),
        column("slug", "text"),
        column("mode", "text"),
        column("sourceGatewayId", "text"),
        column("targetGatewayId", "text"),
        column("status", "text"),
        column("attempt", "integer"),
        column("attemptId", "text"),
        column("leaseOwner", "text", { nullAs: "null" }),
        column("leasePodName", "text"),
        column("leasePodUid", "text"),
        column("leaseExpiresAt", "bigint", { nullAs: "null" }),
        column("leaseRestartCount", "integer", { nullAs: "null" }),
        column("createdAt", "bigint"),
        column("updatedAt", "bigint"),
        column("startedAt", "bigint"),
        column("completedAt", "bigint", { nullAs: "null" }),
        column("error", "text", { nullAs: "null" }),
    ],
};
const taskKey = (taskId) => ({ aggregate: "migration-transfer-task", key: taskId });
function taskColumns(task) {
    const { leasePod, revision: _revision, ...fields } = task;
    return { ...fields, leasePodName: leasePod?.name ?? null, leasePodUid: leasePod?.uid ?? null };
}
export function decodeMigrationTransferTask(row) {
    const { leasePodName, leasePodUid, ...task } = decodeStored(MIGRATION_TASKS_TABLE, row);
    const leasePod = leasePodName === undefined ? null : { name: leasePodName, uid: leasePodUid };
    return { ...task, leasePod };
}
async function claimAbsentTask(session, operation, task) {
    const key = taskKey(task.id);
    await session.atomically(operation, async (fenced) => {
        const rows = await upsertRecord(fenced, operation, MIGRATION_TASKS_TABLE, taskColumns(task), {});
        if (rows.length > 0)
            return;
        const [existing] = await fenced.execute("SELECT revision FROM $schema.migration_transfer_tasks WHERE id = $1::text", [task.id]);
        throw new FenceMismatchError(key, "absent", "absent", existing === undefined ? null : revisionOf(existing));
    });
}
async function failFinish(session, key, claim) {
    const [current] = await session.execute("SELECT status, attempt, attempt_id, lease_owner FROM $schema.migration_transfer_tasks WHERE id = $1::text", [key.key]);
    if (current === undefined)
        throw new MissingRecordError(key);
    if (current.status !== "running")
        throw new FenceMismatchError(key, "status", ["running"], current.status);
    const held = { attempt: current.attempt, attemptId: current.attempt_id, leaseOwner: current.lease_owner };
    throw new FenceMismatchError(key, "attemptId", claim, held);
}
export function createPostgresMigrationTasksRepository(session) {
    return {
        async get(taskId) {
            const row = await selectByKey(session, "migrationTasks.get", { table: MIGRATION_TASKS_TABLE, key: [taskId] });
            return row === null ? null : decodeMigrationTransferTask(row);
        },
        async listByStatus(statuses) {
            if (statuses.length === 0)
                return [];
            const rows = await selectRecords(session, "migrationTasks.listByStatus", "SELECT * FROM $schema.migration_transfer_tasks WHERE status = ANY($1::text[]) ORDER BY id", [[...statuses]]);
            return rows.map(decodeMigrationTransferTask);
        },
        async claim(task, expected) {
            const name = "migrationTasks.claim";
            if (expected === "absent") {
                await claimAbsentTask(session, name, task);
                return;
            }
            const { id, ...fields } = taskColumns(task);
            await updateRecord(session, name, { table: MIGRATION_TASKS_TABLE, key: [id] }, fields, revisionFence(expected));
        },
        async finish(taskId, claim, completedAt, error) {
            const name = "migrationTasks.finish";
            const key = taskKey(taskId);
            await session.atomically(name, async (fenced) => {
                const rows = await fenced.write(name, key, `UPDATE $schema.migration_transfer_tasks
              SET status = $2::text, completed_at = $3::bigint, updated_at = $3::bigint, error = $4::text,
                  lease_owner = NULL, lease_pod_name = NULL, lease_pod_uid = NULL, lease_restart_count = NULL, lease_expires_at = NULL
            WHERE id = $1::text AND status = 'running' AND attempt = $5::integer AND attempt_id = $6::text AND lease_owner = $7::text
            RETURNING revision`, [taskId, error === null ? "succeeded" : "failed", completedAt, error, claim.attempt, claim.attemptId, claim.leaseOwner]);
                if (rows.length === 0)
                    await failFinish(fenced, key, claim);
            });
        },
    };
}
export function postgresMigrationTasksWatchSource(filter) {
    const statuses = filter.statuses === undefined ? undefined : [...filter.statuses];
    const condition = (parameters) => statuses === undefined ? "" : ` AND status = ANY(${parameters.add(statuses, "text[]")})`;
    return {
        aggregate: "migrationTasks",
        operation: "watch migrationTasks",
        selectAll: (parameters) => `SELECT * FROM $schema.migration_transfer_tasks WHERE true${condition(parameters)} ORDER BY id`,
        selectKeys: (keys, parameters) => `SELECT * FROM $schema.migration_transfer_tasks WHERE id = ANY(${parameters.add([...keys], "text[]")})${condition(parameters)}`,
        keyOf: (row) => row.id,
        decode: decodeMigrationTransferTask,
        mayMatch: (filterKeys) => statuses === undefined ||
            filterKeys.status === undefined ||
            filterKeys.status.some((status) => typeof status === "string" && statuses.includes(status)),
    };
}
