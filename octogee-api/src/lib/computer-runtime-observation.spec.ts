import type { Firestore } from "firebase-admin/firestore";
import { expect, it } from "vitest";
import { recordComputerHomeCheckpoint } from "./computer-runtime-observation.js";

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
