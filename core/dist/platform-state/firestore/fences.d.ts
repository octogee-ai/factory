import { type FenceName, type RecordKey } from "../errors.js";
import type { Revision } from "../store.js";
export declare function assertRevisionFence(record: RecordKey, expected: Revision | undefined, actual: Revision): void;
export declare function assertFenceEquals(record: RecordKey, fence: FenceName, expected: unknown, actual: unknown): void;
export declare function assertFenceOneOf<T>(record: RecordKey, fence: FenceName, allowed: readonly T[] | undefined, actual: unknown): void;
export declare function assertAbsentFence(record: RecordKey, existingRevision: Revision | null): void;
