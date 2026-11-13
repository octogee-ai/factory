import { createHash, randomUUID } from "node:crypto";
import type { Firestore } from "firebase-admin/firestore";

export class WorkspaceStorageQuotaError extends Error {
  override readonly name = "WorkspaceStorageQuotaError";
  readonly code = "FREE_STORAGE_LIMIT";

  constructor(
    readonly limitBytes: number,
    readonly projectedBytes: number,
  ) {
    super(`Free workspace storage limit exceeded (${projectedBytes}/${limitBytes} bytes)`);
  }
}

export interface WorkspaceStorageReservation {
  slug: string;
  path: string;
  id: string;
  previousSize: number;
  newSize: number;
}

interface ReservationInput {
  slug: string;
  path: string;
  newSize: number;
  manifestBytes: number;
  manifestPathBytes: number;
  limitBytes: number;
}

function quotaRef(db: Firestore, slug: string) {
  return db.doc(`workspaces/${slug}/storageAccounting/quota`);
}

function entryRef(db: Firestore, slug: string, path: string) {
  const id = createHash("sha256").update(path).digest("hex");
  return db.doc(`workspaces/${slug}/storageAccountingEntries/${id}`);
}

function finiteBytes(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
}

export async function reserveWorkspaceStorage(
  db: Firestore,
  input: ReservationInput,
): Promise<WorkspaceStorageReservation> {
  const id = randomUUID();
  const quota = quotaRef(db, input.slug);
  const entry = entryRef(db, input.slug, input.path);
  return db.runTransaction(async (transaction) => {
    const [quotaSnap, entrySnap] = await Promise.all([
      transaction.get(quota),
      transaction.get(entry),
    ]);
    const quotaBytes = finiteBytes(quotaSnap.data()?.usedBytes) ?? input.manifestBytes;
    const entryData = entrySnap.data();
    if (entryData?.pending === true) {
      throw new Error(`workspace storage path ${input.path} already has a pending write`);
    }
    const previousSize = finiteBytes(entryData?.size) ?? input.manifestPathBytes;
    const projectedBytes = quotaBytes - previousSize + input.newSize;
    if (projectedBytes > input.limitBytes) {
      throw new WorkspaceStorageQuotaError(input.limitBytes, projectedBytes);
    }
    transaction.set(quota, {
      schemaVersion: 1,
      usedBytes: projectedBytes,
      limitBytes: input.limitBytes,
    });
    transaction.set(entry, {
      schemaVersion: 1,
      path: input.path,
      size: input.newSize,
      pending: true,
      reservationId: id,
    });
    return {
      slug: input.slug,
      path: input.path,
      id,
      previousSize,
      newSize: input.newSize,
    };
  });
}

export async function finalizeWorkspaceStorageReservation(
  db: Firestore,
  reservation: WorkspaceStorageReservation,
): Promise<void> {
  const entry = entryRef(db, reservation.slug, reservation.path);
  await db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(entry);
    if (snapshot.data()?.reservationId !== reservation.id) {
      throw new Error("workspace storage reservation was lost before commit");
    }
    transaction.set(entry, {
      schemaVersion: 1,
      path: reservation.path,
      size: reservation.newSize,
      pending: false,
    });
  });
}

export async function rollbackWorkspaceStorageReservation(
  db: Firestore,
  reservation: WorkspaceStorageReservation,
): Promise<void> {
  const quota = quotaRef(db, reservation.slug);
  const entry = entryRef(db, reservation.slug, reservation.path);
  await db.runTransaction(async (transaction) => {
    const [quotaSnap, entrySnap] = await Promise.all([
      transaction.get(quota),
      transaction.get(entry),
    ]);
    if (entrySnap.data()?.reservationId !== reservation.id) return;
    const usedBytes = finiteBytes(quotaSnap.data()?.usedBytes);
    if (usedBytes === null) throw new Error("workspace storage quota state is invalid");
    transaction.set(quota, {
      ...quotaSnap.data(),
      usedBytes: usedBytes - reservation.newSize + reservation.previousSize,
    });
    if (reservation.previousSize === 0) {
      transaction.delete(entry);
    } else {
      transaction.set(entry, {
        schemaVersion: 1,
        path: reservation.path,
        size: reservation.previousSize,
        pending: false,
      });
    }
  });
}

export async function releaseWorkspaceStorage(
  db: Firestore,
  input: { slug: string; path: string; removedBytes: number },
): Promise<void> {
  const quota = quotaRef(db, input.slug);
  const entry = entryRef(db, input.slug, input.path);
  await db.runTransaction(async (transaction) => {
    const [quotaSnap, entrySnap] = await Promise.all([
      transaction.get(quota),
      transaction.get(entry),
    ]);
    if (!quotaSnap.exists) return;
    const usedBytes = finiteBytes(quotaSnap.data()?.usedBytes);
    if (usedBytes === null) throw new Error("workspace storage quota state is invalid");
    const removedBytes = finiteBytes(entrySnap.data()?.size) ?? input.removedBytes;
    transaction.set(quota, {
      ...quotaSnap.data(),
      usedBytes: Math.max(0, usedBytes - removedBytes),
    });
    transaction.delete(entry);
  });
}
