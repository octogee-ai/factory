import type { DocumentSnapshot, Firestore, Query } from "firebase-admin/firestore";
import type { MigrationTransferMode } from "@octogee/shared/types/fleet-controller";
import { GLM_MIGRATION_TRANSFER_TASKS_COLLECTION } from "@octogee/shared/types/glm";
import { MalformedRecordError, MissingRecordError, type RecordKey } from "../errors.js";
import type {
  MigrationTasksRepository,
  MigrationTransferLeasePod,
  MigrationTransferTask,
  MigrationTransferTaskStatus,
} from "../migration-tasks.js";
import type { Stored } from "../store.js";
import { assertAbsentFence, assertFenceEquals, assertFenceOneOf, assertRevisionFence } from "./fences.js";
import type { FirestoreSession } from "./session.js";
import { decodeDocumentData, encodeDocument, encodePatch, revisionOf, STORED_AS_NUMBERS } from "./values.js";
import type { FirestoreWatchSourceFactory } from "./watch.js";

const TASK_STATUSES: readonly MigrationTransferTaskStatus[] = ["running", "succeeded", "failed"];
const TRANSFER_MODES: readonly MigrationTransferMode[] = ["keys", "pre", "final"];

const taskKey = (taskId: string): RecordKey => ({ aggregate: "migration-transfer-task", key: taskId });

function isLeasePod(value: unknown): value is MigrationTransferLeasePod {
  if (value === null || typeof value !== "object") return false;
  const pod = value as Record<string, unknown>;
  return typeof pod.name === "string" && typeof pod.uid === "string";
}

function optional<T>(
  key: RecordKey,
  data: Readonly<Record<string, unknown>>,
  field: string,
  accepts: (value: unknown) => value is T,
): T | null {
  const value = data[field];
  if (value === undefined || value === null) return null;
  if (!accepts(value)) throw new MalformedRecordError(key, `${field} is ${JSON.stringify(value)}`);
  return value;
}

const isString = (value: unknown): value is string => typeof value === "string";
const isNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

export function decodeMigrationTransferTask(snapshot: DocumentSnapshot): Stored<MigrationTransferTask> | null {
  if (!snapshot.exists) return null;
  const key = taskKey(snapshot.id);
  const data = decodeDocumentData(snapshot);
  const required = <T>(field: string, accepts: (value: unknown) => value is T): T => {
    const value = data[field];
    if (!accepts(value)) throw new MalformedRecordError(key, `${field} is ${JSON.stringify(value)}`);
    return value;
  };
  return {
    id: snapshot.id,
    kind: required("kind", isString),
    migrationId: required("migrationId", isString),
    slug: required("slug", isString),
    mode: required("mode", (value): value is MigrationTransferMode => TRANSFER_MODES.includes(value as MigrationTransferMode)),
    sourceGatewayId: required("sourceGatewayId", isString),
    targetGatewayId: required("targetGatewayId", isString),
    status: required("status", (value): value is MigrationTransferTaskStatus =>
      TASK_STATUSES.includes(value as MigrationTransferTaskStatus)),
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
    revision: revisionOf(snapshot),
  };
}

function encodeTask(task: MigrationTransferTask) {
  const present = Object.fromEntries(Object.entries(task).filter(([, value]) => value !== null));
  return encodeDocument(present, STORED_AS_NUMBERS, ["id", "revision"]);
}

function statusQuery(collection: Query, statuses: readonly MigrationTransferTaskStatus[]): Query {
  return statuses.length === 1 ? collection.where("status", "==", statuses[0]) : collection.where("status", "in", statuses);
}

function isPresent<T>(value: T | null): value is T {
  return value !== null;
}

export function createFirestoreMigrationTasksRepository(session: FirestoreSession): MigrationTasksRepository {
  const collection = () => session.db.collection(GLM_MIGRATION_TRANSFER_TASKS_COLLECTION);
  const ref = (taskId: string) => collection().doc(taskId);

  return {
    async get(taskId) {
      return decodeMigrationTransferTask(await session.read("migrationTasks.get", ref(taskId)));
    },

    async listByStatus(statuses) {
      if (statuses.length === 0) return [];
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
        } else {
          if (existing === null) throw new MissingRecordError(key);
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
        if (current === null) throw new MissingRecordError(key);
        assertFenceOneOf(key, "status", ["running"], current.status);
        assertFenceEquals(key, "attemptId", claim, {
          attempt: current.attempt,
          attemptId: current.attemptId,
          leaseOwner: current.leaseOwner,
        });
        const clear = { clear: true } as const;
        await fenced.update(
          name,
          key,
          ref(taskId),
          encodePatch(
            {
              status: error === null ? "succeeded" : "failed",
              completedAt,
              updatedAt: completedAt,
              leaseOwner: clear,
              leasePod: clear,
              leaseRestartCount: clear,
              leaseExpiresAt: clear,
              error: error ?? clear,
            },
            STORED_AS_NUMBERS,
          ),
        );
      });
    },
  };
}

export const firestoreMigrationTasksWatchSource: FirestoreWatchSourceFactory<"migrationTasks"> = (db: Firestore, filter) => {
  const collection = db.collection(GLM_MIGRATION_TRANSFER_TASKS_COLLECTION);
  const statuses = filter.statuses;
  return {
    operation: "watch migrationTasks",
    targets:
      statuses !== undefined && statuses.length === 0
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
