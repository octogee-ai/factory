import { describe, expect, it } from "vitest";

import {
  WorkspaceStorageQuotaError,
  finalizeWorkspaceStorageReservation,
  reserveWorkspaceStorage,
  rollbackWorkspaceStorageReservation,
} from "./workspace-storage-quota.js";

function fakeDb() {
  const docs = new Map<string, Record<string, unknown>>();
  const ref = (path: string) => ({ path });
  return {
    docs,
    doc: ref,
    runTransaction: async (
      fn: (transaction: {
        get(ref: { path: string }): Promise<{ exists: boolean; data(): Record<string, unknown> | undefined }>;
        set(ref: { path: string }, data: Record<string, unknown>): void;
        delete(ref: { path: string }): void;
      }) => Promise<unknown>,
    ) => fn({
      get: async (document) => ({
        exists: docs.has(document.path),
        data: () => docs.get(document.path),
      }),
      set: (document, data) => { docs.set(document.path, data); },
      delete: (document) => { docs.delete(document.path); },
    }),
  };
}

describe("workspace storage quota reservations", () => {
  it("atomically rejects aggregate writes beyond the configured allowance", async () => {
    const db = fakeDb();
    const first = await reserveWorkspaceStorage(db as never, {
      slug: "alice",
      path: "files/one.bin",
      newSize: 6,
      manifestBytes: 0,
      manifestPathBytes: 0,
      limitBytes: 10,
    });
    await finalizeWorkspaceStorageReservation(db as never, first);

    await expect(reserveWorkspaceStorage(db as never, {
      slug: "alice",
      path: "files/two.bin",
      newSize: 6,
      manifestBytes: 6,
      manifestPathBytes: 0,
      limitBytes: 10,
    })).rejects.toBeInstanceOf(WorkspaceStorageQuotaError);
  });

  it("charges only the replacement delta and rolls failed writes back", async () => {
    const db = fakeDb();
    const replacement = await reserveWorkspaceStorage(db as never, {
      slug: "alice",
      path: "files/one.bin",
      newSize: 8,
      manifestBytes: 6,
      manifestPathBytes: 6,
      limitBytes: 10,
    });

    await rollbackWorkspaceStorageReservation(db as never, replacement);

    const quota = db.docs.get("workspaces/alice/storageAccounting/quota");
    expect(quota?.usedBytes).toBe(6);
  });
});
