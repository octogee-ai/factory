import { describe, expect, it, vi } from "vitest";
import { FieldValue } from "firebase-admin/firestore";
import { prepareNativeComputerReturn, releaseNativeReturnSourceRecoveryHold } from "./native-computer-return.js";

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
      if (field === undefined) {
        if (value instanceof FieldValue) delete docs[ref.path][parent];
        else docs[ref.path][parent] = value;
        continue;
      }
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
  const vm = {
    describe: vi.fn(async (): Promise<{ status: string; instanceId: string } | null> => ({ status: "RUNNING", instanceId: "computer-id" })),
    stop: vi.fn(async () => undefined),
  };
  const deps = { db: db as never, vm: vm as never, now: () => now, wait, timeoutMs: 100 };
  return { deps, source, root, target, user, docs, update };
}

describe("native computer return checkpoint", () => {
  it.each([null, "TERMINATED", "STOPPED", "SUSPENDED", "RUNNING"])("reports the recorded source computer's Compute status (%s)", async (status) => {
    const h = harness();
    const vm = h.deps.vm as { describe: ReturnType<typeof vi.fn> };
    vm.describe.mockResolvedValue(status === null ? null : { status, instanceId: "computer-id" });
    const native = (await prepareNativeComputerReturn(h.deps, input))!;
    expect(await native.sourceComputerStatus()).toBe(status);
    expect(vm.describe).toHaveBeenCalledWith("computer", "us-central1-a");
  });

  it("does not report a replacement instance or a missing record as the source computer's status", async () => {
    const h = harness();
    const vm = h.deps.vm as { describe: ReturnType<typeof vi.fn> };
    vm.describe.mockResolvedValue({ status: "TERMINATED", instanceId: "replacement-id" });
    const native = (await prepareNativeComputerReturn(h.deps, input))!;
    await expect(native.sourceComputerStatus()).rejects.toThrow(/replaced/);
    vm.describe.mockRejectedValue(new Error("Compute unavailable"));
    await expect(native.sourceComputerStatus()).rejects.toThrow("Compute unavailable");
    delete h.source.vm;
    await expect(native.sourceComputerStatus()).rejects.toThrow(/no recorded computer/);
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

  it("refuses native return recovery when its old target root disappeared", async () => {
    const h = harness();
    delete h.docs["gateways/shared"];
    await expect(prepareNativeComputerReturn(h.deps, input)).rejects.toThrow("native computer return target is unavailable: shared");
    expect(h.update).not.toHaveBeenCalled();
    h.source.runtime = "kubernetes";
    expect(await prepareNativeComputerReturn(h.deps, input)).toBeNull();
  });

  it("releases only its exact pre-cutover source hold after typed recovery proves the target removed", async () => {
    const h = harness(); await (await prepareNativeComputerReturn(h.deps, input))!.requestCheckpoint();
    delete h.docs["gateways/shared"];
    await releaseNativeReturnSourceRecoveryHold(h.deps, input);
    expect(h.source.vmHome.returnOperationId).toBeUndefined(); expect(h.source.vmHome.checkpointRequestedAt).toBeUndefined();
    expect(h.user.provisioning.openclaw.gatewayId).toBe("native");
  });
  it.each(["claim", "owner", "foreign-hold"])("retains the source hold if recovery %s changes", async change => {
    const h = harness(); await (await prepareNativeComputerReturn(h.deps, input))!.requestCheckpoint();
    if (change === "claim") h.docs["glmOperations/return-1"].startedAt = 901;
    if (change === "owner") h.root.ownerUid = "foreign";
    if (change === "foreign-hold") h.source.vmHome.returnOperationId = "foreign-return";
    const before = { ...h.source.vmHome }; delete h.docs["gateways/shared"];
    await expect(releaseNativeReturnSourceRecoveryHold(h.deps, input)).rejects.toThrow(); expect(h.source.vmHome).toEqual(before);
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
    await native.requestCheckpoint();
    expect(h.source.vmHome).toMatchObject({ checkpointRequestedAt: 1000, parkRequestedAt: 1000, returnOperationId: "return-1" });
    expect(h.deps.wait).not.toHaveBeenCalled();
    await native.awaitCheckpoint();
    expect(h.deps.wait).toHaveBeenCalledOnce();
    const resumed = (await prepareNativeComputerReturn(h.deps, input))!;
    expect(resumed.checkpointRequested).toBe(true);
    await resumed.requestCheckpoint();
    await resumed.awaitCheckpoint();
    expect(h.update).toHaveBeenCalledOnce();
  });

  it("rejects stale unacknowledged checkpoints and cancellation releases only its own hold", async () => {
    const h = harness();
    h.source.vmHome.lastCheckpoint = { completedAt: 2000 };
    const native = (await prepareNativeComputerReturn(h.deps, input))!;
    await native.requestCheckpoint();
    await expect(native.awaitCheckpoint()).rejects.toThrow(/timeout/);
    await expect(native.release()).resolves.toBeUndefined();
    expect(h.source.vmHome.checkpointRequestedAt).toBeUndefined();
    expect(h.source.vmHome.parkRequestedAt).toBeUndefined();
    expect(h.source.vmHome.lastCheckpoint).toEqual({ completedAt: 2000 });
    h.source.vmHome = { returnOperationId: "other", checkpointRequestedAt: 3000 };
    await native.release();
    expect(h.source.vmHome.checkpointRequestedAt).toBe(3000);
    await expect(native.requestCheckpoint()).rejects.toThrow(/another checkpoint/);
  });

  it.each(["takeover", "terminal", "missing", "scope", "hold"])("retains a pre-cutover hold after %s changes", async change => {
    const h = harness();
    const native = (await prepareNativeComputerReturn(h.deps, input))!;
    await native.requestCheckpoint();
    await expect(native.awaitCheckpoint()).rejects.toThrow(/timeout/);
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
    await expect(native.requestCheckpoint()).rejects.toThrow(/authority changed/);
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

  it("releases the writer hold on the committed source while it still runs, so the Builder can unmount the customer", async () => {
    const h = harness(); committedReturn(h);
    const native = (await prepareNativeComputerReturn(h.deps, input))!;
    await native.awaitCheckpoint();
    await native.releaseWriterHold();
    expect(h.source.vmHome).toEqual({ checkpointAcknowledgedAt: 1000, lastCheckpoint: { completedAt: 1001, instanceId: "computer-id" } });
    expect(h.root.desiredStatus).toBe("running");
    expect(h.deps.vm.describe).not.toHaveBeenCalled();
    await (await prepareNativeComputerReturn(h.deps, input))!.releaseWriterHold();
    expect(h.update).toHaveBeenCalledOnce();
  });

  it.each(["cutover", "operation", "target-assignment", "checkpoint-instance", "unacknowledged", "paused"])("retains the writer hold after %s changes", async change => {
    const h = harness(); committedReturn(h);
    if (change === "cutover") delete h.docs["glmOperations/return-1"].cutoverCommittedAt;
    if (change === "operation") h.docs["glmOperations/return-1"].input.uid = "bob";
    if (change === "target-assignment") h.docs["gateways/shared/assignments/alice-id"].state = "quiescing";
    if (change === "checkpoint-instance") h.source.vmHome.lastCheckpoint.instanceId = "different-computer";
    if (change === "unacknowledged") h.source.vmHome.checkpointAcknowledgedAt = 999;
    if (change === "paused") h.root.desiredStatus = "paused";
    const native = (await prepareNativeComputerReturn(h.deps, input))!;
    await expect(native.releaseWriterHold()).rejects.toThrow(/authority changed/);
    expect(h.update).not.toHaveBeenCalled();
    expect(h.source.vmHome.checkpointRequestedAt).toBe(1000);
  });

  async function releasedReturn(h: ReturnType<typeof harness>) {
    committedReturn(h);
    const native = (await prepareNativeComputerReturn(h.deps, input))!;
    await native.releaseWriterHold();
    h.update.mockClear();
    return native;
  }

  it("parks the unmounted source by suspend and reports it suspended", async () => {
    const h = harness();
    const native = await releasedReturn(h);
    const vm = h.deps.vm as { describe: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn> };
    vm.describe.mockImplementationOnce(async () => {
      expect(h.root.desiredStatus).toBe("paused");
      expect(h.source.vmStopOnPark).toBeUndefined();
      return { status: "SUSPENDING", instanceId: "computer-id" };
    }).mockResolvedValue({ status: "SUSPENDED", instanceId: "computer-id" });
    await expect(native.park({ mode: "suspend" })).resolves.toEqual({ parked: "suspended" });
    expect(h.deps.wait).toHaveBeenCalledOnce();
    expect(vm.stop).not.toHaveBeenCalled();
  });

  it("asks Cowboy to stop rather than suspend a source whose live cleanup failed, and clears the request once stopped", async () => {
    const h = harness();
    const native = await releasedReturn(h);
    const vm = h.deps.vm as { describe: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn> };
    vm.describe.mockImplementationOnce(async () => {
      expect(h.root.desiredStatus).toBe("paused");
      expect(h.source.vmStopOnPark).toEqual({ operationId: "return-1", reason: "unmount refused" });
      return { status: "STOPPING", instanceId: "computer-id" };
    }).mockResolvedValue({ status: "TERMINATED", instanceId: "computer-id" });
    await expect(native.park({ mode: "stop", reason: "unmount refused" })).resolves.toEqual({ parked: "stopped", stopReason: "unmount refused" });
    expect(h.source.vmStopOnPark).toBeUndefined();
    expect(vm.stop).not.toHaveBeenCalled();
  });

  it("clears a stale stop intent from an earlier attempt when live cleanup succeeded, and suspends", async () => {
    const h = harness();
    const native = await releasedReturn(h);
    h.source.vmStopOnPark = { operationId: "return-1", reason: "live source cleanup failed: earlier attempt" };
    const vm = h.deps.vm as { describe: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn> };
    vm.describe.mockImplementation(async () => {
      expect(h.root.desiredStatus).toBe("paused");
      expect(h.source.vmStopOnPark).toBeUndefined();
      return { status: "SUSPENDED", instanceId: "computer-id" };
    });
    await expect(native.park({ mode: "suspend" })).resolves.toEqual({ parked: "suspended" });
    expect(vm.stop).not.toHaveBeenCalled();
  });

  it("stops a source it finds suspended when the return requires a stop", async () => {
    const h = harness();
    const native = await releasedReturn(h);
    const vm = h.deps.vm as { describe: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn> };
    vm.describe.mockResolvedValueOnce({ status: "SUSPENDED", instanceId: "computer-id" })
      .mockResolvedValue({ status: "TERMINATED", instanceId: "computer-id" });
    vm.stop.mockImplementation(async () => { expect(h.source.vmStopOnPark).toMatchObject({ operationId: "return-1", claimedAt: expect.any(Number) }); });
    await expect(native.park({ mode: "stop", reason: "source computer is SUSPENDED" })).resolves.toMatchObject({ parked: "stopped" });
    expect(vm.stop).toHaveBeenCalledExactlyOnceWith("computer", "us-central1-a");
    expect(h.source.vmStopOnPark).toBeUndefined();
  });

  it("does not suspend while a claimed stop is in flight: it waits for the stop and reports the source stopped", async () => {
    const h = harness();
    const native = await releasedReturn(h);
    const claimed = { operationId: "return-1", reason: "live source cleanup failed: earlier attempt", claimedAt: 900 };
    h.source.vmStopOnPark = { ...claimed };
    const vm = h.deps.vm as { describe: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn> };
    vm.describe.mockImplementationOnce(async () => {
      expect(h.source.vmStopOnPark).toEqual(claimed);
      return { status: "SUSPENDED", instanceId: "computer-id" };
    }).mockResolvedValue({ status: "TERMINATED", instanceId: "computer-id" });
    await expect(native.park({ mode: "suspend" })).resolves.toEqual({
      parked: "stopped", stopReason: "a claimed stop of return-1 is in flight: live source cleanup failed: earlier attempt",
    });
    expect(h.source.vmStopOnPark).toBeUndefined();
  });

  it("does not stop a suspended source itself once its stop request was withdrawn after the read", async () => {
    const h = harness();
    const native = await releasedReturn(h);
    const vm = h.deps.vm as { describe: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn> };
    vm.describe.mockImplementationOnce(async () => {
      delete h.source.vmStopOnPark;
      return { status: "SUSPENDED", instanceId: "computer-id" };
    }).mockResolvedValue({ status: "TERMINATED", instanceId: "computer-id" });
    await expect(native.park({ mode: "stop", reason: "source computer is SUSPENDED" })).resolves.toMatchObject({ parked: "stopped" });
    expect(vm.stop).not.toHaveBeenCalled();
  });

  it("does not stop a suspended source after its operation claim was taken over, and fails on the lost claim", async () => {
    const h = harness();
    const native = await releasedReturn(h);
    const vm = h.deps.vm as { describe: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn> };
    vm.describe.mockImplementation(async () => {
      h.docs["glmOperations/return-1"].startedAt = 901;
      return { status: "SUSPENDED", instanceId: "computer-id" };
    });
    await expect(native.park({ mode: "stop", reason: "source computer is SUSPENDED" })).rejects.toThrow(/stop authority changed/);
    expect(vm.stop).not.toHaveBeenCalled();
  });

  it("reports an absent source stopped and fails loudly when the source never parks", async () => {
    const h = harness();
    const native = await releasedReturn(h);
    const vm = h.deps.vm as { describe: ReturnType<typeof vi.fn> };
    vm.describe.mockResolvedValue(null);
    await expect(native.park({ mode: "suspend" })).resolves.toEqual({ parked: "stopped" });
    const stuck = harness();
    const parked = await releasedReturn(stuck);
    await expect(parked.park({ mode: "suspend" })).rejects.toThrow(/park timed out/);
  });

  it.each(["claim", "binding"])("refuses to finish parking when the %s changes during the Compute read", async change => {
    const h = harness();
    const native = await releasedReturn(h);
    (h.deps.vm as { describe: ReturnType<typeof vi.fn> }).describe.mockImplementation(async () => {
      if (change === "claim") h.docs["glmOperations/return-1"].startedAt = 901;
      else { h.source.vm.instanceId = "replacement"; h.source.vmHome.lastCheckpoint.instanceId = "replacement"; }
      return { status: "SUSPENDED", instanceId: "computer-id" };
    });
    await expect(native.park({ mode: "suspend" })).rejects.toThrow(/authority changed/);
  });

  it("allows the current committed attempt to finish parking after cancellation", async () => {
    const h = harness();
    const native = await releasedReturn(h);
    h.docs["glmOperations/return-1"].cancellationRequestedAt = 1003;
    (h.deps.vm as { describe: ReturnType<typeof vi.fn> }).describe.mockResolvedValue({ status: "SUSPENDED", instanceId: "computer-id" });
    await expect(native.park({ mode: "suspend" })).resolves.toEqual({ parked: "suspended" });
  });

  it.each(["owner", "assignment"])("refuses checkpoint writes after %s changes", async (change) => {
    const h = harness();
    const native = (await prepareNativeComputerReturn(h.deps, input))!;
    if (change === "owner") h.root.ownerUid = "bob";
    else h.user.provisioning.openclaw.gatewayId = "elsewhere";
    await expect(native.requestCheckpoint()).rejects.toThrow(/changed/);
    expect(h.update).not.toHaveBeenCalled();
  });
});
