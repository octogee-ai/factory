import { FenceMismatchError } from "../../platform-state/errors.js";
export function assertRevisionFence(record, expected, actual) {
    if (expected === undefined || expected === actual)
        return;
    throw new FenceMismatchError(record, "revision", expected, actual);
}
