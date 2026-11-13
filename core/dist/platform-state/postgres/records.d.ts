import { type FenceName, type RecordKey } from "../errors.js";
import type { Revision } from "../store.js";
import type { PostgresSession } from "./session.js";
import { SqlParameters, type Row } from "./sql.js";
import { type ColumnSpec, type TableSpec } from "./values.js";
export type FenceCheck = {
    readonly fence: "revision";
    readonly expected: Revision;
} | {
    readonly fence: FenceName;
    readonly column: ColumnSpec;
    readonly match: "equals" | "oneOf";
    readonly expected: unknown;
};
export interface RecordTarget {
    readonly table: TableSpec;
    readonly key: readonly unknown[];
}
export declare function revisionFence(expected: Revision | undefined): FenceCheck[];
export declare function equalsFence(fence: FenceName, spec: ColumnSpec, expected: unknown): FenceCheck[];
export declare function oneOfFence(fence: FenceName, spec: ColumnSpec, expected: readonly unknown[] | undefined): FenceCheck[];
export declare function recordKeyOf(target: RecordTarget): RecordKey;
export declare function keyPredicate(target: RecordTarget, parameters: SqlParameters): string;
export declare function serverNow(session: PostgresSession): Promise<number>;
export declare function selectRecords(session: PostgresSession, operation: string, text: string, values?: readonly unknown[]): Promise<readonly Row[]>;
export declare function selectByKey(session: PostgresSession, operation: string, target: RecordTarget): Promise<Row | null>;
export declare function insertRecord(session: PostgresSession, operation: string, table: TableSpec, input: object, mode: "create" | "put"): Promise<void>;
export declare function updateRecord(session: PostgresSession, operation: string, target: RecordTarget, patch: object, fences: readonly FenceCheck[]): Promise<void>;
export declare function mergeJsonColumn(session: PostgresSession, operation: string, target: RecordTarget, spec: ColumnSpec, additions: object, fences: readonly FenceCheck[]): Promise<void>;
export declare function deleteRecord(session: PostgresSession, operation: string, target: RecordTarget, fences?: readonly FenceCheck[]): Promise<void>;
