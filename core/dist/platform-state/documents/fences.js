import { isDeepStrictEqual } from "node:util";
import { FenceMismatchError } from "../errors.js";
export function assertFenceEquals(record, fence, expected, actual) {
    if (expected === undefined)
        return;
    const stored = actual === undefined ? null : actual;
    if (isDeepStrictEqual(expected, stored))
        return;
    throw new FenceMismatchError(record, fence, expected, stored);
}
export function assertFenceOneOf(record, fence, allowed, actual) {
    if (allowed === undefined || allowed.some((value) => isDeepStrictEqual(value, actual)))
        return;
    throw new FenceMismatchError(record, fence, allowed, actual);
}
export function assertAbsentFence(record, existingRevision) {
    if (existingRevision === null)
        return;
    throw new FenceMismatchError(record, "absent", "absent", existingRevision);
}
