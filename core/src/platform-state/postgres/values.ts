import { MalformedRecordError, type PlatformAggregate, type RecordKey } from "../errors.js";
import type { ClearField, Revision, ServerNow } from "../store.js";
import type { Row, SqlParameters } from "./sql.js";

export type ColumnType = "text" | "bigint" | "integer" | "boolean" | "double" | "jsonb";

export interface ColumnSpec {
  readonly field: string;
  readonly column: string;
  readonly type: ColumnType;
  readonly nullAs: "absent" | "null";
}

export interface TableSpec {
  readonly table: string;
  readonly aggregate: PlatformAggregate;
  readonly keyColumns: readonly string[];
  readonly columns: readonly ColumnSpec[];
  readonly constants?: Readonly<Record<string, unknown>>;
  readonly immutableFields?: readonly string[];
}

export type NestedClears = "reject" | "remove";

const SQL_CASTS: Readonly<Record<ColumnType, string>> = {
  text: "text",
  bigint: "bigint",
  integer: "integer",
  boolean: "boolean",
  double: "double precision",
  jsonb: "jsonb",
};

const SERVER_NOW_SQL = "$schema.now_ms()";
const IGNORED_INPUT_FIELDS: ReadonlySet<string> = new Set(["revision"]);

export function snakeCase(field: string): string {
  return field.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
}

export function column(
  field: string,
  type: ColumnType,
  options: { readonly column?: string; readonly nullAs?: "absent" | "null" } = {},
): ColumnSpec {
  return { field, type, column: options.column ?? snakeCase(field), nullAs: options.nullAs ?? "absent" };
}

type PlainObject = Record<string, unknown>;

function isPlainObject(value: unknown): value is PlainObject {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isSoleTrueFlag(value: unknown, flag: string): boolean {
  if (!isPlainObject(value)) return false;
  const keys = Object.keys(value);
  return keys.length === 1 && keys[0] === flag && value[flag] === true;
}

export function isServerNow(value: unknown): value is ServerNow {
  return isSoleTrueFlag(value, "serverNow");
}

export function isClearField(value: unknown): value is ClearField {
  return isSoleTrueFlag(value, "clear");
}

export function containsServerNow(value: unknown): boolean {
  if (isServerNow(value)) return true;
  if (Array.isArray(value)) return value.some(containsServerNow);
  if (isPlainObject(value)) return Object.values(value).some(containsServerNow);
  return false;
}

export function resolveJsonValue(value: unknown, now: number | undefined, nestedClears: NestedClears, path: string): unknown {
  if (isServerNow(value)) {
    if (now === undefined) throw new TypeError(`${path} holds a server time but none was resolved`);
    return now;
  }
  if (isClearField(value)) throw new TypeError(`{ clear: true } is only valid at a patch field position; found at ${path}`);
  if (Array.isArray(value)) return value.map((item, index) => resolveJsonValue(item, now, "reject", `${path}[${index}]`));
  if (isPlainObject(value)) {
    const resolved: PlainObject = {};
    for (const [key, item] of Object.entries(value)) {
      if (item === undefined) continue;
      if (isClearField(item) && nestedClears === "remove") continue;
      resolved[key] = resolveJsonValue(item, now, nestedClears, `${path}.${key}`);
    }
    return resolved;
  }
  return value;
}

const COLUMN_VALUE_CHECKS: Readonly<Record<ColumnType, (value: unknown) => boolean>> = {
  text: (value) => typeof value === "string",
  bigint: (value) => Number.isSafeInteger(value),
  integer: (value) => Number.isSafeInteger(value),
  double: (value) => typeof value === "number" && Number.isFinite(value),
  boolean: (value) => typeof value === "boolean",
  jsonb: () => true,
};

function assertColumnValue(spec: ColumnSpec, value: unknown): void {
  if (!COLUMN_VALUE_CHECKS[spec.type](value)) throw new TypeError(`${spec.field} must be a ${spec.type} value, got ${JSON.stringify(value)}`);
}

export function encodeColumn(
  spec: ColumnSpec,
  value: unknown,
  parameters: SqlParameters,
  now: number | undefined,
  nestedClears: NestedClears = "reject",
): string {
  if (value === null) return spec.type === "jsonb" ? parameters.add("null", "jsonb") : "NULL";
  if (spec.type === "jsonb") {
    return parameters.add(JSON.stringify(resolveJsonValue(value, now, nestedClears, spec.field)), "jsonb");
  }
  if (isServerNow(value)) {
    if (spec.type !== "bigint") throw new TypeError(`${spec.field} is not a time column and cannot take a server time`);
    return now === undefined ? SERVER_NOW_SQL : parameters.add(now, "bigint");
  }
  if (isClearField(value)) throw new TypeError(`{ clear: true } is only valid at a patch field position; found at ${spec.field}`);
  assertColumnValue(spec, value);
  return parameters.add(value, SQL_CASTS[spec.type]);
}

export function castOf(spec: ColumnSpec): string {
  return SQL_CASTS[spec.type];
}

function columnsByField(table: TableSpec): ReadonlyMap<string, ColumnSpec> {
  return new Map(table.columns.map((spec) => [spec.field, spec]));
}

const FIELD_INDEX = new WeakMap<TableSpec, ReadonlyMap<string, ColumnSpec>>();

export function columnFor(table: TableSpec, record: RecordKey, field: string): ColumnSpec {
  let index = FIELD_INDEX.get(table);
  if (index === undefined) {
    index = columnsByField(table);
    FIELD_INDEX.set(table, index);
  }
  const spec = index.get(field);
  if (spec === undefined) throw new MalformedRecordError(record, `field ${field} has no column in ${table.table}`);
  return spec;
}

export function assertConstants(table: TableSpec, record: RecordKey, input: object): void {
  for (const [field, expected] of Object.entries(table.constants ?? {})) {
    const actual = (input as PlainObject)[field];
    if (actual !== undefined && actual !== expected) {
      throw new MalformedRecordError(record, `field ${field} must be ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    }
  }
}

export function inputFields(table: TableSpec, record: RecordKey, input: object): [ColumnSpec, unknown][] {
  assertConstants(table, record, input);
  const constants = table.constants ?? {};
  const entries: [ColumnSpec, unknown][] = [];
  for (const [field, value] of Object.entries(input)) {
    if (value === undefined || IGNORED_INPUT_FIELDS.has(field) || field in constants) continue;
    entries.push([columnFor(table, record, field), value]);
  }
  return entries;
}

export function inputContainsServerNow(entries: readonly (readonly [ColumnSpec, unknown])[]): boolean {
  return entries.some(([spec, value]) => spec.type === "jsonb" && containsServerNow(value));
}

export function decodeColumn(spec: ColumnSpec, raw: unknown): unknown {
  if (raw === null || raw === undefined) return null;
  if (spec.type === "jsonb") return JSON.parse(raw as string);
  return raw;
}

export function revisionOf(row: Row): Revision {
  return String(row.revision) as Revision;
}

export function decodeRecord<T>(table: TableSpec, row: Row): T {
  const record: PlainObject = { ...(table.constants ?? {}) };
  for (const spec of table.columns) {
    const raw = row[spec.column];
    if (raw === null || raw === undefined) {
      if (spec.nullAs === "null") record[spec.field] = null;
      continue;
    }
    record[spec.field] = decodeColumn(spec, raw);
  }
  return record as T;
}

export function decodeStored<T>(table: TableSpec, row: Row): T & { readonly revision: Revision } {
  return { ...decodeRecord<T>(table, row), revision: revisionOf(row) };
}
