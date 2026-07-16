const SERIAL_KINDS = new Set(["rollout", "migrate-customer"]);
const ACTIVE_STATUSES = new Set(["pending", "running"]);
const RESOURCE_FIELDS = [
    "gatewayId",
    "fromGatewayId",
    "toGatewayId",
    "sourceGatewayId",
    "targetGatewayId",
    "sourceRevisionId",
    "targetRevisionId",
];
function stringFields(value, fields) {
    if (!value || typeof value !== "object" || Array.isArray(value))
        return [];
    const record = value;
    return fields.flatMap((field) => typeof record[field] === "string" ? [record[field]] : []);
}
function rolloutParentId(operation) {
    if (operation.kind !== "migrate-customer")
        return null;
    if (!operation.input || typeof operation.input !== "object" || Array.isArray(operation.input)) {
        return null;
    }
    const rollOperationId = operation.input.rollOperationId;
    return typeof rollOperationId === "string" ? rollOperationId : null;
}
function isRolloutMigrationLineage(rollout, migration) {
    return rollout.kind === "rollout" && rolloutParentId(migration) === rollout.id;
}
export function fleetOperationLockResources(operation) {
    if (!SERIAL_KINDS.has(operation.kind))
        return new Set();
    return new Set([
        ...stringFields(operation.input, RESOURCE_FIELDS),
        ...stringFields(operation.customerMigrationV2, [
            "sourceGatewayId",
            "targetGatewayId",
            "sourceRevisionId",
            "targetRevisionId",
        ]),
    ]);
}
export function serialFleetOperationsConflict(candidate, other) {
    if (!SERIAL_KINDS.has(candidate.kind) || !SERIAL_KINDS.has(other.kind))
        return false;
    if (isRolloutMigrationLineage(candidate, other) ||
        isRolloutMigrationLineage(other, candidate)) {
        return false;
    }
    if (candidate.kind === "rollout" && other.kind === "rollout")
        return true;
    const candidateResources = fleetOperationLockResources(candidate);
    for (const resource of fleetOperationLockResources(other)) {
        if (candidateResources.has(resource))
            return true;
    }
    return false;
}
export function findActiveGatewayMigration(gatewayId, operations) {
    return operations.find((operation) => operation.kind === "migrate-customer" &&
        ACTIVE_STATUSES.has(operation.status ?? "") &&
        fleetOperationLockResources(operation).has(gatewayId)) ?? null;
}
export class GatewayMigrationInFlightError extends Error {
    gatewayId;
    operationId;
    constructor(gatewayId, operationId) {
        super(`customer migration is in flight for gateway ${gatewayId}`);
        this.gatewayId = gatewayId;
        this.operationId = operationId;
        this.name = "GatewayMigrationInFlightError";
    }
}
