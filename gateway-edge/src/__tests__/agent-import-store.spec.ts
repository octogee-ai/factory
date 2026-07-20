import { describe, expect, it, vi } from "vitest";

import { createAgentImportStore } from "../lib/agent-import-store.js";
import type { AgentImportRecord, StoredAgentImportPlan } from "../lib/agent-import-service.js";

function fixture() {
  const docs = new Map<string, unknown>();
  const objects = new Map<string, Buffer>();
  const db = {
    doc: (path: string) => ({
      set: vi.fn(async (value: unknown) => { docs.set(path, structuredClone(value)); }),
      get: vi.fn(async () => ({ exists: docs.has(path), data: () => docs.get(path) })),
    }),
  };
  const bucket = {
    file: (path: string) => ({
      save: vi.fn(async (value: Buffer | string) => { objects.set(path, Buffer.from(value)); }),
      download: vi.fn(async () => {
        const value = objects.get(path);
        if (!value) throw Object.assign(new Error("not found"), { code: 404 });
        return [value];
      }),
      delete: vi.fn(async () => { objects.delete(path); }),
    }),
    deleteFiles: vi.fn(async ({ prefix }: { prefix: string }) => {
      for (const key of objects.keys()) if (key.startsWith(prefix)) objects.delete(key);
    }),
  };
  return { store: createAgentImportStore({ db, bucket }), docs, objects, bucket };
}

const record = {
  id: "imp-1",
  uid: "uid-alice",
  slug: "alice",
  gatewayId: "gw-alice",
  status: "previewed",
} as AgentImportRecord;

const plan = {
  uid: "uid-alice",
  slug: "alice",
  gatewayId: "gw-alice",
  approvalHash: "sha256:approved",
} as StoredAgentImportPlan;

describe("agent import store", () => {
  it("persists and reads the public import record without staging it in GCS", async () => {
    const { store, docs, objects } = fixture();
    await store.putRecord(record);
    await expect(store.getRecord("imp-1")).resolves.toEqual(record);
    expect(docs.has("agentImports/imp-1")).toBe(true);
    expect(objects.size).toBe(0);
  });

  it("stores the private plan and archive under a non-user-derived staging prefix", async () => {
    const { store, objects } = fixture();
    await store.putPlan("imp-1", plan);
    await store.putArchive("imp-1", Buffer.from("zip"));

    await expect(store.getPlan("imp-1")).resolves.toEqual(plan);
    await expect(store.getArchive("imp-1")).resolves.toEqual(Buffer.from("zip"));
    expect([...objects.keys()].sort()).toEqual([
      "agent-imports/imp-1/plan.json",
      "agent-imports/imp-1/source.zip",
    ]);
  });

  it("returns null for missing staged values and deletes the full staging prefix", async () => {
    const { store, objects, bucket } = fixture();
    await expect(store.getPlan("missing")).resolves.toBeNull();
    await expect(store.getArchive("missing")).resolves.toBeNull();
    objects.set("agent-imports/imp-1/plan.json", Buffer.from("{}"));
    objects.set("agent-imports/imp-1/source.zip", Buffer.from("zip"));

    await store.deleteStaging("imp-1");
    expect(objects.size).toBe(0);
    expect(bucket.deleteFiles).toHaveBeenCalledWith({ prefix: "agent-imports/imp-1/" });
  });

  it("rejects invalid import identifiers before constructing a storage path", async () => {
    const { store } = fixture();
    await expect(store.getRecord("../secrets")).rejects.toThrow("invalid agent import id");
  });
});
