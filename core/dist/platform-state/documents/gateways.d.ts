import { type RecordKey } from "../errors.js";
import type { GatewayAssignment } from "../gateways.js";
export declare const assignmentKey: (gatewayId: string, uid: string) => RecordKey;
export declare function storedFieldDetail(field: string, value: unknown): string;
export declare function isFenceCount(value: unknown): value is number;
export declare function assertStoredFences(key: RecordKey, uid: string, data: Record<string, unknown>): void;
export declare function decodeGatewayAssignmentData(gatewayId: string, uid: string, data: Record<string, unknown>): GatewayAssignment;
