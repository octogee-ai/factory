import { MalformedRecordError, MissingRecordError, type RecordKey } from "../errors.js";
import type { FleetRegistryFence, FleetRegistryRecord, FleetRegistryRepository } from "../fleet-registry.js";
import type { Stored, WatchFilters } from "../store.js";
import { gatewayCondition, gatewayFilterMatches } from "./gateways.js";
import {
  deleteRecord,
  equalsFence,
  insertRecord,
  oneOfFence,
  recordKeyOf,
  revisionFence,
  selectByKey,
  selectRecords,
  serverNow,
  updateRecord,
  type FenceCheck,
} from "./records.js";
import type { PostgresSession } from "./session.js";
import { SqlParameters, type Row } from "./sql.js";
import {
  column,
  columnFor,
  decodeStored,
  encodeColumn,
  inputContainsServerNow,
  inputFields,
  isClearField,
  type TableSpec,
} from "./values.js";
import type { PostgresWatchSource } from "./watch-sources.js";

export const FLEET_REGISTRY_TABLE: TableSpec = {
  table: "fleet_registry",
  aggregate: "fleet-registry",
  keyColumns: ["gateway_id"],
  columns: [
    column("gatewayId", "text"),
    column("release", "integer"),
    column("lifecycle", "text"),
    column("retiredAt", "bigint"),
    column("createdAt", "bigint"),
    column("createdByOperationId", "text", { nullAs: "null" }),
    column("runtime", "text"),
    column("helm", "jsonb"),
    column("heartbeat", "jsonb"),
    column("kubernetes", "jsonb"),
    column("podReplacements", "jsonb"),
    column("lastError", "jsonb"),
    column("vmSpec", "jsonb"),
    column("vm", "jsonb"),
    column("vmInstance", "jsonb"),
    column("vmHome", "jsonb"),
    column("vmStopOnPark", "jsonb"),
    column("vmBootRecovery", "jsonb"),
    column("vmPreemption", "jsonb"),
    column("vmDisk", "jsonb"),
    column("vmImages", "jsonb"),
    column("vmEgress", "jsonb"),
    column("surgeCrashLoopEvictions", "jsonb"),
    column("openclawHealthyBuild", "jsonb"),
  ],
  immutableFields: ["gatewayId", "createdAt"],
};

const registryKey = (gatewayId: string): RecordKey => ({ aggregate: "fleet-registry", key: gatewayId });

const LIFECYCLE = columnFor(FLEET_REGISTRY_TABLE, registryKey(""), "lifecycle");
const VM_INSTANCE_ID = column("vmInstanceId", "text", { column: "vm_instance_id" });

type Fields = Record<string, unknown>;

function keyValues(table: TableSpec, record: RecordKey, input: object): unknown[] {
  return table.keyColumns.map((columnName) => {
    const spec = table.columns.find((candidate) => candidate.column === columnName);
    const value = spec === undefined ? undefined : (input as Fields)[spec.field];
    if (value === undefined || value === null) throw new MalformedRecordError(record, `is missing its key ${columnName}`);
    return value;
  });
}

