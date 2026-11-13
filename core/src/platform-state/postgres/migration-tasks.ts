import { FenceMismatchError, MissingRecordError, type RecordKey } from "../errors.js";
import type { MigrationTasksRepository, MigrationTransferTask } from "../migration-tasks.js";
import type { Stored, WatchFilters } from "../store.js";
import { upsertRecord } from "./fleet-registry.js";
import { revisionFence, selectByKey, selectRecords, updateRecord } from "./records.js";
import type { PostgresSession } from "./session.js";
import type { Row, SqlParameters } from "./sql.js";
import { column, decodeStored, revisionOf, type TableSpec } from "./values.js";
import type { PostgresWatchSource } from "./watch-sources.js";

const MIGRATION_TASKS_TABLE: TableSpec = {
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

const taskKey = (taskId: string): RecordKey => ({ aggregate: "migration-transfer-task", key: taskId });

type Fields = Record<string, unknown>;

function taskColumns(task: MigrationTransferTask): Fields {
  const { leasePod, revision: _revision, ...fields } = task as MigrationTransferTask & { readonly revision?: unknown };
  return { ...fields, leasePodName: leasePod?.name ?? null, leasePodUid: leasePod?.uid ?? null };
}

export function decodeMigrationTransferTask(row: Row): Stored<MigrationTransferTask> {
  const { leasePodName, leasePodUid, ...task } = decodeStored<Fields>(MIGRATION_TASKS_TABLE, row);
  const leasePod = leasePodName === undefined ? null : { name: leasePodName as string, uid: leasePodUid as string };
  return { ...task, leasePod } as Stored<MigrationTransferTask>;
}

async function claimAbsentTask(session: PostgresSession, operation: string, task: MigrationTransferTask): Promise<void> {
  const key = taskKey(task.id);
  await session.atomically(operation, async (fenced) => {
    const rows = await upsertRecord(fenced, operation, MIGRATION_TASKS_TABLE, taskColumns(task), {});
    if (rows.length > 0) return;
    const [existing] = await fenced.execute("SELECT revision FROM $schema.migration_transfer_tasks WHERE id = $1::text", [task.id]);
    throw new FenceMismatchError(key, "absent", "absent", existing === undefined ? null : revisionOf(existing));
  });
}

async function failFinish(session: PostgresSession, key: RecordKey, claim: object): Promise<never> {
  const [current] = await session.execute(
    "SELECT status, attempt, attempt_id, lease_owner FROM $schema.migration_transfer_tasks WHERE id = $1::text",
    [key.key],
  );
  if (current === undefined) throw new MissingRecordError(key);
  if (current.status !== "running") throw new FenceMismatchError(key, "status", ["running"], current.status);
  const held = { attempt: current.attempt, attemptId: current.attempt_id, leaseOwner: current.lease_owner };
  throw new FenceMismatchError(key, "attemptId", claim, held);
}

export function createPostgresMigrationTasksRepository(session: PostgresSession): MigrationTasksRepository {
  return {
    async get(taskId) {
      const row = await selectByKey(session, "migrationTasks.get", { table: MIGRATION_TASKS_TABLE, key: [taskId] });
      return row === null ? null : decodeMigrationTransferTask(row);
    },

    async listByStatus(statuses) {
      if (statuses.length === 0) return [];
      const rows = await selectRecords(
        session,
        "migrationTasks.listByStatus",
        "SELECT * FROM $schema.migration_transfer_tasks WHERE status = ANY($1::text[]) ORDER BY id",
        [[...statuses]],
      );
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
        const rows = await fenced.write(
          name,
          key,
          `UPDATE $schema.migration_transfer_tasks
              SET status = $2::text, completed_at = $3::bigint, updated_at = $3::bigint, error = $4::text,
                  lease_owner = NULL, lease_pod_name = NULL, lease_pod_uid = NULL, lease_restart_count = NULL, lease_expires_at = NULL
            WHERE id = $1::text AND status = 'running' AND attempt = $5::integer AND attempt_id = $6::text AND lease_owner = $7::text
            RETURNING revision`,
          [taskId, error === null ? "succeeded" : "failed", completedAt, error, claim.attempt, claim.attemptId, claim.leaseOwner],
        );
        if (rows.length === 0) await failFinish(fenced, key, claim);
      });
    },
  };
}

export function postgresMigrationTasksWatchSource(filter: WatchFilters["migrationTasks"]): PostgresWatchSource<"migrationTasks"> {
  const statuses = filter.statuses === undefined ? undefined : [...filter.statuses];
  const condition = (parameters: SqlParameters) =>
    statuses === undefined ? "" : ` AND status = ANY(${parameters.add(statuses, "text[]")})`;
  return {
    aggregate: "migrationTasks",
    operation: "watch migrationTasks",
    selectAll: (parameters) => `SELECT * FROM $schema.migration_transfer_tasks WHERE true${condition(parameters)} ORDER BY id`,
    selectKeys: (keys, parameters) =>
      `SELECT * FROM $schema.migration_transfer_tasks WHERE id = ANY(${parameters.add([...keys], "text[]")})${condition(parameters)}`,
    keyOf: (row) => row.id as string,
    decode: decodeMigrationTransferTask,
    mayMatch: (filterKeys) =>
      statuses === undefined ||
      filterKeys.status === undefined ||
      filterKeys.status.some((status) => typeof status === "string" && statuses.includes(status as never)),
  };
}
