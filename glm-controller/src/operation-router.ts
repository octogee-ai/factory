import type { Operation, OperationKind, OperationStep } from "../../shared/types/glm";

export interface OperationResult {
  steps: OperationStep[];
  success: boolean;
  error?: string;
  rolledBack?: boolean;
}

export type OperationHandler = (op: Operation) => Promise<OperationResult>;

export type OperationHandlers = Record<OperationKind, OperationHandler>;

export async function routeOperation(
  op: Operation,
  handlers: OperationHandlers,
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
    return await handler(op);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { steps: [], success: false, error: message };
  }
}

/**
 * Stub handler used in PR 1 — logs the op without running it. PR 2+
 * replace these with real handlers (migration runner from Phase 3,
 * helm-runner for add/retire, etc.).
 */
export function stubHandler(label: string, log: (msg: string) => void): OperationHandler {
  return async (op: Operation): Promise<OperationResult> => {
    log(
      `[glm-controller] stub ${label} op=${op.id} input=${JSON.stringify(op.input)} — would execute, returning success`,
    );
    return {
      steps: [{ name: `${label}-stub`, status: "done" }],
      success: true,
    };
  };
}
