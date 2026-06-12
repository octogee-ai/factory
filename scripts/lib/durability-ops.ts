import type { Operation, OperationStatus } from "../../shared/types/glm.js";

// Pure helpers for the secret-durability harness's Leg 1 (cattle restore).
// The harness drives a real pod reroll the same way the admin Fleet panel
// would — by writing a `recycle-gateway` Operation into glmOperations and
// waiting for Cowboy (glm-controller) to reconcile it (scale 0→1, fresh pod,
// emptyDir cleared, boot-sync re-materializes). NOT `restart-gateway`, which
// is an in-process RPC restart that leaves the pod + auth dir untouched.

export interface BuildRecycleOperationInput {
  id: string;
  gatewayId: string;
  createdBy: string;
  now: number;
}

export function buildRecycleOperation(input: BuildRecycleOperationInput): Operation {
  return {
    id: input.id,
    kind: "recycle-gateway",
    status: "pending",
    createdBy: input.createdBy,
    createdAt: input.now,
    startedAt: null,
    completedAt: null,
    input: { gatewayId: input.gatewayId },
    steps: [],
  };
}

export type OperationOutcome = "pending" | "succeeded" | "failed";

export function classifyOperation(op: { status?: OperationStatus | string }): OperationOutcome {
  switch (op.status) {
    case "succeeded":
      return "succeeded";
    case "failed":
    case "rolled-back":
      return "failed";
    default:
      return "pending";
  }
}

export function isTerminal(op: { status?: OperationStatus | string }): boolean {
  return classifyOperation(op) !== "pending";
}
