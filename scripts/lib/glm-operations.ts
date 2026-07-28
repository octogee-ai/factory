import {
  GLM_OPERATIONS_COLLECTION,
  type Operation,
  type OperationKind,
  type OperationStatus,
} from "../../shared/types/glm.js";
import type { OperationsDb } from "@octogee/core/operation-audit";

export * from "@octogee/core/operation-audit";

const TERMINAL_STATUSES: ReadonlySet<OperationStatus> = new Set([
  "succeeded",
  "failed",
  "rolled-back",
]);

export function isTerminalStatus(status: OperationStatus): boolean {
  return TERMINAL_STATUSES.has(status);
}

export interface EnqueueOperationInput {
  kind: OperationKind;
  input: Record<string, unknown>;
  createdBy: string;
  now?: () => number;
}

export async function enqueueOperation(
  db: OperationsDb,
  opts: EnqueueOperationInput,
): Promise<string> {
  const now = opts.now ?? Date.now;
  const gatewayId =
    typeof opts.input.gatewayId === "string" ? opts.input.gatewayId : null;
  const inputUid = typeof opts.input.uid === "string" ? opts.input.uid : null;
  const ref = await db.collection(GLM_OPERATIONS_COLLECTION).add({
    kind: opts.kind,
    status: "pending",
    createdBy: opts.createdBy,
    createdAt: now(),
    startedAt: null,
    completedAt: null,
    input: opts.input,
    steps: [],
    ...(gatewayId !== null ? { gatewayId } : {}),
    ...(inputUid !== null ? { inputUid } : {}),
  });
  return ref.id;
}

export async function readOperation(
  db: OperationsDb,
  opId: string,
): Promise<Operation | null> {
  const snap = await db.collection(GLM_OPERATIONS_COLLECTION).doc(opId).get();
  if (!snap.exists) return null;
  const data = snap.data() ?? {};
  return { id: snap.id, ...(data as Omit<Operation, "id">) };
}

export interface AwaitOperationOptions {
  pollMs?: number;
  timeoutMs?: number;
  onUpdate?: (op: Operation) => void;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export async function awaitOperation(
  db: OperationsDb,
  opId: string,
  opts: AwaitOperationOptions = {},
): Promise<Operation> {
  const pollMs = opts.pollMs ?? 2_000;
  const timeoutMs = opts.timeoutMs ?? 600_000;
  const now = opts.now ?? Date.now;
  const sleep =
    opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const deadline = now() + timeoutMs;
  let lastStepSig = "";

  for (;;) {
    const op = await readOperation(db, opId);
    if (!op) {
      throw new Error(
        `operation ${opId} not found in ${GLM_OPERATIONS_COLLECTION}`,
      );
    }
    if (opts.onUpdate) {
      const sig = JSON.stringify(op.steps ?? []);
      if (sig !== lastStepSig) {
        lastStepSig = sig;
        opts.onUpdate(op);
      }
    }
    if (isTerminalStatus(op.status)) return op;
    if (now() >= deadline) {
      throw new Error(
        `operation ${opId} did not finish within ${timeoutMs}ms (last status: ${op.status})`,
      );
    }
    await sleep(pollMs);
  }
}
