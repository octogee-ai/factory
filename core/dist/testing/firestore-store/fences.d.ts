import { type RecordKey } from "../../platform-state/errors.js";
import type { Revision } from "../../platform-state/store.js";
export declare function assertRevisionFence(record: RecordKey, expected: Revision | undefined, actual: Revision): void;
