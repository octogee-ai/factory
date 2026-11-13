import { storedGatewayClassValue } from "./stored-gateway-class.js";
const LEGACY_OPERATION_KINDS = {
    "migrate-customer": "migrate-user",
    "deprovision-customer": "deprovision-user",
    "suspend-customer": "suspend-user",
    "erase-customer": "erase-user",
};
const LEGACY_ASSIGNMENT_SOURCES = {
    "migrate-customer": "migrate-user",
};
const LEGACY_AUDIT_MUTATION_KINDS = {
    "assign-customer": "assign-user",
    "unassign-customer": "unassign-user",
    "give-isolated-gateway": "move-to-isolated-gateway",
    "schedule-customer-deletion": "schedule-user-deletion",
    "accelerate-customer-erasure": "accelerate-user-erasure",
    "park-builder": "park-user",
    "place-builder": "place-user",
};
const LEGACY_ISOLATED_GATEWAY_CLASS = "builder";
function current(renames, stored) {
    return typeof stored === "string" && Object.hasOwn(renames, stored) ? renames[stored] : stored;
}
function spellings(renames, value) {
    return [value, ...Object.keys(renames).filter((legacy) => renames[legacy] === value)];
}
export function currentOperationKind(stored) {
    return current(LEGACY_OPERATION_KINDS, stored);
}
export function operationKindsStoredAs(kind) {
    return spellings(LEGACY_OPERATION_KINDS, kind);
}
export function currentAssignmentSource(stored) {
    return current(LEGACY_ASSIGNMENT_SOURCES, stored);
}
export function currentAuditMutation(mutation) {
    if (mutation === null || typeof mutation !== "object" || Array.isArray(mutation))
        return mutation;
    const kind = mutation.kind;
    const renamed = current(LEGACY_AUDIT_MUTATION_KINDS, kind);
    return renamed === kind ? mutation : { ...mutation, kind: renamed };
}
export function auditMutationsStoredAs(mutation) {
    return typeof mutation.kind === "string"
        ? spellings(LEGACY_AUDIT_MUTATION_KINDS, mutation.kind).map((kind) => ({ ...mutation, kind }))
        : [mutation];
}
export function gatewayClassesStoredAs(gatewayClass) {
    const stored = storedGatewayClassValue(gatewayClass);
    return gatewayClass === "builder" ? [stored, LEGACY_ISOLATED_GATEWAY_CLASS] : [stored];
}
