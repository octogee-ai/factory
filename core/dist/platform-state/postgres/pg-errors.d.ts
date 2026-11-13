import { type PlatformAggregate, type RecordKey } from "../errors.js";
export declare const TABLE_AGGREGATES: Readonly<Record<string, PlatformAggregate>>;
export declare function sqlState(error: unknown): string | undefined;
export declare function isContention(error: unknown): boolean;
export declare function isConnectionLoss(error: unknown): boolean;
export declare function translateWriteError(error: unknown, record: RecordKey): unknown;
