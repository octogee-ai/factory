import type { DocumentReference, Firestore } from "firebase-admin/firestore";
import type {
  PlatformUserRecord,
  OperationRecord,
  PlatformStateStore,
  PlatformStateTransaction,
  Stored,
} from "@octogee/core/platform-state";

const FIRESTORE_WRITE_BATCH_SIZE = 400;
const CLEAR = { clear: true } as const;

type VisibilityWrite = {
  kind: "update" | "delete";
  ref: DocumentReference;
};

type PlatformWrite = (transaction: PlatformStateTransaction) => Promise<void>;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function migrationOwnerUid(operation: OperationRecord): string | null {
  if (typeof operation.inputUid === "string") return operation.inputUid;
  const input: unknown = operation.input;
  if (!isPlainRecord(input)) return null;
  return typeof input.uid === "string" ? input.uid : null;
}

function migrationNeedsCancellationRequest(operation: OperationRecord): boolean {
  if (operation.status === "running" || operation.customerMigrationV2 !== undefined) return true;
  const handoff: unknown = operation.schedulerHandoff;
  if (isPlainRecord(handoff) && handoff.forwardRecovery !== undefined) return true;
  const output: unknown = operation.output;
  if (!isPlainRecord(output)) return false;
  const cleanup = output.configCleanup;
  return cleanup !== null && typeof cleanup === "object";
}

function ownedLiveMigration(operation: Stored<OperationRecord> | null, uid: string): operation is Stored<OperationRecord> {
  return operation !== null &&
    operation.kind === "migrate-customer" &&
    migrationOwnerUid(operation) === uid &&
    (operation.status === "pending" || operation.status === "running");
}

async function commitPlatformWrites(store: PlatformStateStore, label: string, writes: readonly PlatformWrite[]): Promise<void> {
  for (let offset = 0; offset < writes.length; offset += FIRESTORE_WRITE_BATCH_SIZE) {
    const chunk = writes.slice(offset, offset + FIRESTORE_WRITE_BATCH_SIZE);
    await store.transaction({ label }, async (transaction) => {
      for (const write of chunk) await write(transaction);
    });
  }
}

export async function cancelUserMigrationsForSuspension(
  store: PlatformStateStore,
  uid: string,
  deletionId: string,
  now: number,
): Promise<boolean> {
  const operations = await store.journal.operations.listByStatus(["pending", "running"]);
  let pending = false;
  for (const operation of operations) {
    if (!ownedLiveMigration(operation, uid)) continue;
    const stillPending = await store.transaction({ label: "customer-suspension.cancel-migration" }, async (transaction) => {
      const current = await transaction.journal.operations.get(operation.id);
      if (!ownedLiveMigration(current, uid)) return false;
      if (migrationNeedsCancellationRequest(current)) {
        await transaction.journal.operations.patch(current.id, { cancellationRequestedAt: now }, { status: [current.status] });
        return true;
      }
      await transaction.journal.operations.patch(current.id, {
        status: "failed",
        completedAt: now,
        error: "user migration cancelled because the account was suspended",
        rolledBack: false,
        nextAttemptAt: CLEAR,
        waitingOn: CLEAR,
        cancelledByDeletionId: deletionId,
      }, { status: [current.status] });
      return false;
    });
    pending ||= stillPending;
  }
  return pending;
}

function assertIsolatedRuntimeUnfenced(user: Stored<PlatformUserRecord> | null): void {
  if (user?.fences.restoreFence !== undefined) throw new Error("user restore is in progress");
  if (user?.fences.sourceTransferFence !== undefined) throw new Error("user source transfer is in progress");
}

export async function assertUserRestoreNotInProgress(
  store: PlatformStateStore,
  uid: string,
): Promise<void> {
  assertIsolatedRuntimeUnfenced(await store.users.records.get(uid));
}

