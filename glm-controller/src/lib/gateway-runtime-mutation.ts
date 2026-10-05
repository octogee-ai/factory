import type { Firestore, Transaction } from 'firebase-admin/firestore';
import { assertGatewayRuntimeMutationUnfenced } from '@octogee/core/gateway-retirement-claim';

let runtimeMutationTail: Promise<unknown> = Promise.resolve();

export function runGatewayRuntimeExclusive<T>(work: () => Promise<T>): Promise<T> {
  const pending = runtimeMutationTail.then(work);
  runtimeMutationTail = pending.catch(() => undefined);
  return pending;
}

export async function withGatewayRuntimeMutation<T>(
  db: Firestore,
  gatewayId: string,
  mutation: (transaction: Transaction) => Promise<T>,
): Promise<T> {
  return db.runTransaction(async transaction => {
    await assertGatewayRuntimeMutationUnfenced(db,transaction,gatewayId);
    return mutation(transaction);
  });
}
