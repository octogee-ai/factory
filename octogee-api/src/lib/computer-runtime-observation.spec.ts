import type { Firestore } from "firebase-admin/firestore";
import { expect, it } from "vitest";
import { COMPUTER_DISK_OBSERVATION_REFRESH_MS, recordComputerDiskObservation, recordComputerHomeCheckpoint } from "./computer-runtime-observation.js";

function fixture(exists = true) {
  let data: Record<string, unknown> = { vmHome: {} };
  const writes: unknown[] = [];
  const ref = { get: async () => ({ exists, data: () => data }), set: async (next: Record<string, unknown>) => { data = { ...data, ...next }; writes.push(next); } };
  const db = { doc: () => ref, runTransaction: async (work: (transaction: unknown) => Promise<void>) => work({ get: ref.get, set: (_ref: unknown, next: Record<string, unknown>) => ref.set(next) }) } as unknown as Firestore;
  return { db, writes, home: () => data.vmHome };
}
const home = (name: string, requestedAt: number | null) => ({ checkpointAcknowledgedAt: requestedAt, lastCheckpoint: { name, size: 123, sha256: "a".repeat(64), completedAt: 2000, instanceId: "4242" } });

it("keeps the newer checkpoint when an older commit reaches the runtime mirror late", async () => {
  const h = fixture();
  const newer = home("20260905T101501Z.tar.gz", 1000);
  await recordComputerHomeCheckpoint(h.db, "b-x", newer);
  await recordComputerHomeCheckpoint(h.db, "b-x", home("20260905T101500Z.tar.gz", null));
  expect(h.home()).toEqual(newer);
  expect(h.writes).toHaveLength(1);
});

it("does not erase an acknowledgment on an identical-checkpoint retry or recreate a deleted runtime", async () => {
  const h = fixture();
  const accepted = home("20260905T101501Z.tar.gz", 1000);
  await recordComputerHomeCheckpoint(h.db, "b-x", accepted);
  await recordComputerHomeCheckpoint(h.db, "b-x", home(accepted.lastCheckpoint.name, null));
  expect(h.home()).toEqual(accepted);
  const deleted = fixture(false);
  await recordComputerHomeCheckpoint(deleted.db, "b-x", accepted);
  expect(deleted.writes).toEqual([]);
});

it("writes a disk observation when the free-percent bucket, instance, or refresh window moves, and skips the rest", async () => {
  const writes: unknown[] = [];
  const db = { doc: () => ({ set: async (next: unknown) => { writes.push(next); } }) } as unknown as Firestore;
  const sample = (freeBytes: number, observedAt: number, instanceId = "4242") => ({ sizeBytes: 1_000, freeBytes, observedAt, instanceId });

  expect(await recordComputerDiskObservation(db, "b-x", undefined, sample(500, 1_000))).toBe(true);
  expect(await recordComputerDiskObservation(db, "b-x", sample(500, 1_000), sample(509, 1_000 + 30_000))).toBe(false);
  expect(await recordComputerDiskObservation(db, "b-x", sample(500, 1_000), sample(499, 1_000 + 30_000))).toBe(true);
  expect(await recordComputerDiskObservation(db, "b-x", sample(500, 1_000), sample(500, 1_000 + COMPUTER_DISK_OBSERVATION_REFRESH_MS))).toBe(true);
  expect(await recordComputerDiskObservation(db, "b-x", sample(500, 1_000), sample(500, 1_000 + 30_000, "9999"))).toBe(true);
  expect(await recordComputerDiskObservation(db, "b-x", { sizeBytes: "1000" }, sample(500, 1_000 + 30_000))).toBe(true);
  expect(writes).toEqual([
    { vmDisk: sample(500, 1_000) },
    { vmDisk: sample(499, 31_000) },
    { vmDisk: sample(500, 1_000 + COMPUTER_DISK_OBSERVATION_REFRESH_MS) },
    { vmDisk: sample(500, 31_000, "9999") },
    { vmDisk: sample(500, 31_000) },
  ]);
});
