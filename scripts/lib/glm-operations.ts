import type { OperationKind, OperationStatus } from "../../shared/types/glm.js";
import type { OperationRecord, PlatformStateStore, Stored } from "@octogee/core/platform-state";

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
  store: PlatformStateStore,
  opts: EnqueueOperationInput,
): Promise<string> {
  const now = opts.now ?? Date.now;
  const gatewayId =
    typeof opts.input.gatewayId === "string" ? opts.input.gatewayId : null;
  const inputUid = typeof opts.input.uid === "string" ? opts.input.uid : null;
  return store.journal.operations.enqueue({
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
}

export function readOperation(
  store: PlatformStateStore,
  opId: string,
): Promise<Stored<OperationRecord> | null> {
  return store.journal.operations.get(opId);
}

export interface AwaitOperationOptions {
  pollMs?: number;
  timeoutMs?: number;
  onUpdate?: (op: Stored<OperationRecord>) => void;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export async function awaitOperation(
  store: PlatformStateStore,
  opId: string,
  opts: AwaitOperationOptions = {},
): Promise<Stored<OperationRecord>> {
  const pollMs = opts.pollMs ?? 2_000;
  const timeoutMs = opts.timeoutMs ?? 600_000;
  const now = opts.now ?? Date.now;
  const sleep =
    opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const deadline = now() + timeoutMs;
  let lastStepSig = "";

  for (;;) {
    const op = await readOperation(store, opId);
    if (!op) {
      throw new Error(`operation ${opId} not found`);
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
