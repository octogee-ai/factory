import { parsePlatformReleaseRecord, type PlatformReleaseRecord } from "@octogee/shared/types/gateway-releases";
import { parseSharedPoolReplacements } from "@octogee/shared/types/shared-gateway-pool";
import type {
  ControllerStateRepositories,
  SharedPoolScalerFence,
  SharedPoolScalerPatch,
  SharedPoolScalerState,
} from "../controller-state.js";
import { FenceMismatchError, MalformedRecordError, type RecordKey } from "../errors.js";
import type { Revision, Stored } from "../store.js";
import { upsertRecord } from "./fleet-registry.js";
import { equalsFence, insertRecord, revisionFence, selectByKey, updateRecord, type FenceCheck } from "./records.js";
import type { PostgresSession } from "./session.js";
import type { Row } from "./sql.js";
import { column, columnFor, decodeStored, isClearField, revisionOf, type TableSpec } from "./values.js";

const SCALER_ID = "sharedPoolScaler";
const PLATFORM_RELEASE_ID = "platformRelease";

const SCALER_TABLE: TableSpec = {
  table: "shared_pool_scaler_state",
  aggregate: "shared-pool-scaler",
  keyColumns: ["id"],
  columns: [
    column("id", "text"),
    column("schemaVersion", "integer"),
    column("actionSequence", "bigint"),
    column("lastActionAt", "bigint", { nullAs: "null" }),
    column("replacements", "jsonb"),
    column("lastAction", "jsonb"),
    column("updatedAt", "bigint"),
  ],
  immutableFields: ["id", "schemaVersion"],
};

const PLATFORM_RELEASE_TABLE: TableSpec = {
  table: "platform_release_record",
  aggregate: "platform-release",
  keyColumns: ["id"],
  columns: [
    column("id", "text"),
    column("schemaVersion", "integer"),
    column("payloadHash", "text"),
    column("imageTag", "text"),
    column("openclawSourceSha", "text", { nullAs: "null" }),
    column("writtenAt", "bigint"),
  ],
};

const SCALER_KEY: RecordKey = { aggregate: "shared-pool-scaler", key: SCALER_ID };
const PLATFORM_RELEASE_KEY: RecordKey = { aggregate: "platform-release", key: PLATFORM_RELEASE_ID };
const SCALER_TARGET = { table: SCALER_TABLE, key: [SCALER_ID] };
const ACTION_SEQUENCE = columnFor(SCALER_TABLE, SCALER_KEY, "actionSequence");

