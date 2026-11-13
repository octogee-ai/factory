import { FenceMismatchError, type RecordKey } from "../../platform-state/errors.js";
import type { Revision } from "../../platform-state/store.js";

export function assertRevisionFence(record: RecordKey, expected: Revision | undefined, actual: Revision): void {
  if (expected === undefined || expected === actual) return;
  throw new FenceMismatchError(record, "revision", expected, actual);
}