export async function releaseUserPlacement(
  store: PlatformStateStore,
  uid: string,
  capturedGatewayId: string | null,
): Promise<void> {
  await store.transaction({ label: "customer-suspension.release-placement" }, async (transaction) => {
    const user = await transaction.users.records.get(uid);
    assertIsolatedRuntimeUnfenced(user);
    for (const gatewayId of new Set([capturedGatewayId, user?.gateway?.gatewayId ?? null])) {
      if (gatewayId) await transaction.gateways.assignments.delete(gatewayId, uid);
    }
    if (user === null) return;
    await transaction.users.records.setGatewayMirror(uid, CLEAR);
    await transaction.users.records.setFence(uid, "migration", CLEAR);
  });
}

export async function deactivateUserVisibility(
  store: PlatformStateStore,
  db: Pick<Firestore, "collection" | "batch">,
  uid: string,
): Promise<void> {
  const [workspaces, projects, posts, ...socialSnapshots] = await Promise.all([
    store.workspaces.records.listByOwner(uid),
    store.workspaces.projects.listByOwner(uid),
    db.collection("posts").where("authorUid", "==", uid).get(),
    db.collection("feed").where("actorUid", "==", uid).get(),
    db.collection("feed").where("targetUid", "==", uid).get(),
    db.collection("stars").where("actorUid", "==", uid).get(),
    db.collection("stars").where("target.ownerUid", "==", uid).get(),
    db.collection("follows").where("actorUid", "==", uid).get(),
    db.collection("follows").where("target.ownerUid", "==", uid).get(),
  ]);
  await commitPlatformWrites(store, "customer-suspension.deactivate-visibility", [
    ...workspaces.map((workspace): PlatformWrite => (transaction) =>
      transaction.workspaces.records.patch(workspace.slug, { ownerActive: false })),
    ...projects.map((project): PlatformWrite => (transaction) =>
      transaction.workspaces.projects.patch(project.workspaceSlug, project.projectSlug, { ownerActive: false })),
  ]);
  const writes: VisibilityWrite[] = [
    ...posts.docs.map((doc) => ({ kind: "update" as const, ref: doc.ref })),
    ...Array.from(new Map(
      socialSnapshots
        .flatMap((snapshot) => snapshot.docs)
        .map((doc) => [doc.ref.path, doc.ref]),
    ).values(), (ref) => ({ kind: "delete" as const, ref })),
  ];
  for (let offset = 0; offset < writes.length; offset += FIRESTORE_WRITE_BATCH_SIZE) {
    const batch = db.batch();
    for (const write of writes.slice(offset, offset + FIRESTORE_WRITE_BATCH_SIZE)) {
      if (write.kind === "update") batch.update(write.ref, { ownerActive: false });
      else batch.delete(write.ref);
    }
    await batch.commit();
  }
}

export async function invalidatePendingCredentialFlows(
  db: Pick<Firestore, "collection" | "batch">,
  uid: string,
): Promise<void> {
  const [connectorFlows, byosubFlows] = await Promise.all([
    db.collection("connectFlows").where("uid", "==", uid).get(),
    db.collection("byosubFlows").where("uid", "==", uid).get(),
  ]);
  const batch = db.batch();
  for (const flow of [...connectorFlows.docs, ...byosubFlows.docs]) batch.delete(flow.ref);
  await batch.commit();
}

export async function revokeOwnerModelBrokerTokens(
  store: PlatformStateStore,
  uid: string,
  now: number,
): Promise<void> {
  const [tokens, pointers] = await Promise.all([
    store.access.modelBrokerTokens.listForOwner(uid),
    store.access.modelBrokerGatewayTokens.listForOwner(uid),
  ]);
  await commitPlatformWrites(store, "customer-suspension.revoke-model-broker-tokens", [
    ...tokens.map((token): PlatformWrite => (transaction) =>
      transaction.access.modelBrokerTokens.revoke(token.tokenHash, now)),
    ...pointers.map((pointer): PlatformWrite => (transaction) =>
      transaction.access.modelBrokerGatewayTokens.delete(pointer.pointerKey)),
  ]);
}
