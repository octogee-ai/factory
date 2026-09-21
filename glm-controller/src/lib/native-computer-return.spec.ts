import { describe, expect, it, vi } from "vitest";
import { FieldValue } from "firebase-admin/firestore";
import { prepareNativeComputerReturn } from "./native-computer-return.js";

const input = { fromGatewayId: "native", toGatewayId: "shared", uid: "alice-id", slug: "alice", operationId: "return-1" };

function harness() {
  const root = { gatewayClass: "builder", ownerUid: "alice-id", builderSlug: "alice", desiredStatus: "running" };
  const source: Record<string, any> = {
    runtime: "gce-vm", vm: { instanceName: "computer", zone: "us-central1-a" }, vmHome: {},
  };
  const user = { provisioning: { openclaw: { gatewayId: "native" } } };
  const target = { gatewayClass: "shared" };
  const docs: Record<string, any> = { "glmGateways/native": source, "gateways/native": root, "gateways/shared": target, "users/alice-id": user };
  const snapshot = (path: string) => ({ exists: !!docs[path], data: () => docs[path] });
  const update = vi.fn((ref: { path: string }, data: Record<string, unknown>) => {
    for (const [key, value] of Object.entries(data)) {
      const [parent, field] = key.split(".");
      if (value instanceof FieldValue) delete docs[ref.path][parent][field];
      else docs[ref.path][parent][field] = value;
    }
  });
  const db = {
    collection: (collection: string) => ({ doc: (id: string) => ({ path: `${collection}/${id}`, get: async () => snapshot(`${collection}/${id}`) }) }),
    runTransaction: async (body: (tx: unknown) => Promise<unknown>) => body({ get: async (ref: { path: string }) => snapshot(ref.path), update }),
  };
  let now = 1000;
  const wait = vi.fn(async (ms: number) => { now += ms; });
  const vm = { describe: vi.fn(async (): Promise<{ status: string } | null> => ({ status: "RUNNING" })) };
  const deps = { db: db as never, vm: vm as never, now: () => now, wait, timeoutMs: 100 };
  return { deps, source, root, target, user, update };
}

describe("native computer return checkpoint", () => {
  it.each([null, "TERMINATED", "STOPPED", "STOPPING", "RUNNING"])("requires positive Compute evidence for a lost source (%s)", async (status) => {
    const h = harness();
    h.root.desiredStatus = "paused";
    const vm = h.deps.vm as { describe: ReturnType<typeof vi.fn> };
    vm.describe.mockResolvedValue(status === null ? null : { status });
    const native = (await prepareNativeComputerReturn(h.deps, input))!;
    expect(await native.isSourceFencedOff()).toBe(status === null || status === "TERMINATED" || status === "STOPPED");
    expect(vm.describe).toHaveBeenCalledWith("computer", "us-central1-a");
  });

  it("does not infer source absence from a Compute read failure or lost binding", async () => {
    const h = harness();
    h.root.desiredStatus = "retired";
    const vm = h.deps.vm as { describe: ReturnType<typeof vi.fn> };
    vm.describe.mockRejectedValue(new Error("Compute unavailable"));
    const native = (await prepareNativeComputerReturn(h.deps, input))!;
    await expect(native.isSourceFencedOff()).rejects.toThrow("Compute unavailable");
    delete h.source.vm;
    expect(await native.isSourceFencedOff()).toBe(false);
  });

  it("does not waive cleanup for a preempted source that Cowboy can restart", async () => {
    const h = harness();
    const vm = h.deps.vm as { describe: ReturnType<typeof vi.fn> };
    vm.describe.mockResolvedValue({ status: "TERMINATED" });
    const native = (await prepareNativeComputerReturn(h.deps, input))!;
    expect(await native.isSourceFencedOff()).toBe(false);
    expect(vm.describe).not.toHaveBeenCalled();
  });

  it("scopes native returns to the matching owner and a Shared target", async () => {
    const h = harness();
    h.source.runtime = "kubernetes";
    expect(await prepareNativeComputerReturn(h.deps, input)).toBeNull();
    h.source.runtime = "gce-vm";
    h.target.gatewayClass = "builder";
    expect(await prepareNativeComputerReturn(h.deps, input)).toBeNull();
    h.target.gatewayClass = "shared";
    h.root.ownerUid = "bob";
    await expect(prepareNativeComputerReturn(h.deps, input)).rejects.toThrow(/ownership changed/);
    expect(h.update).not.toHaveBeenCalled();
  });

  it("waits for acknowledgement of a fresh checkpoint and retains the hold for parking", async () => {
    const h = harness();
    h.source.vmHome.lastCheckpoint = { completedAt: 500 };
    h.deps.wait.mockImplementation(async () => {
      h.source.vmHome.lastCheckpoint = { completedAt: 1001 };
      h.source.vmHome.checkpointAcknowledgedAt = 1000;
    });
    const native = (await prepareNativeComputerReturn(h.deps, input))!;
    expect(native.checkpointRequested).toBe(false);
    await native.checkpoint();
    expect(h.deps.wait).toHaveBeenCalledOnce();
    expect(h.source.vmHome).toMatchObject({ checkpointRequestedAt: 1000, parkRequestedAt: 1000, returnOperationId: "return-1" });
    const resumed = (await prepareNativeComputerReturn(h.deps, input))!;
    expect(resumed.checkpointRequested).toBe(true);
    await resumed.checkpoint();
    expect(h.update).toHaveBeenCalledOnce();
  });

  it("rejects stale unacknowledged checkpoints and cancellation releases only its own hold", async () => {
    const h = harness();
    h.source.vmHome.lastCheckpoint = { completedAt: 2000 };
    const native = (await prepareNativeComputerReturn(h.deps, input))!;
    await expect(native.checkpoint()).rejects.toThrow(/timeout/);
    await native.release();
    expect(h.source.vmHome.checkpointRequestedAt).toBeUndefined();
    expect(h.source.vmHome.parkRequestedAt).toBeUndefined();
    expect(h.source.vmHome.lastCheckpoint).toEqual({ completedAt: 2000 });
    h.source.vmHome = { returnOperationId: "other", checkpointRequestedAt: 3000 };
    await native.release();
    expect(h.source.vmHome.checkpointRequestedAt).toBe(3000);
    await expect(native.checkpoint()).rejects.toThrow(/another checkpoint/);
  });

  it.each(["owner", "assignment"])("refuses checkpoint writes after %s changes", async (change) => {
    const h = harness();
    const native = (await prepareNativeComputerReturn(h.deps, input))!;
    if (change === "owner") h.root.ownerUid = "bob";
    else h.user.provisioning.openclaw.gatewayId = "elsewhere";
    await expect(native.checkpoint()).rejects.toThrow(/changed/);
    expect(h.update).not.toHaveBeenCalled();
  });
});
