import type { BuilderAuxiliaryFamily } from "@octogee/shared/types/fleet-broker";
import type { ScheduleTransferDoc } from "@octogee/shared/types/fleet-controller";
import { placementReceiptDocId, type PlacementReceipt } from "@octogee/shared/types/placement-receipts";
import type {
  AgentStoreRecord,
  AgentStoresRepository,
  BuilderRepositories,
  PlacementReceiptsRepository,
  ScheduleTransfersRepository,
} from "../builders.js";
import { MalformedRecordError, MissingRecordError, type RecordKey } from "../errors.js";
import type { Page, Stored } from "../store.js";
import { createPostgresBuilderRecordsRepository } from "./builder-records.js";
import { deleteRecord, insertRecord, selectByKey, selectRecords, updateRecord } from "./records.js";
import type { PostgresRepositoryFactory, PostgresSession } from "./session.js";
import { SqlParameters, type Row } from "./sql.js";
import { column, decodeRecord, decodeStored, revisionOf, type TableSpec } from "./values.js";

const NULLABLE = { nullAs: "null" } as const;
const GATEWAY_STATE_STORE_KEY = "_gateway-state";
const AUXILIARY_STORE_KEY_PREFIX = "_gateway-";
const RESERVED_STORE_KEY_PREFIX = "_";

const PLACEMENT_RECEIPTS_TABLE: TableSpec = {
  table: "placement_receipts",
  aggregate: "placement-receipt",
  keyColumns: ["uid", "receipt_id"],
  columns: [
    column("uid", "text"),
    column("receiptId", "text"),
    column("schemaVersion", "integer"),
    column("kind", "text"),
    column("at", "bigint"),
    column("builderSlug", "text", { ...NULLABLE, column: "user_slug" }),
    column("leaseId", "text"),
    column("generation", "integer"),
    column("cause", "text", NULLABLE),
    column("sizingTier", "text", NULLABLE),
    column("entitlementTier", "text", NULLABLE),
    column("gatewayId", "text"),
    column("sharedGatewayId", "text", NULLABLE),
    column("requestedAt", "bigint", NULLABLE),
    column("wakeDurationMs", "bigint", NULLABLE),
    column("activeDurationMs", "bigint", NULLABLE),
    column("operationId", "text", NULLABLE),
    column("retirementOperationId", "text", NULLABLE),
    column("operatorTerminated", "boolean"),
    column("error", "text", NULLABLE),
  ],
};

const SCHEDULE_TRANSFERS_TABLE: TableSpec = {
  table: "schedule_transfers",
  aggregate: "schedule-transfer",
  keyColumns: ["uid", "migration_id"],
  columns: [
    column("uid", "text"),
    column("migrationId", "text"),
    column("slug", "text"),
    column("sourceGatewayId", "text"),
    column("targetGatewayId", "text"),
    column("records", "jsonb"),
    column("skipped", "jsonb"),
    column("snapshotAt", "bigint"),
    column("restoreAttemptedTo", "text"),
    column("restoreAttemptedAt", "bigint"),
    column("restoredTo", "text"),
    column("restoredAt", "bigint"),
    column("restoreFailures", "jsonb"),
  ],
};

const AGENT_STORES_TABLE: TableSpec = {
  table: "agent_stores",
  aggregate: "agent-store",
  keyColumns: ["uid", "store_key"],
  columns: [
    column("uid", "text"),
    column("storeKey", "text"),
    column("storeId", "text"),
    column("agentId", "text"),
    column("family", "text"),
    column("schema", "text"),
    column("gatewayId", "text"),
    column("generation", "integer"),
    column("assignmentEpoch", "integer"),
    column("recordedAt", "bigint"),
  ],
};

function withoutKeys<T>(record: Readonly<Record<string, unknown>>, keys: readonly string[]): T {
  return Object.fromEntries(Object.entries(record).filter(([field]) => !keys.includes(field))) as T;
}

function decodePlacementReceipt(row: Row): PlacementReceipt {
  return withoutKeys<PlacementReceipt>(decodeRecord(PLACEMENT_RECEIPTS_TABLE, row), ["uid", "receiptId"]);
}

function createPlacementReceiptsRepository(session: PostgresSession): PlacementReceiptsRepository {
  return {
    async get(uid, leaseId, generation, kind) {
      const row = await selectByKey(session, "builders.placementReceipts.get", {
        table: PLACEMENT_RECEIPTS_TABLE,
        key: [uid, placementReceiptDocId(leaseId, generation, kind)],
      });
      return row === null ? null : decodePlacementReceipt(row);
    },

    async list(uid, page): Promise<Page<PlacementReceipt>> {
      const name = "builders.placementReceipts.list";
      const parameters = new SqlParameters();
      const conditions = [`uid = ${parameters.add(uid, "text")}`];
      if (page.after !== undefined) {
        const anchor = await selectByKey(session, name, { table: PLACEMENT_RECEIPTS_TABLE, key: [uid, page.after] });
        if (anchor === null) throw new MissingRecordError({ aggregate: "placement-receipt", key: `${uid}/${page.after}` });
        conditions.push(`(at, receipt_id) < (${parameters.add(anchor.at, "bigint")}, ${parameters.add(page.after, "text")})`);
      }
      const rows = await selectRecords(
        session,
        name,
        `SELECT * FROM $schema.placement_receipts WHERE ${conditions.join(" AND ")}
          ORDER BY at DESC, receipt_id DESC LIMIT ${parameters.add(page.limit + 1, "integer")}`,
        parameters.values,
      );
      const pageRows = rows.slice(0, page.limit);
      return {
        items: pageRows.map(decodePlacementReceipt),
        next: rows.length > page.limit ? (pageRows[pageRows.length - 1].receipt_id as string) : null,
      };
    },

    async create(uid, receipt) {
      const receiptId = placementReceiptDocId(receipt.leaseId, receipt.generation, receipt.kind);
      await insertRecord(session, "builders.placementReceipts.create", PLACEMENT_RECEIPTS_TABLE, { ...receipt, uid, receiptId }, "create");
    },
  };
}

