import type { MigrationTransferMode } from "@octogee/shared/types/fleet-controller";
import { MalformedRecordError, type RecordKey } from "../errors.js";
import type { MigrationTransferLeasePod, MigrationTransferTask, MigrationTransferTaskStatus } from "../migration-tasks.js";
import type { Revision, Stored } from "../store.js";

export const TASK_STATUSES: readonly MigrationTransferTaskStatus[] = ["running", "succeeded", "failed"];
export const TRANSFER_MODES: readonly MigrationTransferMode[] = ["keys", "pre", "final"];

export const taskKey = (taskId: string): RecordKey => ({ aggregate: "migration-transfer-task", key: taskId });

export function isLeasePod(value: unknown): value is MigrationTransferLeasePod {
  if (value === null || typeof value !== "object") return false;
  const pod = value as Record<string, unknown>;
  return typeof pod.name === "string" && typeof pod.uid === "string";
}

export function optional<T>(
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

export const isString = (value: unknown): value is string => typeof value === "string";
export const isNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

export function migrationTransferTaskFromData(
  id: string,
  data: Readonly<Record<string, unknown>>,
  revision: Revision,
): Stored<MigrationTransferTask> {
  const key = taskKey(id);
  const required = <T>(field: string, accepts: (value: unknown) => value is T): T => {
    const value = data[field];
    if (!accepts(value)) throw new MalformedRecordError(key, `${field} is ${JSON.stringify(value)}`);
    return value;
  };
  return {
    id,
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
    revision,
  };
}
