import type { SchedulerHandoffState } from "@octogee/shared/types/glm";
import type {
  CustomerMigrationV2State,
  Operation,
  OperationKind,
  OperationStep,
} from "@octogee/shared/types/glm";

export interface OperationResult {
  steps: OperationStep[];
  success: boolean;
  error?: string;
  rolledBack?: boolean;
  output?: Record<string, unknown>;
  scrubInputOnSuccess?: boolean;
}

export interface OperationContext {
  reportStep: (step: OperationStep) => Promise<void> | void;
  persistSchedulerHandoff?: (state: SchedulerHandoffState) => Promise<void>;
  persistCustomerMigrationV2?: (state: CustomerMigrationV2State) => Promise<void>;
  persistCutoverCommitted?: (at: number) => Promise<void>;
  cancellationRequested?: () => Promise<boolean>;
}

export type OperationHandler = (
  op: Operation,
  ctx: OperationContext,
) => Promise<OperationResult>;

export type OperationHandlers = Record<OperationKind, OperationHandler>;

export async function routeOperation(
  op: Operation,
  handlers: OperationHandlers,
  ctx: OperationContext,
): Promise<OperationResult> {
  const handler = handlers[op.kind as OperationKind];
  if (!handler) {
    return {
      steps: [],
      success: false,
      error: `unknown operation kind: ${String(op.kind)}`,
    };
  }
  try {
    return await handler(op, ctx);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { steps: [], success: false, error: message };
  }
}
