import { type PlatformAggregate, type RecordKey } from "../errors.js";
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
export declare function snakeCase(field: string): string;
export declare function column(field: string, type: ColumnType, options?: {
    readonly column?: string;
    readonly nullAs?: "absent" | "null";
}): ColumnSpec;
export declare function isServerNow(value: unknown): value is ServerNow;
export declare function isClearField(value: unknown): value is ClearField;
export declare function containsServerNow(value: unknown): boolean;
export declare function resolveJsonValue(value: unknown, now: number | undefined, nestedClears: NestedClears, path: string): unknown;
export declare function encodeColumn(spec: ColumnSpec, value: unknown, parameters: SqlParameters, now: number | undefined, nestedClears?: NestedClears): string;
export declare function castOf(spec: ColumnSpec): string;
export declare function columnFor(table: TableSpec, record: RecordKey, field: string): ColumnSpec;
export declare function assertConstants(table: TableSpec, record: RecordKey, input: object): void;
export declare function inputFields(table: TableSpec, record: RecordKey, input: object): [ColumnSpec, unknown][];
export declare function inputContainsServerNow(entries: readonly (readonly [ColumnSpec, unknown])[]): boolean;
export declare function decodeColumn(spec: ColumnSpec, raw: unknown): unknown;
export declare function revisionOf(row: Row): Revision;
export declare function decodeRecord<T>(table: TableSpec, row: Row): T;
export declare function decodeStored<T>(table: TableSpec, row: Row): T & {
    readonly revision: Revision;
};