function createScheduleTransfersRepository(session: PostgresSession): ScheduleTransfersRepository {
  return {
    async get(uid, migrationId) {
      const row = await selectByKey(session, "builders.scheduleTransfers.get", { table: SCHEDULE_TRANSFERS_TABLE, key: [uid, migrationId] });
      if (row === null) return null;
      return withoutKeys<Stored<ScheduleTransferDoc>>(decodeStored(SCHEDULE_TRANSFERS_TABLE, row), ["uid"]);
    },

    async put(uid, transfer) {
      await insertRecord(session, "builders.scheduleTransfers.put", SCHEDULE_TRANSFERS_TABLE, { ...transfer, uid }, "put");
    },

    async patch(uid, migrationId, patch) {
      await updateRecord(session, "builders.scheduleTransfers.patch", { table: SCHEDULE_TRANSFERS_TABLE, key: [uid, migrationId] }, patch, []);
    },
  };
}

export function agentStoreKeyOf(record: AgentStoreRecord): string {
  if (record.kind === "gateway-state") return GATEWAY_STATE_STORE_KEY;
  if (record.kind === "auxiliary") return `${AUXILIARY_STORE_KEY_PREFIX}${record.family}`;
  if (record.agentId.startsWith(RESERVED_STORE_KEY_PREFIX)) {
    throw new TypeError(`agent store id ${record.agentId} collides with the reserved gateway store keys`);
  }
  return record.agentId;
}

function agentStoreRow(uid: string, record: AgentStoreRecord): Readonly<Record<string, unknown>> {
  return {
    uid,
    storeKey: agentStoreKeyOf(record),
    storeId: record.storeId,
    agentId: record.kind === "agent" ? record.agentId : null,
    family: record.kind === "auxiliary" ? record.family : null,
    schema: record.schema,
    gatewayId: record.gatewayId,
    generation: record.generation,
    assignmentEpoch: record.assignmentEpoch,
    recordedAt: record.recordedAt,
  };
}

function decodeAgentStore(row: Row): Stored<AgentStoreRecord> {
  const storeKey = row.store_key as string;
  const record: RecordKey = { aggregate: "agent-store", key: `${row.uid as string}/${storeKey}` };
  const common = {
    storeId: row.store_id as string,
    schema: row.schema as string,
    gatewayId: (row.gateway_id as string | null) ?? null,
    generation: (row.generation as number | null) ?? null,
    assignmentEpoch: (row.assignment_epoch as number | null) ?? null,
    recordedAt: row.recorded_at as number,
    revision: revisionOf(row),
  };
  if (row.store_kind === "gateway-state") return { kind: "gateway-state", ...common };
  if (row.store_kind === "auxiliary") {
    const family = row.family as BuilderAuxiliaryFamily;
    if (storeKey !== `${AUXILIARY_STORE_KEY_PREFIX}${family}`) {
      throw new MalformedRecordError(record, `family ${family} does not name the ${storeKey} auxiliary store`);
    }
    return { kind: "auxiliary", family, ...common };
  }
  return { kind: "agent", agentId: storeKey, ...common };
}

function createAgentStoresRepository(session: PostgresSession): AgentStoresRepository {
  return {
    async list(uid) {
      const rows = await selectRecords(
        session,
        "builders.agentStores.list",
        "SELECT * FROM $schema.agent_stores WHERE uid = $1::text ORDER BY store_key",
        [uid],
      );
      return rows.map(decodeAgentStore);
    },

    async put(uid, record) {
      await insertRecord(session, "builders.agentStores.put", AGENT_STORES_TABLE, agentStoreRow(uid, record), "put");
    },

    async delete(uid, storeKey) {
      await deleteRecord(session, "builders.agentStores.delete", { table: AGENT_STORES_TABLE, key: [uid, storeKey] });
    },
  };
}

export const createPostgresBuilderRepositories: PostgresRepositoryFactory<BuilderRepositories> = (session) => ({
  records: createPostgresBuilderRecordsRepository(session),
  placementReceipts: createPlacementReceiptsRepository(session),
  scheduleTransfers: createScheduleTransfersRepository(session),
  agentStores: createAgentStoresRepository(session),
});
