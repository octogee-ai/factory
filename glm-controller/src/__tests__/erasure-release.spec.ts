import type { Firestore } from "firebase-admin/firestore";
import { describe, expect, it } from "vitest";
import { markSuspendedAndReleaseErasure } from "../lib/customer-ops/erasure-release.js";

function fakeDb(docs: Record<string, Record<string, unknown>>) {
  const ref = (path: string) => ({ path });
  const db = {
    collection: (name: string) => ({ doc: (id: string) => ref(`${name}/${id}`) }),
    runTransaction: async <T>(run: (txn: unknown) => Promise<T>) => run({
      get: async (target: { path: string }) => ({
        exists: target.path in docs,
        data: () => docs[target.path],
      }),
      set: (target: { path: string }, data: Record<string, unknown>) => {
        docs[target.path] = { ...docs[target.path], ...data };
      },
      update: (target: { path: string }, data: Record<string, unknown>) => {
        docs[target.path] = { ...docs[target.path], ...data };
      },
    }),
  };
  return db as unknown as Firestore;
}

const NOW = 1_000_000;

function deletion(eraseAfter: number, erasure: Record<string, unknown>) {
  return {
    "customerDeletionJobs/delete-1": {
      status: "suspending",
      eraseAfter,
      erasureOperationId: "erase-1",
    },
    "glmOperations/erase-1": erasure,
  };
}

describe("markSuspendedAndReleaseErasure", () => {
  it("lets an immediate erasure run now instead of waiting out its retry backoff", async () => {
    const docs = deletion(NOW - 40_000, { status: "pending", nextAttemptAt: NOW + 120_000 });

    await markSuspendedAndReleaseErasure(fakeDb(docs), "delete-1", NOW);

    expect(docs["customerDeletionJobs/delete-1"]).toMatchObject({
      status: "hibernating",
      suspendedAt: NOW,
    });
    expect(docs["glmOperations/erase-1"].nextAttemptAt).toBe(NOW);
  });

  it("keeps a retained deletion waiting for its erase date", async () => {
    const eraseAfter = NOW + 90 * 24 * 60 * 60 * 1000;
    const docs = deletion(eraseAfter, { status: "pending", nextAttemptAt: eraseAfter });

    await markSuspendedAndReleaseErasure(fakeDb(docs), "delete-1", NOW);

    expect(docs["customerDeletionJobs/delete-1"].status).toBe("hibernating");
    expect(docs["glmOperations/erase-1"].nextAttemptAt).toBe(eraseAfter);
  });

  it("leaves an erasure attempt that is already running alone", async () => {
    const docs = deletion(NOW - 40_000, { status: "running", nextAttemptAt: NOW - 1 });

    await markSuspendedAndReleaseErasure(fakeDb(docs), "delete-1", NOW);

    expect(docs["customerDeletionJobs/delete-1"].status).toBe("hibernating");
    expect(docs["glmOperations/erase-1"]).toEqual({ status: "running", nextAttemptAt: NOW - 1 });
  });

  it("refuses a deletion job that names no erasure operation", async () => {
    const docs = { "customerDeletionJobs/delete-1": { status: "suspending", eraseAfter: NOW } };

    await expect(markSuspendedAndReleaseErasure(fakeDb(docs), "delete-1", NOW))
      .rejects.toThrow(/delete-1 has no erasure operation/);
    expect(docs["customerDeletionJobs/delete-1"].status).toBe("suspending");
  });
});
