import type { CustomerMigrationV2State, OperationStep } from "@octogee/shared/types/glm";
import type { OperationContext } from "./operation-router.js";

export interface PersistFn {
  (steps: OperationStep[]): Promise<void>;
}

export interface CreateOperationContextDeps {
  
  persist: PersistFn;
  persistCustomerMigrationV2?: (state: CustomerMigrationV2State) => Promise<void>;
  cancellationRequested?: () => Promise<boolean>;
  log: (msg: string) => void;
  
  opId: string;
}

export function createOperationContext(deps: CreateOperationContextDeps): {
  ctx: OperationContext;
  steps: OperationStep[];
} {
  const steps: OperationStep[] = [];

  const ctx: OperationContext = {
    reportStep: async (step: OperationStep) => {
      const idx = steps.findIndex(
        (s) => s.name === step.name && (s.status === "running" || s.status === "pending"),
      );
      if (idx >= 0) {
        const existing = steps.at(idx) ?? step;
        steps.splice(idx, 1, { ...existing, ...step });
      } else {
        steps.push(step);
      }
      try {
        await deps.persist([...steps]);
      } catch (err) {
        deps.log(
          `[glm-controller] ⚠ reportStep persist failed op=${deps.opId}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    },
    ...(deps.persistCustomerMigrationV2
      ? { persistCustomerMigrationV2: deps.persistCustomerMigrationV2 }
      : {}),
    ...(deps.cancellationRequested
      ? { cancellationRequested: deps.cancellationRequested }
      : {}),
  };

  return { ctx, steps };
}
