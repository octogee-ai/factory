import { isAssignmentState } from "@octogee/shared/types/gateway-releases";
import { parseAssignmentDoc } from "../../assignment-doc.js";
import { MalformedRecordError } from "../errors.js";
export const assignmentKey = (gatewayId, uid) => ({
    aggregate: "gateway-assignment",
    key: `${gatewayId}/${uid}`,
});
export function storedFieldDetail(field, value) {
    return value === undefined ? `has no ${field}` : `stores ${field} ${JSON.stringify(value)}`;
}
export function isFenceCount(value) {
    return Number.isSafeInteger(value) && value >= 0;
}
export function assertStoredFences(key, uid, data) {
    if (data.uid !== uid)
        throw new MalformedRecordError(key, storedFieldDetail("uid", data.uid));
    if (!isAssignmentState(data.state))
        throw new MalformedRecordError(key, storedFieldDetail("state", data.state));
    if (!isFenceCount(data.epoch))
        throw new MalformedRecordError(key, storedFieldDetail("epoch", data.epoch));
    if (data.updatedAt !== undefined && !isFenceCount(data.updatedAt)) {
        throw new MalformedRecordError(key, storedFieldDetail("updatedAt", data.updatedAt));
    }
    const operationId = data.updatedByOperationId;
    if (operationId !== undefined && operationId !== null && typeof operationId !== "string") {
        throw new MalformedRecordError(key, storedFieldDetail("updatedByOperationId", operationId));
    }
}
export function decodeGatewayAssignmentData(gatewayId, uid, data) {
    const key = assignmentKey(gatewayId, uid);
    let assignment;
    try {
        assignment = parseAssignmentDoc(uid, data);
    }
    catch (error) {
        throw new MalformedRecordError(key, error instanceof Error ? error.message : String(error));
    }
    if (assignment === null)
        throw new MalformedRecordError(key, "is not a complete assignment");
    if (assignment.gatewayId !== gatewayId) {
        throw new MalformedRecordError(key, `stores gatewayId ${JSON.stringify(assignment.gatewayId)}`);
    }
    assertStoredFences(key, uid, data);
    return assignment;
}
