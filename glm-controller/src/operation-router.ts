import type { Operation, OperationKind, OperationStep } from "../../shared/types/glm";

export interface OperationResult {
  steps: OperationStep[];
  success: boolean;
  error?: string;
  rolledBack?: boolean;
}

/**
 * Per-operation handler context. Carries side-effect callbacks the
 * handler needs to publish progress as it runs — most importantly
 * `reportStep`, which writes incremental step records to Firestore so
 * the admin UI can render live progress.
 */
export interface OperationContext {
  reportStep: (step: OperationStep) => Promise<void> | void;
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

