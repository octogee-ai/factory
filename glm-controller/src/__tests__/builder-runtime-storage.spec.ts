import { describe, expect, it, vi } from "vitest";
import type { Firestore } from "firebase-admin/firestore";
import { assertBuilderRuntimeStorage } from "../builder-runtime-storage.js";

function harness(runtime: "cluster" | "gce-vm", provisioning: Record<string, unknown> = {}) {
  const db = { collection: () => ({ doc: () => ({ get: async () => ({ exists: true, data: () => ({ provisioning }) }) }) }) } as unknown as Firestore;
  const runKubectl = vi.fn(async () => ({ code: 0, stdout: "", stderr: "" }));
  return { input: { db, runtime, ownerUid: "owner", builderSlug: "builder", namespace: "test", runKubectl }, runKubectl };
}

describe("Builder runtime storage boundary", () => {
  it.each(["computer", "homeCheckpoint"])("blocks new Hobby activation with retained GCE %s", async (field) => {
    const h = harness("cluster", { [field]: { instanceId: "123" } });
    await expect(assertBuilderRuntimeStorage(h.input)).rejects.toThrow(/explicit storage migration/);
    expect(h.runKubectl).not.toHaveBeenCalled();
  });
  it.each(["computer", "homeCheckpoint"])("blocks corrupt null GCE %s evidence instead of initializing empty X11", async (field) => {
    const h = harness("cluster", { [field]: null });
    await expect(assertBuilderRuntimeStorage(h.input)).rejects.toThrow(/explicit storage migration/);
  });
  it("lets an existing X11 home continue independently of plan sizing", async () => {
    const h = harness("cluster");
    await expect(assertBuilderRuntimeStorage(h.input)).resolves.toBeUndefined();
    expect(h.runKubectl).not.toHaveBeenCalled();
  });
  it("blocks GCE activation when the owner's Hobby PVC remains authoritative", async () => {
    const h = harness("gce-vm");
    h.runKubectl.mockResolvedValue({ code: 0, stdout: JSON.stringify({ metadata: { annotations: { "octogee.ai/owner-uid": "owner" } } }), stderr: "" });
    await expect(assertBuilderRuntimeStorage(h.input)).rejects.toThrow(/explicit storage migration/);
  });
  it("allows GCE recovery with its retained VM or pinned archive when no Hobby PVC exists", async () => {
    await expect(assertBuilderRuntimeStorage(harness("gce-vm", { computer: {}, homeCheckpoint: {} }).input)).resolves.toBeUndefined();
  });
  it("fails closed when PVC inventory cannot be read", async () => {
    const h = harness("gce-vm");
    h.runKubectl.mockResolvedValue({ code: 1, stdout: "", stderr: "Forbidden" });
    await expect(assertBuilderRuntimeStorage(h.input)).rejects.toThrow(/Forbidden/);
  });
});
