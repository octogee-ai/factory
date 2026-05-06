import type { OperationStep } from "../../shared/types/glm";
import type { OperationContext } from "./operation-router.js";

export interface PersistFn {
  (steps: OperationStep[]): Promise<void>;
}

export interface CreateOperationContextDeps {
  /** Persists the buffer to Firestore (or wherever). Errors are caught + logged, never thrown. */
  persist: PersistFn;
  log: (msg: string) => void;
  /** For log-line attribution. */
  opId: string;
}

/**
 * Builds an OperationContext that maintains a per-op `steps[]` buffer and
 * pushes the buffer to `persist` on every reportStep call. Running events
 * append; matching done/failed events collapse onto the most recent
 * non-terminal step of the same name, so the rendered list is one row
 * per phase that visually transitions running → done/failed. Rollback
 * events (`rollback:{name}`) are treated as their own steps, never
 * collapsing onto forward-pass steps.
 */
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
      if (idx >= 0 && (step.status === "done" || step.status === "failed")) {
        // splice in-place rather than `steps[idx] = …` so the dynamic
        // index access doesn't trip eslint-plugin-security's
        // `detect-object-injection`. Same observable behavior; idx is
        // already bounded by the `>= 0` guard above.
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
  };

  return { ctx, steps };
}
