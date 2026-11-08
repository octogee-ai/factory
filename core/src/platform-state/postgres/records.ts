import { isDeepStrictEqual } from "node:util";
import { FenceMismatchError, MissingRecordError, type FenceName, type RecordKey } from "../errors.js";
import type { Revision } from "../store.js";
import type { PostgresSession } from "./session.js";
import { SqlParameters, type Row } from "./sql.js";
import {
  castOf,
  decodeColumn,
  encodeColumn,
  inputContainsServerNow,
  inputFields,
  isClearField,
  revisionOf,
  type ColumnSpec,
  type TableSpec,
} from "./values.js";

export type FenceCheck =
  | { readonly fence: "revision"; readonly expected: Revision }
  | {
      readonly fence: FenceName;
      readonly column: ColumnSpec;
      readonly match: "equals" | "oneOf";
      readonly expected: unknown;
    };

export interface RecordTarget {
  readonly table: TableSpec;
  readonly key: readonly unknown[];
}

export function revisionFence(expected: Revision | undefined): FenceCheck[] {
  return expected === undefined ? [] : [{ fence: "revision", expected }];
}

export function equalsFence(fence: FenceName, spec: ColumnSpec, expected: unknown): FenceCheck[] {
  return expected === undefined ? [] : [{ fence, column: spec, match: "equals", expected }];
}

export function oneOfFence(fence: FenceName, spec: ColumnSpec, expected: readonly unknown[] | undefined): FenceCheck[] {
  return expected === undefined ? [] : [{ fence, column: spec, match: "oneOf", expected }];
}

export function recordKeyOf(target: RecordTarget): RecordKey {
  return { aggregate: target.table.aggregate, key: target.key.map(String).join("/") };
}

function keyValuesOf(table: TableSpec, input: object): unknown[] {
  const fields = input as Readonly<Record<string, unknown>>;
  return table.keyColumns.map((columnName) => {
    const spec = table.columns.find((candidate) => candidate.column === columnName);
    const value = spec === undefined ? undefined : fields[spec.field];
    if (value === undefined || value === null) throw new TypeError(`${table.table} record is missing its key ${columnName}`);
    return value;
  });
}

function keyColumnCast(table: TableSpec, columnName: string): string {
  const spec = table.columns.find((candidate) => candidate.column === columnName);
  return spec === undefined ? "text" : castOf(spec);
}

export function keyPredicate(target: RecordTarget, parameters: SqlParameters): string {
  const { table, key } = target;
  if (key.length !== table.keyColumns.length) {
    throw new TypeError(`${table.table} is keyed by ${table.keyColumns.join(", ")}; got ${key.length} key values`);
  }
  return table.keyColumns
    .map((columnName, index) => `${columnName} = ${parameters.add(key[index], keyColumnCast(table, columnName))}`)
    .join(" AND ");
}

function fencePredicate(check: FenceCheck, parameters: SqlParameters): string {
  if (!("column" in check)) return `revision::text = ${parameters.add(check.expected, "text")}`;
  const name = check.column.column;
  const cast = castOf(check.column);
  if (check.match === "oneOf") {
    const allowed = check.expected as readonly unknown[];
    const encoded = check.column.type === "jsonb" ? allowed.map((value) => JSON.stringify(value)) : [...allowed];
    const arrayCast = cast + "[]";
    return `${name} = ANY(${parameters.add(encoded, arrayCast)})`;
  }
  if (check.expected === null) {
    return check.column.type === "jsonb" ? `(${name} IS NULL OR ${name} = 'null'::jsonb)` : `${name} IS NULL`;
  }
  const encoded = check.column.type === "jsonb" ? JSON.stringify(check.expected) : check.expected;
  return `${name} = ${parameters.add(encoded, cast)}`;
}

function actualFenceValue(check: FenceCheck, row: Row): unknown {
  if (!("column" in check)) return revisionOf(row);
  return decodeColumn(check.column, row[check.column.column]);
}

function fenceHolds(check: FenceCheck, actual: unknown): boolean {
  if (!("column" in check)) return actual === check.expected;
  if (check.match === "oneOf") return (check.expected as readonly unknown[]).some((value) => isDeepStrictEqual(value, actual));
  return isDeepStrictEqual(check.expected, actual);
}

async function failFencedMutation(
  session: PostgresSession,
  operation: string,
  target: RecordTarget,
  fences: readonly FenceCheck[],
): Promise<never> {
  const record = recordKeyOf(target);
  const parameters = new SqlParameters();
  const columns = new Set(["revision"]);
  for (const check of fences) if ("column" in check) columns.add(check.column.column);
  const rows = await session.execute(
    `SELECT ${[...columns].join(", ")} FROM $schema.${target.table.table} WHERE ${keyPredicate(target, parameters)}`,
    parameters.values,
  );
  if (rows.length === 0) throw new MissingRecordError(record);
  for (const check of fences) {
    const actual = actualFenceValue(check, rows[0]);
    if (!fenceHolds(check, actual)) throw new FenceMismatchError(record, check.fence, check.expected, actual);
  }
  throw new Error(`${operation} found ${record.aggregate} ${record.key} unchanged although every fence holds`);
}

