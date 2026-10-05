import { FieldValue, type Firestore } from "firebase-admin/firestore";
import { customerRuntimeMutationFenced, GATEWAY_ASSIGNMENTS_SUBCOLLECTION } from "@octogee/shared/types/gateway-releases";
import { GLM_OPERATIONS_COLLECTION, type Operation } from "@octogee/shared/types/glm";
import { GATEWAYS_COLLECTION } from "@octogee/shared/types/fleet-controller";
import { readWorkspaceMigrationMarker } from "@octogee/shared/types/workspace-migration";

export function legacyAttemptNeverQuiesced(operation: Operation): boolean {
  if (operation.customerMigrationV2 !== undefined ||
      ![operation.input.fromGatewayId, operation.input.toGatewayId].every((id) => typeof id === "string" && id.startsWith("shared-"))) return false;
  const attempt = Number(operation.schedulerHandoff?.migrationId.split(":").at(-1));
  if (!Number.isSafeInteger(attempt) || attempt < 1) return false;
  const prior = operation.attemptHistory?.slice().reverse().find((entry) => entry.attempt === attempt);
  const steps = prior?.steps ?? (operation.attempts === attempt ? operation.steps : undefined);
  return steps?.length === 1 && steps[0]?.name === "keys-sync-state" && steps[0].status === "failed";
}

function recoverableLegacyScope(operation: Operation & { cancellationRequestedAt?: number }): boolean {
  const input = operation.input;
  const handoff = operation.schedulerHandoff;
  if (!handoff || typeof input.fromGatewayId !== "string" || typeof input.toGatewayId !== "string") return false;
  const attempt = Number(handoff.migrationId.split(":").at(-1));
  return [
    operation.kind === "migrate-customer", operation.customerMigrationV2 === undefined,
    operation.cutoverCommittedAt === undefined, operation.cancellationRequestedAt === undefined,
    operation.sourceTransferExecution === undefined, input.sourceTransferMode === undefined,
    Array.isArray(operation.steps),
    typeof input.uid === "string", input.fromGatewayId.startsWith("shared-"), input.toGatewayId.startsWith("shared-"), input.fromGatewayId !== input.toGatewayId,
    handoff.uid === input.uid, handoff.fromGatewayId === input.fromGatewayId, handoff.toGatewayId === input.toGatewayId,
    handoff.stageAfterCutover !== true, Number.isSafeInteger(attempt), attempt > 0,
    handoff.migrationId === `mig-${operation.id}:scheduler:${attempt}`,
  ].every(Boolean);
}

function ownsLegacySource(operation: Operation, user: FirebaseFirestore.DocumentData | undefined, assignment: FirebaseFirestore.DocumentData | undefined, targetExists: boolean): boolean {
  const openclaw = user?.provisioning?.openclaw;
  if (!assignment || !openclaw) return false;
  return [
    !customerRuntimeMutationFenced(user), !targetExists, openclaw.gatewayId === operation.input.fromGatewayId,
    readWorkspaceMigrationMarker(openclaw)?.operationId === operation.id,
    assignment.uid === operation.input.uid, assignment.gatewayId === operation.input.fromGatewayId,
    Number.isSafeInteger(assignment.epoch), assignment.epoch >= 0,
    assignment.state === "serving" || assignment.state === "quiescing" && assignment.updatedByOperationId === operation.id,
  ].every(Boolean);
}

function abandonedAttempt(operation: Operation, now: number): { attempt: number; history: NonNullable<Operation["attemptHistory"]> } {
  const attempt = operation.status === "running"
    ? (operation.attempts ?? 0) + 1
    : Math.max(operation.attempts ?? 0, Number(operation.schedulerHandoff!.migrationId.split(":").at(-1)));
  const abandoned = attempt > (operation.attempts ?? 0) ? [{
    attempt, startedAt: operation.startedAt ?? now, completedAt: now,
    error: operation.error ?? "controller restarted mid-op; native source recovery required",
    classification: "transient" as const, steps: operation.steps,
  }] : [];
  return { attempt, history: [...operation.attemptHistory ?? [], ...abandoned].slice(-20) };
}

export async function rearmOwnedLegacyMigration(input: {
  db: Firestore;
  ref: FirebaseFirestore.DocumentReference;
  now: number;
  admitted: (operation: Operation) => boolean;
}): Promise<boolean> {
  return input.db.runTransaction(async (txn) => {
    const snapshot = await txn.get(input.ref);
    const operation = { ...snapshot.data(), id: input.ref.id } as Operation;
    if (!snapshot.exists || operation.kind !== "migrate-customer" || !operation.input ||
        !input.admitted(operation) || !recoverableLegacyScope(operation)) return false;
    const { uid, fromGatewayId, toGatewayId } = operation.input as { uid: string; fromGatewayId: string; toGatewayId: string };
    const [user, source, target] = await Promise.all([
      txn.get(input.db.collection("users").doc(uid)),
      txn.get(input.db.collection(GATEWAYS_COLLECTION).doc(fromGatewayId).collection(GATEWAY_ASSIGNMENTS_SUBCOLLECTION).doc(uid)),
      txn.get(input.db.collection(GATEWAYS_COLLECTION).doc(toGatewayId).collection(GATEWAY_ASSIGNMENTS_SUBCOLLECTION).doc(uid)),
    ]);
    if (!ownsLegacySource(operation, user.data(), source.data(), target.exists)) return false;
    const { attempt, history } = abandonedAttempt(operation, input.now);
    txn.update(input.ref, {
      status: "pending", startedAt: null, completedAt: null, steps: [],
      "input.recoverSourceOnly": true,
      attempts: Math.max(operation.attempts ?? 0, attempt),
      attemptHistory: history,
      error: FieldValue.delete(), expireAt: FieldValue.delete(), lastProgressAt: FieldValue.delete(),
      nextAttemptAt: FieldValue.delete(), waitingOn: FieldValue.delete(), rolledBack: FieldValue.delete(),
    });
    return true;
  });
}

export async function recoverFailedLegacyMigrations(deps: { db: Firestore; log: (message: string) => void; now: () => number }): Promise<void> {
  const snapshot = await deps.db.collection(GLM_OPERATIONS_COLLECTION).where("status", "==", "failed").get();
  for (const doc of snapshot.docs) {
    try {
      const rearmed = await rearmOwnedLegacyMigration({ db: deps.db, ref: doc.ref, now: deps.now(), admitted: (operation) =>
        operation.status === "failed" && typeof operation.error === "string" &&
        (/^reaped: (?:controller restarted mid-op|op exceeded \d+m running budget)/.test(operation.error) || /gateway starting; retry shortly|rsync import port \d+ is already serving migrationId=/.test(operation.error) ||
          operation.input.recoverSourceOnly === true && legacyAttemptNeverQuiesced(operation) && /voice migration resume failed: HTTP 409/.test(operation.error)),
      });
      if (rearmed) deps.log(`[migration-recovery] queued native source recovery for ${doc.id}; assignment and marker remain held`);
    } catch (error) {
      deps.log(`[migration-recovery] ${doc.id} recovery admission failed: ${String(error)}`);
    }
  }
}
