import type { AssignmentSource } from "@octogee/shared/types/gateway-releases";
import type { GatewayClass, OperationKind } from "@octogee/shared/types/glm";
import { storedGatewayClassValue } from "./stored-gateway-class.js";

type Renames<T extends string> = Readonly<Record<string, T>>;

const LEGACY_OPERATION_KINDS: Renames<OperationKind> = {
  "migrate-customer": "migrate-user",
  "deprovision-customer": "deprovision-user",
  "suspend-customer": "suspend-user",
  "erase-customer": "erase-user",
};

const LEGACY_ASSIGNMENT_SOURCES: Renames<AssignmentSource> = {
  "migrate-customer": "migrate-user",
};

const LEGACY_AUDIT_MUTATION_KINDS: Renames<string> = {
  "assign-customer": "assign-user",
  "unassign-customer": "unassign-user",
  "give-isolated-gateway": "move-to-isolated-gateway",
  "schedule-customer-deletion": "schedule-user-deletion",
  "accelerate-customer-erasure": "accelerate-user-erasure",
  "park-builder": "park-user",
  "place-builder": "place-user",
};

const LEGACY_ISOLATED_GATEWAY_CLASS = "builder";

function current<T extends string>(renames: Renames<T>, stored: unknown): unknown {
  return typeof stored === "string" && Object.hasOwn(renames, stored) ? renames[stored] : stored;
}

function spellings<T extends string>(renames: Renames<T>, value: T): string[] {
  return [value, ...Object.keys(renames).filter((legacy) => renames[legacy] === value)];
}

export function currentOperationKind(stored: unknown): unknown {
  return current(LEGACY_OPERATION_KINDS, stored);
}

export function operationKindsStoredAs(kind: OperationKind): string[] {
  return spellings(LEGACY_OPERATION_KINDS, kind);
}

export function currentAssignmentSource(stored: unknown): unknown {
  return current(LEGACY_ASSIGNMENT_SOURCES, stored);
}

export function currentAuditMutation(mutation: unknown): unknown {
  if (mutation === null || typeof mutation !== "object" || Array.isArray(mutation)) return mutation;
  const kind = (mutation as { kind?: unknown }).kind;
  const renamed = current(LEGACY_AUDIT_MUTATION_KINDS, kind);
  return renamed === kind ? mutation : { ...mutation, kind: renamed };
}

export function auditMutationsStoredAs(mutation: Record<string, unknown>): Record<string, unknown>[] {
  return typeof mutation.kind === "string"
    ? spellings(LEGACY_AUDIT_MUTATION_KINDS, mutation.kind).map((kind) => ({ ...mutation, kind }))
    : [mutation];
}

export function gatewayClassesStoredAs(gatewayClass: GatewayClass): string[] {
  const stored = storedGatewayClassValue(gatewayClass);
  return gatewayClass === "builder" ? [stored, LEGACY_ISOLATED_GATEWAY_CLASS] : [stored];
}