function withoutClears(record: object, patch: object): Fields {
  const applied: Fields = { ...(record as Fields) };
  for (const [field, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    if (isClearField(value)) delete applied[field];
    else applied[field] = value;
  }
  return applied;
}

export async function upsertRecord(
  session: PostgresSession,
  operation: string,
  table: TableSpec,
  initial: object,
  patch: object,
): Promise<readonly Row[]> {
  const insert = withoutClears(initial, patch);
  const record = recordKeyOf({ table, key: keyValues(table, { aggregate: table.aggregate, key: "" }, insert) });
  const inserted = inputFields(table, record, insert);
  const updated = inputFields(table, record, patch);
  const fixed = updated.find(([spec]) => (table.immutableFields ?? []).includes(spec.field) || table.keyColumns.includes(spec.column));
  if (fixed !== undefined) throw new TypeError(`${operation} cannot change ${fixed[0].field}`);
  const now = inputContainsServerNow([...inserted, ...updated]) ? await serverNow(session) : undefined;
  const parameters = new SqlParameters();
  const columns = inserted.map(([spec]) => spec.column);
  const values = inserted.map(([spec, value]) => encodeColumn(spec, value, parameters, now));
  const assignments = updated.map(
    ([spec, value]) => `${spec.column} = ${isClearField(value) ? "NULL" : encodeColumn(spec, value, parameters, now)}`,
  );
  const conflict = assignments.length === 0 ? "DO NOTHING" : `DO UPDATE SET ${assignments.join(", ")}`;
  return session.write(
    operation,
    record,
    `INSERT INTO $schema.${table.table} (${columns.join(", ")}) VALUES (${values.join(", ")})
       ON CONFLICT (${table.keyColumns.join(", ")}) ${conflict} RETURNING revision`,
    parameters.values,
  );
}

export function decodeFleetRegistryRecord(row: Row): Stored<FleetRegistryRecord> {
  const record = decodeStored<FleetRegistryRecord>(FLEET_REGISTRY_TABLE, row);
  if (record.heartbeat === null || typeof record.heartbeat !== "object" || Array.isArray(record.heartbeat)) {
    throw new MalformedRecordError({ aggregate: "fleet-registry", key: record.gatewayId }, "heartbeat is not a map");
  }
  return record;
}

function registryFences(fence: FleetRegistryFence | undefined): FenceCheck[] {
  return [
    ...revisionFence(fence?.revision),
    ...oneOfFence("status", LIFECYCLE, fence?.lifecycle),
    ...equalsFence("present", VM_INSTANCE_ID, fence?.vmInstanceId),
  ];
}

export function createPostgresFleetRegistryRepository(session: PostgresSession): FleetRegistryRepository {
  const list = async (operation: string, where: string, values: readonly unknown[]) =>
    (await selectRecords(session, operation, `SELECT * FROM $schema.fleet_registry ${where} ORDER BY gateway_id`, values)).map(
      decodeFleetRegistryRecord,
    );
  const target = (gatewayId: string) => ({ table: FLEET_REGISTRY_TABLE, key: [gatewayId] });

  return {
    async get(gatewayId) {
      const row = await selectByKey(session, "fleetRegistry.get", target(gatewayId));
      return row === null ? null : decodeFleetRegistryRecord(row);
    },

    async getMany(gatewayIds) {
      const records = await list("fleetRegistry.getMany", "WHERE gateway_id = ANY($1::text[])", [[...gatewayIds]]);
      return new Map(records.map((record) => [record.gatewayId, record]));
    },

    list(filter = {}) {
      if (filter.runtime === undefined) return list("fleetRegistry.list", "", []);
      return list("fleetRegistry.list", "WHERE runtime = $1::text", [filter.runtime]);
    },

    async inventory(gatewayIds) {
      const records = gatewayIds === undefined
        ? await list("fleetRegistry.inventory", "", [])
        : await list("fleetRegistry.inventory", "WHERE gateway_id = ANY($1::text[])", [[...gatewayIds]]);
      return { records, foreign: [] };
    },

    async findByVmInstanceId(instanceId) {
      const rows = await selectRecords(
        session,
        "fleetRegistry.findByVmInstanceId",
        "SELECT * FROM $schema.fleet_registry WHERE vm_instance_id = $1::text",
        [instanceId],
      );
      return rows.length === 0 ? null : decodeFleetRegistryRecord(rows[0]);
    },

    async create(record) {
      await insertRecord(session, "fleetRegistry.create", FLEET_REGISTRY_TABLE, record, "create");
    },

    async upsert(gatewayId, initial, patch) {
      if (initial.gatewayId !== gatewayId) {
        throw new MalformedRecordError(registryKey(gatewayId), `initial record names gateway ${JSON.stringify(initial.gatewayId)}`);
      }
      await upsertRecord(session, "fleetRegistry.upsert", FLEET_REGISTRY_TABLE, initial, patch);
    },

    async patch(gatewayId, patch, fence) {
      await updateRecord(session, "fleetRegistry.patch", target(gatewayId), patch, registryFences(fence));
    },

    async recordHeartbeat(gatewayId, heartbeat) {
      const name = "fleetRegistry.recordHeartbeat";
      const rows = await session.write(
        name,
        registryKey(gatewayId),
        `UPDATE $schema.fleet_registry
            SET heartbeat = $schema.jsonb_merge_deep(heartbeat, $1::jsonb || jsonb_build_object('lastHeartbeatAt', $schema.now_ms()))
          WHERE gateway_id = $2::text RETURNING revision`,
        [JSON.stringify(heartbeat), gatewayId],
      );
      if (rows.length === 0) throw new MissingRecordError(registryKey(gatewayId));
    },

    async delete(gatewayId) {
      await deleteRecord(session, "fleetRegistry.delete", target(gatewayId));
    },
  };
}

export function postgresFleetRegistryWatchSource(filter: WatchFilters["fleetRegistry"]): PostgresWatchSource<"fleetRegistry"> {
  return {
    aggregate: "fleetRegistry",
    operation: "watch fleetRegistry",
    selectAll: (parameters) =>
      `SELECT * FROM $schema.fleet_registry WHERE true${gatewayCondition(filter.gatewayId, parameters)} ORDER BY gateway_id`,
    selectKeys: (keys, parameters) =>
      `SELECT * FROM $schema.fleet_registry
        WHERE gateway_id = ANY(${parameters.add([...keys], "text[]")})${gatewayCondition(filter.gatewayId, parameters)}`,
    keyOf: (row) => row.gateway_id as string,
    decode: decodeFleetRegistryRecord,
    mayMatch: (filterKeys) => gatewayFilterMatches(filter.gatewayId, filterKeys),
  };
}
