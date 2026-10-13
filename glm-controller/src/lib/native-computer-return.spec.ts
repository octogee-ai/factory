import { describe, expect, it, vi } from "vitest";
import { FieldValue } from "firebase-admin/firestore";
import { prepareNativeComputerReturn } from "./native-computer-return.js";

const input = { fromGatewayId: "native", toGatewayId: "shared", uid: "alice-id", slug: "alice", operationId: "return-1", claimedStartedAt: 900 };

function harness() {
  const root = { gatewayClass: "builder", ownerUid: "alice-id", builderSlug: "alice", desiredStatus: "running" };
  const source: Record<string, any> = {
    runtime: "gce-vm", vm: { instanceName: "computer", zone: "us-central1-a", instanceId: "computer-id" }, vmHome: {},
  };
  const user = { provisioning: { openclaw: { gatewayId: "native" } } };
  const target = { gatewayClass: "shared" };
  const docs: Record<string, any> = { "glmGateways/native": source, "gateways/native": root, "gateways/shared": target, "users/alice-id": user, "glmOperations/return-1": { kind: "migrate-customer", status: "running", startedAt: 900, input: { uid: "alice-id", fromGatewayId: "native", toGatewayId: "shared" } } };
  const snapshot = (path: string) => ({ exists: !!docs[path], data: () => docs[path] });
  const update = vi.fn((ref: { path: string }, data: Record<string, unknown>) => {
    for (const [key, value] of Object.entries(data)) {
      const [parent, field] = key.split(".");
      if (field === undefined) { docs[ref.path][parent] = value; continue; }
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
  const vm = { describe: vi.fn(async (): Promise<{ status: string; instanceId: string } | null> => ({ status: "RUNNING", instanceId: "computer-id" })) };
  const deps = { db: db as never, vm: vm as never, now: () => now, wait, timeoutMs: 100 };
  return { deps, source, root, target, user, docs, update };
}

describe("native computer return checkpoint", () => {
  it.each([null, "TERMINATED", "STOPPED", "STOPPING", "RUNNING"])("requires positive Compute evidence for a lost source (%s)", async (status) => {
    const h = harness();
    h.root.desiredStatus = "paused";
    const vm = h.deps.vm as { describe: ReturnType<typeof vi.fn> };
    vm.describe.mockResolvedValue(status === null ? null : { status, instanceId: "computer-id" });
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

  it("does not accept a stopped replacement instance as proof that the recorded source is fenced", async () => {
    const h = harness(); h.root.desiredStatus = "paused";
    const vm = h.deps.vm as { describe: ReturnType<typeof vi.fn> };
    vm.describe.mockResolvedValue({ status: "TERMINATED", instanceId: "replacement-id" });
    const native = (await prepareNativeComputerReturn(h.deps, input))!;
    expect(await native.isSourceFencedOff()).toBe(false);
  });

  it("does not waive cleanup for a preempted source that Cowboy can restart", async () => {
    const h = harness();
    const vm = h.deps.vm as { describe: ReturnType<typeof vi.fn> };
    vm.describe.mockResolvedValue({ status: "TERMINATED", instanceId: "computer-id" });
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

  it.each(["takeover", "terminal", "missing", "scope", "hold"])("retains a pre-cutover hold after %s changes", async change => {
    const h = harness();
    const native = (await prepareNativeComputerReturn(h.deps, input))!;
    await expect(native.checkpoint()).rejects.toThrow(/timeout/);
    if (change === "takeover") h.docs["glmOperations/return-1"].startedAt = 901;
    if (change === "terminal") h.docs["glmOperations/return-1"].status = "failed";
    if (change === "missing") delete h.docs["glmOperations/return-1"];
    if (change === "scope") h.docs["glmOperations/return-1"].input.uid = "bob";
    if (change === "hold") h.source.vmHome.checkpointRequestedAt = 1001;
    await expect(native.release()).rejects.toThrow(/authority changed/);
    expect(h.source.vmHome.returnOperationId).toBe("return-1");
  });

  it("rejects a stale worker claiming a checkpoint after takeover", async () => {
    const h = harness();
    const native = (await prepareNativeComputerReturn(h.deps, input))!;
    h.docs["glmOperations/return-1"].startedAt = 901;
    await expect(native.checkpoint()).rejects.toThrow(/authority changed/);
    expect(h.update).not.toHaveBeenCalled();
  });

  function committedReturn(h: ReturnType<typeof harness>) {
    h.user.provisioning.openclaw.gatewayId = "shared";
    h.source.vm.instanceId = "computer-id";
    h.source.vmHome = { returnOperationId: "return-1", checkpointRequestedAt: 1000,
      parkRequestedAt: 1000, checkpointAcknowledgedAt: 1000,
      lastCheckpoint: { completedAt: 1001, instanceId: "computer-id" } };
    h.docs["glmOperations/return-1"] = { kind: "migrate-customer", status: "running", startedAt: 900, cutoverCommittedAt: 1002,
      input: { uid: "alice-id", fromGatewayId: "native", toGatewayId: "shared" } };
    h.docs["gateways/shared/assignments/alice-id"] = { uid: "alice-id", gatewayId: "shared", slug: "alice", state: "serving" };
  }

  it("keeps the final checkpoint held until the committed native source is stopped", async () => {
    const h = harness(); committedReturn(h);
    const vm = h.deps.vm as { describe: ReturnType<typeof vi.fn> };
    vm.describe.mockImplementationOnce(async () => {
      expect(h.root.desiredStatus).toBe("paused");
      expect(h.source.vmHome.returnOperationId).toBe("return-1");
      expect(h.source.vmHome.checkpointRequestedAt).toBe(1000);
      return { status: "STOPPING", instanceId: "computer-id" };
    }).mockResolvedValue({ status: "TERMINATED", instanceId: "computer-id" });
    const native = (await prepareNativeComputerReturn(h.deps, input))!;
    await native.release();
    expect(h.root.desiredStatus).toBe("paused");
    expect(h.deps.wait).toHaveBeenCalledOnce();
    expect(h.source.vmHome.checkpointRequestedAt).toBeUndefined();
  });

  it("retains the final checkpoint hold when the committed source cannot stop", async () => {
    const h = harness(); committedReturn(h);
    const native = (await prepareNativeComputerReturn(h.deps, input))!;
    await expect(native.release()).rejects.toThrow(/stop.*timed out/i);
    expect(h.source.vmHome.returnOperationId).toBe("return-1");
    expect(h.source.vmHome.checkpointRequestedAt).toBe(1000);
  });

  it("keeps an absent source fenced after checkpoint release and on a completion retry", async () => {
    const h = harness(); committedReturn(h);
    const vm = h.deps.vm as { describe: ReturnType<typeof vi.fn> };
    vm.describe.mockResolvedValue(null);
    const native = (await prepareNativeComputerReturn(h.deps, input))!;
    await native.release();
    expect(await native.isSourceFencedOff()).toBe(true);
    expect(h.source.vmHome.checkpointRequestedAt).toBeUndefined();
    const retry = (await prepareNativeComputerReturn(h.deps, input))!;
    await retry.release();
    expect(await retry.isSourceFencedOff()).toBe(true);
  });

  it.each(["claim"])("retains the checkpoint when the active attempt changes during stop: %s", async change => {
    const h = harness(); committedReturn(h);
    const vm = h.deps.vm as { describe: ReturnType<typeof vi.fn> };
    vm.describe.mockResolvedValueOnce({ status: "STOPPING", instanceId: "computer-id" })
      .mockResolvedValue({ status: "TERMINATED", instanceId: "computer-id" });
    h.deps.wait.mockImplementation(async () => {
      if (change === "claim") h.docs["glmOperations/return-1"].startedAt = 901;
      else h.docs["glmOperations/return-1"].cancellationRequestedAt = 1003;
    });
    const native = (await prepareNativeComputerReturn(h.deps, input))!;
    await expect(native.release()).rejects.toThrow(/authority changed/);
    expect(h.source.vmHome.returnOperationId).toBe("return-1");
    expect(h.source.vmHome.checkpointRequestedAt).toBe(1000);
  });

  it("retains the hold if the exact source binding changes after the stop observation", async () => {
    const h = harness(); committedReturn(h);
    (h.deps.vm as { describe: ReturnType<typeof vi.fn> }).describe.mockImplementation(async () => {
      h.source.vm.instanceId = "replacement";
      h.source.vmHome.lastCheckpoint.instanceId = "replacement";
      return { status: "TERMINATED", instanceId: "computer-id" };
    });
    await expect((await prepareNativeComputerReturn(h.deps, input))!.release()).rejects.toThrow("authority changed");
    expect(h.source.vmHome.checkpointRequestedAt).toBe(1000);
  });

  it("allows the current committed attempt to finish stopping after cancellation", async () => {
    const h = harness(); committedReturn(h);
    h.docs["glmOperations/return-1"].cancellationRequestedAt = 1003;
    (h.deps.vm as { describe: ReturnType<typeof vi.fn> }).describe.mockResolvedValue({ status: "TERMINATED", instanceId: "computer-id" });
    await (await prepareNativeComputerReturn(h.deps, input))!.release();
    expect(h.source.vmHome.checkpointRequestedAt).toBeUndefined();
  });

  it.each(["cutover", "operation", "target-assignment", "checkpoint-instance"])("refuses a post-cutover source pause after %s changes", async change => {
    const h = harness(); committedReturn(h);
    if (change === "cutover") delete h.docs["glmOperations/return-1"].cutoverCommittedAt;
    if (change === "operation") h.docs["glmOperations/return-1"].input.uid = "bob";
    if (change === "target-assignment") h.docs["gateways/shared/assignments/alice-id"].state = "quiescing";
    if (change === "checkpoint-instance") h.source.vmHome.lastCheckpoint.instanceId = "different-computer";
    const native = (await prepareNativeComputerReturn(h.deps, input))!;
    await expect(native.release()).rejects.toThrow(/authority changed/);
    expect(h.update).not.toHaveBeenCalled();
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
