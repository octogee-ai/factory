export type RolloutLane = "cluster" | "builder-vm";

export interface FleetOperationLockRef {
  id: string;
  kind: string;
  status?: string;
  input?: unknown;
  customerMigrationV2?: unknown;
  rolloutLane?: RolloutLane;
}

const SERIAL_KINDS: ReadonlySet<string> = new Set([
  "rollout",
  "migrate-customer",
]);
const ACTIVE_STATUSES: ReadonlySet<string> = new Set(["pending", "running"]);
const RESOURCE_FIELDS = [
  "gatewayId",
  "fromGatewayId",
  "toGatewayId",
  "sourceGatewayId",
  "targetGatewayId",
] as const;

function stringFields(
  value: unknown,
  fields: readonly string[],
): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const record = value as Record<string, unknown>;
  return fields.flatMap((field) => typeof record[field] === "string" ? [record[field] as string] : []);
}

export function fleetOperationLockResources(
  operation: FleetOperationLockRef,
): ReadonlySet<string> {
  if (!SERIAL_KINDS.has(operation.kind)) return new Set();
  return new Set([
    ...stringFields(operation.input, RESOURCE_FIELDS),
    ...stringFields(operation.customerMigrationV2, [
      "sourceGatewayId",
      "targetGatewayId",
    ]),
  ]);
}

export function serialFleetOperationsConflict(
  candidate: FleetOperationLockRef,
  other: FleetOperationLockRef,
): boolean {
  if (!SERIAL_KINDS.has(candidate.kind) || !SERIAL_KINDS.has(other.kind)) return false;
  const candidateResources = fleetOperationLockResources(candidate);
  for (const resource of fleetOperationLockResources(other)) {
    if (candidateResources.has(resource)) return true;
  }
  return candidate.kind === "rollout" && other.kind === "rollout" && (
    candidate.rolloutLane === undefined || other.rolloutLane === undefined ||
    candidate.rolloutLane === other.rolloutLane
  );
}

export function findActiveGatewayMigration<T extends FleetOperationLockRef>(
  gatewayId: string,
  operations: readonly T[],
): T | null {
  return operations.find((operation) =>
    operation.kind === "migrate-customer" &&
    ACTIVE_STATUSES.has(operation.status ?? "") &&
    fleetOperationLockResources(operation).has(gatewayId)
  ) ?? null;
}

export class GatewayMigrationInFlightError extends Error {
  constructor(
    readonly gatewayId: string,
    readonly operationId: string,
  ) {
    super(`customer migration is in flight for gateway ${gatewayId}`);
    this.name = "GatewayMigrationInFlightError";
  }
}
