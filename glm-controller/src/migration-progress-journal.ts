import type { FleetStateFirestore } from "@octogee/core/fleet-state";
import { GATEWAYS_COLLECTION } from "@octogee/shared/types/fleet-controller";
import { GATEWAY_ASSIGNMENTS_SUBCOLLECTION } from "@octogee/shared/types/gateway-releases";
import { GLM_OPERATIONS_COLLECTION, isMigrationProgressRecord, type MigrationProgressRecord, type Operation } from "@octogee/shared/types/glm";

export interface ProgressJournalDeps {
  db: FleetStateFirestore;
  log: (message: string) => void;
  now?: () => number;
}

function sameAttempt(a: MigrationProgressRecord, b: MigrationProgressRecord): boolean {
  return a.migrationId === b.migrationId && (a.attempt ?? 0) === (b.attempt ?? 0);
}

export function compactProgress(existing: unknown, event: MigrationProgressRecord): MigrationProgressRecord[] {
  const current = Array.isArray(existing) ? existing.filter(isMigrationProgressRecord) : [];
  return [
    ...current.filter((record) => sameAttempt(record, event) && record.phase !== event.phase),
    event,
  ];
}

export async function journalOperationProgress(
  deps: ProgressJournalDeps,
  claimed: Operation,
  event: MigrationProgressRecord,
): Promise<void> {
  const ref = deps.db.collection(GLM_OPERATIONS_COLLECTION).doc(claimed.id);
  await deps.db.runTransaction(async (txn) => {
    const fresh = await txn.get(ref);
    const data = fresh.exists ? fresh.data() as Operation | undefined : undefined;
    if (data?.status !== "running" || data.startedAt !== claimed.startedAt) {
      deps.log(`[glm-controller] op=${claimed.id} progress ${event.phase}:${event.status} discarded because this attempt no longer owns a running operation (status=${data?.status ?? "missing"})`);
      return;
    }
    txn.update(ref, { progress: compactProgress(data.progress, event), lastProgressAt: (deps.now ?? Date.now)() });
  });
}

export async function journalHandoffProgress(
  deps: ProgressJournalDeps,
  input: { gatewayId: string; uid: string },
  event: MigrationProgressRecord,
): Promise<void> {
  const gateway = deps.db.collection(GATEWAYS_COLLECTION).doc(input.gatewayId);
  if (!gateway.collection) throw new Error("FleetStateFirestore doc ref does not support subcollections");
  const ref = gateway.collection(GATEWAY_ASSIGNMENTS_SUBCOLLECTION).doc(input.uid);
  await deps.db.runTransaction(async (txn) => {
    const fresh = await txn.get(ref);
    if (!fresh.exists) {
      deps.log(`[glm-controller] handoff progress ${event.phase}:${event.status} discarded because gateways/${input.gatewayId}/assignments/${input.uid} is gone`);
      return;
    }
    txn.update(ref, { handoffProgress: compactProgress(fresh.data()?.handoffProgress, event) });
  });
}