type Fields = Record<string, unknown>;

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isPlainMap(value: unknown): boolean {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

const SCALER_FIELD_CHECKS: Readonly<Record<string, (value: unknown) => string | null>> = {
  actionSequence: (value) => (isNonNegativeInteger(value) ? null : "actionSequence is not a nonnegative integer"),
  lastActionAt: (value) => (value === null || isNonNegativeInteger(value) ? null : "lastActionAt is neither null nor a nonnegative integer"),
  lastAction: (value) => (value === null || isPlainMap(value) ? null : "lastAction is not a map"),
  updatedAt: (value) => (isNonNegativeInteger(value) ? null : "updatedAt is not a nonnegative integer"),
  replacements: (value) => {
    try {
      parseSharedPoolReplacements(value);
      return null;
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  },
};

const REQUIRED_SCALER_FIELDS: ReadonlySet<string> = new Set(["actionSequence", "lastActionAt", "replacements"]);

function assertScalerFields(fields: Fields): void {
  for (const [field, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    if (isClearField(value)) {
      if (REQUIRED_SCALER_FIELDS.has(field)) throw new MalformedRecordError(SCALER_KEY, `${field} cannot be removed`);
      continue;
    }
    const problem = SCALER_FIELD_CHECKS[field]?.(value) ?? null;
    if (problem !== null) throw new MalformedRecordError(SCALER_KEY, problem);
  }
}

function scalerColumns(state: SharedPoolScalerState): Fields {
  if (state.schemaVersion !== 1) throw new MalformedRecordError(SCALER_KEY, `schemaVersion is ${JSON.stringify(state.schemaVersion)}`);
  const { revision: _revision, ...fields } = state as SharedPoolScalerState & { readonly revision?: Revision };
  for (const field of REQUIRED_SCALER_FIELDS) {
    if (fields[field as keyof typeof fields] === undefined) throw new MalformedRecordError(SCALER_KEY, `${field} is missing`);
  }
  assertScalerFields(fields);
  return {
    ...fields,
    replacements: parseSharedPoolReplacements(fields.replacements),
    lastAction: fields.lastAction === undefined ? { clear: true } : fields.lastAction,
    updatedAt: fields.updatedAt === undefined ? { clear: true } : fields.updatedAt,
  };
}

function decodeScalerState(row: Row): Stored<SharedPoolScalerState> {
  const { id: _id, ...state } = decodeStored<SharedPoolScalerState & { readonly id: string }>(SCALER_TABLE, row);
  assertScalerFields(state);
  return { ...state, replacements: parseSharedPoolReplacements(state.replacements) };
}

function scalerFences(fence: SharedPoolScalerFence | undefined): FenceCheck[] {
  return [...revisionFence(fence?.revision), ...equalsFence("actionSequence", ACTION_SEQUENCE, fence?.actionSequence)];
}

function withoutClears(fields: Fields): Fields {
  return Object.fromEntries(Object.entries(fields).filter(([, value]) => !isClearField(value)));
}

async function putAbsentScalerState(session: PostgresSession, operation: string, fields: Fields): Promise<void> {
  await session.atomically(operation, async (fenced) => {
    const rows = await upsertRecord(fenced, operation, SCALER_TABLE, { id: SCALER_ID, ...withoutClears(fields) }, {});
    if (rows.length > 0) return;
    const [existing] = await fenced.execute("SELECT revision FROM $schema.shared_pool_scaler_state WHERE id = $1::text", [SCALER_ID]);
    throw new FenceMismatchError(SCALER_KEY, "absent", "absent", existing === undefined ? null : revisionOf(existing));
  });
}

function decodePlatformRelease(row: Row): Stored<PlatformReleaseRecord> {
  const { id: _id, revision, ...fields } = decodeStored<Fields>(PLATFORM_RELEASE_TABLE, row);
  const record = parsePlatformReleaseRecord(fields);
  if (record === null) throw new MalformedRecordError(PLATFORM_RELEASE_KEY, "is not a platform release record");
  return { ...record, revision: revision as Revision };
}

export function createPostgresControllerStateRepositories(session: PostgresSession): ControllerStateRepositories {
  return {
    sharedPoolScaler: {
      async get() {
        const row = await selectByKey(session, "controllerState.sharedPoolScaler.get", SCALER_TARGET);
        return row === null ? null : decodeScalerState(row);
      },

      async put(state, fence) {
        const name = "controllerState.sharedPoolScaler.put";
        const { schemaVersion, ...fields } = scalerColumns(state);
        if (fence === "absent") {
          await putAbsentScalerState(session, name, { schemaVersion, ...fields });
          return;
        }
        await updateRecord(session, name, SCALER_TARGET, fields, scalerFences(fence));
      },

      async patch(patch: SharedPoolScalerPatch, fence) {
        assertScalerFields(patch as Fields);
        const fields = patch.replacements === undefined ? patch : { ...patch, replacements: parseSharedPoolReplacements(patch.replacements) };
        await updateRecord(session, "controllerState.sharedPoolScaler.patch", SCALER_TARGET, fields, scalerFences(fence));
      },
    },

    platformRelease: {
      async get() {
        const row = await selectByKey(session, "controllerState.platformRelease.get", { table: PLATFORM_RELEASE_TABLE, key: [PLATFORM_RELEASE_ID] });
        return row === null ? null : decodePlatformRelease(row);
      },

      async put(record) {
        const parsed = parsePlatformReleaseRecord({ ...record });
        if (parsed === null) throw new MalformedRecordError(PLATFORM_RELEASE_KEY, "is not a platform release record");
        await insertRecord(session, "controllerState.platformRelease.put", PLATFORM_RELEASE_TABLE, { id: PLATFORM_RELEASE_ID, ...parsed }, "put");
      },
    },
  };
}
