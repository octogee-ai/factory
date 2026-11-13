import { isDeepStrictEqual } from "node:util";
import { FenceMismatchError, type FenceName, type RecordKey } from "../errors.js";
import type { Revision } from "../store.js";

export function assertFenceEquals(record: RecordKey, fence: FenceName, expected: unknown, actual: unknown): void {
  if (expected === undefined) return;
  const stored = actual === undefined ? null : actual;
  if (isDeepStrictEqual(expected, stored)) return;
  throw new FenceMismatchError(record, fence, expected, stored);
}

export function assertFenceOneOf<T>(
  record: RecordKey,
  fence: FenceName,
  allowed: readonly T[] | undefined,
  actual: unknown,
): void {
  if (allowed === undefined || allowed.some((value) => isDeepStrictEqual(value, actual))) return;
  throw new FenceMismatchError(record, fence, allowed, actual);
}

export function assertAbsentFence(record: RecordKey, existingRevision: Revision | null): void {
  if (existingRevision === null) return;
  throw new FenceMismatchError(record, "absent", "absent", existingRevision);
}
