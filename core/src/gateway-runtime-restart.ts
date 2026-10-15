import { isDeepStrictEqual } from "node:util";
import { FieldValue, type DocumentData, type Firestore, type Transaction } from "firebase-admin/firestore";

export interface RuntimeRestartFence {
  attemptId: string;
  auditId: string;
  gatewayId: string;
  kind: "process" | "deployment";
  startedAt: number;
  phase: "reserved" | "dispatched" | "acknowledged";
  target?: Record<string, unknown>;
  acknowledgement?: Record<string, unknown>;
}

export async function updateRuntimeRestart(
  db: Firestore,
  current: RuntimeRestartFence,
  next: RuntimeRestartFence | null,
  validate?: (transaction: Transaction, root: DocumentData) => Promise<void>,
): Promise<void> {
  await db.runTransaction(async transaction => {
    const ref = db.doc(`gateways/${current.gatewayId}`);
    const root = await transaction.get(ref);
    const data = root.data();
    if (!data || !isDeepStrictEqual(data.runtimeRestartFence, current)) throw new Error("gateway runtime restart fence changed");
    await validate?.(transaction, data);
    transaction.update(ref, { runtimeRestartFence: next ?? FieldValue.delete() });
  });
}
