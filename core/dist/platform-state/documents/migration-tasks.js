import { MalformedRecordError } from "../errors.js";
export const TASK_STATUSES = ["running", "succeeded", "failed"];
export const TRANSFER_MODES = ["keys", "pre", "final"];
export const taskKey = (taskId) => ({ aggregate: "migration-transfer-task", key: taskId });
export function isLeasePod(value) {
    if (value === null || typeof value !== "object")
        return false;
    const pod = value;
    return typeof pod.name === "string" && typeof pod.uid === "string";
}
export function optional(key, data, field, accepts) {
    const value = data[field];
    if (value === undefined || value === null)
        return null;
    if (!accepts(value))
        throw new MalformedRecordError(key, `${field} is ${JSON.stringify(value)}`);
    return value;
}
export const isString = (value) => typeof value === "string";
export const isNumber = (value) => typeof value === "number" && Number.isFinite(value);
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
