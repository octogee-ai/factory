import type { GatewayClass, OperationKind } from "@octogee/shared/types/glm";
export declare function currentOperationKind(stored: unknown): unknown;
export declare function operationKindsStoredAs(kind: OperationKind): string[];
export declare function currentAssignmentSource(stored: unknown): unknown;
export declare function currentAuditMutation(mutation: unknown): unknown;
export declare function auditMutationsStoredAs(mutation: Record<string, unknown>): Record<string, unknown>[];
export declare function gatewayClassesStoredAs(gatewayClass: GatewayClass): string[];