export async function serverNow(session: PostgresSession): Promise<number> {
  const rows = await session.execute("SELECT $schema.now_ms() AS now");
  return rows[0].now as number;
}

export async function selectRecords(
  session: PostgresSession,
  operation: string,
  text: string,
  values: readonly unknown[] = [],
): Promise<readonly Row[]> {
  return session.read(operation, text, values);
}

export async function selectByKey(session: PostgresSession, operation: string, target: RecordTarget): Promise<Row | null> {
  const parameters = new SqlParameters();
  const rows = await session.read(
    operation,
    `SELECT * FROM $schema.${target.table.table} WHERE ${keyPredicate(target, parameters)}`,
    parameters.values,
  );
  return rows[0] ?? null;
}

export async function insertRecord(
  session: PostgresSession,
  operation: string,
  table: TableSpec,
  input: object,
  mode: "create" | "put",
): Promise<void> {
  const record = recordKeyOf({ table, key: keyValuesOf(table, input) });
  const entries = inputFields(table, record, input);
  const now = inputContainsServerNow(entries) ? await serverNow(session) : undefined;
  const parameters = new SqlParameters();
  const columns: string[] = [];
  const values: string[] = [];
  for (const [spec, value] of entries) {
    columns.push(spec.column);
    values.push(encodeColumn(spec, value, parameters, now));
  }
  let conflict = "";
  if (mode === "put") {
    for (const spec of table.columns) {
      if (columns.includes(spec.column)) continue;
      columns.push(spec.column);
      values.push("DEFAULT");
    }
    const updates = columns.filter((name) => !table.keyColumns.includes(name)).map((name) => `${name} = EXCLUDED.${name}`);
    conflict = ` ON CONFLICT (${table.keyColumns.join(", ")}) DO UPDATE SET ${updates.join(", ")}`;
  }
  await session.write(
    operation,
    record,
    `INSERT INTO $schema.${table.table} (${columns.join(", ")}) VALUES (${values.join(", ")})${conflict}`,
    parameters.values,
  );
}

export async function updateRecord(
  session: PostgresSession,
  operation: string,
  target: RecordTarget,
  patch: object,
  fences: readonly FenceCheck[],
): Promise<void> {
  const { table } = target;
  const record = recordKeyOf(target);
  const entries = inputFields(table, record, patch);
  const immutableFields = table.immutableFields ?? [];
  const fixed = entries.find(([spec]) => immutableFields.includes(spec.field) || table.keyColumns.includes(spec.column));
  if (fixed !== undefined) throw new TypeError(`${operation} cannot change ${fixed[0].field}`);
  const settable = entries.filter(([, value]) => !isClearField(value));
  const now = inputContainsServerNow(settable) ? await serverNow(session) : undefined;
  const parameters = new SqlParameters();
  const assignments = entries.map(
    ([spec, value]) => `${spec.column} = ${isClearField(value) ? "NULL" : encodeColumn(spec, value, parameters, now)}`,
  );
  if (assignments.length === 0) assignments.push(`${table.keyColumns[0]} = ${table.keyColumns[0]}`);
  const conditions = [keyPredicate(target, parameters), ...fences.map((check) => fencePredicate(check, parameters))];
  const text = `UPDATE $schema.${table.table} SET ${assignments.join(", ")} WHERE ${conditions.join(" AND ")} RETURNING revision`;
  if (fences.length === 0) {
    const rows = await session.write(operation, record, text, parameters.values);
    if (rows.length === 0) throw new MissingRecordError(record);
    return;
  }
  await session.atomically(operation, async (fenced) => {
    const rows = await fenced.write(operation, record, text, parameters.values);
    if (rows.length === 0) await failFencedMutation(fenced, operation, target, fences);
  });
}

export async function deleteRecord(
  session: PostgresSession,
  operation: string,
  target: RecordTarget,
  fences: readonly FenceCheck[] = [],
): Promise<void> {
  const record = recordKeyOf(target);
  const parameters = new SqlParameters();
  const conditions = [keyPredicate(target, parameters), ...fences.map((check) => fencePredicate(check, parameters))];
  const text = `DELETE FROM $schema.${target.table.table} WHERE ${conditions.join(" AND ")} RETURNING 1 AS deleted`;
  if (fences.length === 0) {
    await session.write(operation, record, text, parameters.values);
    return;
  }
  await session.atomically(operation, async (fenced) => {
    const rows = await fenced.write(operation, record, text, parameters.values);
    if (rows.length === 0) await failFencedMutation(fenced, operation, target, fences);
  });
}
