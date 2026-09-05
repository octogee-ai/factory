import { describe, it, expect, vi } from "vitest";
import type { BuilderParkedComputer, Operation, GatewayVmState } from "@octogee/shared/types/glm";
import { createGatewayVmHandler, type GatewayVmRecord } from "../handlers/gateway-vm";
import type { GatewayVmClient, GatewayVmDescription } from "../lib/compute-vm";

const description: GatewayVmDescription = {
  name: "octogee-computer-test-uida",
  zone: "us-west1-b",
  status: "RUNNING",
  instanceId: "42",
  internalIp: "10.138.0.9",
  provisioningModel: "SPOT",
  gatewayId: "b-mama-3-abc-hobby",
  labels: {},
  labelFingerprint: null,
  metadata: { "gateway-id": "b-mama-3-abc-hobby" },
  metadataFingerprint: null,
  creationTimestamp: null,
};

const vmState: GatewayVmState = {
  instanceName: description.name,
  zone: "us-west1-b",
  instanceId: "42",
  internalIp: "10.138.0.9",
  status: "RUNNING",
  provisioningModel: "SPOT",
  stopReason: null,
  updatedAt: 1,
};

function op(input: Record<string, unknown>): Operation {
  return { id: "op-1", kind: "gateway-vm", input } as unknown as Operation;
}

function harness(
  record: GatewayVmRecord | null,
  vm: Partial<GatewayVmClient> = {},
  home: { completedAt?: () => number | null; cancelled?: () => boolean; parked?: BuilderParkedComputer | null } = {},
) {
  const client: GatewayVmClient = {
    create: vi.fn(async () => ({ description, provisioningModel: "SPOT", fellBackToStandard: false, alreadyExisted: false })),
    describe: vi.fn(async () => description),
    find: vi.fn(async () => null),
    findByLabels: vi.fn(async () => null),
    list: vi.fn(async () => []),
    bind: vi.fn(async () => {}),
    setMetadata: vi.fn(async () => "applied" as const),
    setLabels: vi.fn(async () => "applied" as const),
    stop: vi.fn(async () => {}),
    start: vi.fn(async () => ({ fellBackToStandard: false })),
    delete: vi.fn(async () => true),
    ...vm,
  };
  const writeVmState = vi.fn(async () => {});
  const requestHomeCheckpoint = vi.fn(async () => {});
  const clearHomeCheckpointRequest = vi.fn(async () => {});
  const clearVmForReplacement = vi.fn(async () => {});
  const clearParkedComputer = vi.fn(async () => {});
  const clock = { now: 1_000 };
  const waits: number[] = [];
  const steps: unknown[] = [];
  const handler = createGatewayVmHandler({
    vm: client,
    readGateway: vi.fn(async () => record),
    writeVmState,
    requestHomeCheckpoint,
    readHomeCheckpointCompletedAt: vi.fn(async () => home.completedAt?.() ?? null),
    clearHomeCheckpointRequest,
    clearVmForReplacement,
    readParkedComputer: vi.fn(async () => home.parked ?? null),
    clearParkedComputer,
    wait: vi.fn(async (ms: number) => { waits.push(ms); clock.now += ms; }),
    now: () => clock.now,
    log: vi.fn(),
    replaceCheckpointTimeoutMs: 60_000,
    replaceCheckpointPollMs: 10_000,
  });
  const run = (input: Record<string, unknown>) => handler(op(input), {
    reportStep: (s) => { steps.push(s); },
    cancellationRequested: async () => home.cancelled?.() ?? false,
  });
  return { client, writeVmState, requestHomeCheckpoint, clearHomeCheckpointRequest, clearVmForReplacement, clearParkedComputer, waits, clock, steps, run };
}

const parkedFresh: BuilderParkedComputer = {
  instanceName: description.name,
  zone: "us-west1-b",
  instanceId: "42",
  gatewayId: "b-old",
  parkedAt: 800,
  checkpoint: { outcome: "fresh", requestedAt: 700, completedAt: 750 },
};
const parkedDescription: GatewayVmDescription = {
  ...description,
  status: "TERMINATED",
  internalIp: null,
  gatewayId: "b-old",
  labels: { "octogee-owner-uid": "uida", "octogee-environment": "test", purpose: "octogee-computer" },
  metadata: { "gateway-id": "b-old" },
};

const gceRecord: GatewayVmRecord = { runtime: "gce-vm", vm: null };

describe("gateway-vm handler", () => {
  it("rejects a missing gateway, a bad action, and a cluster-runtime gateway without touching Compute", async () => {
    const missing = harness(null);
    expect(await missing.run({ gatewayId: "b-x", action: "start" })).toMatchObject({ success: false, error: /does not exist/ });

    const cluster = harness({ ...gceRecord, runtime: "cluster", vm: vmState });
    expect(await cluster.run({ gatewayId: "b-x", action: "start" })).toMatchObject({ success: false, error: /runtime is cluster/ });
    expect(cluster.client.start).not.toHaveBeenCalled();

    const bad = harness({ ...gceRecord, vm: vmState });
    expect(await bad.run({ gatewayId: "b-x", action: "reboot" })).toMatchObject({ success: false, error: /action must be one of/ });
    expect(await bad.run({ action: "start" })).toMatchObject({ success: false, error: /missing gatewayId/ });
    expect(bad.client.start).not.toHaveBeenCalled();
    expect(bad.writeVmState).not.toHaveBeenCalled();
  });

  it("has no create action: converge is the only computer creator, so an operator create never reaches Compute", async () => {
    const h = harness(gceRecord);

    const result = await h.run({ gatewayId: "b-mama-3-abc-hobby", action: "create" });

    expect(result).toMatchObject({ success: false, error: "gateway-vm action must be one of stop, start, delete, replace" });
    expect(h.client.create).not.toHaveBeenCalled();
    expect(h.writeVmState).not.toHaveBeenCalled();
    expect(h.steps).toEqual([]);
  });

  it("stop records an operator stop so Cowboy leaves the computer down; start clears it", async () => {
    const stopped = { ...description, status: "TERMINATED" };
    const h = harness({ ...gceRecord, vm: vmState }, { describe: vi.fn(async () => stopped) });

    const result = await h.run({ gatewayId: "b-mama-3-abc-hobby", action: "stop" });

    expect(result.success).toBe(true);
    expect(h.client.stop).toHaveBeenCalledWith(vmState.instanceName, "us-west1-b");
    expect(h.writeVmState).toHaveBeenCalledWith("b-mama-3-abc-hobby", { ...vmState, status: "TERMINATED", stopReason: "operator", updatedAt: 1_000 });

    const restarted = harness({ ...gceRecord, vm: { ...vmState, status: "TERMINATED", stopReason: "operator" } }, {
      start: vi.fn(async () => ({ fellBackToStandard: true })),
    });
    const started = await restarted.run({ gatewayId: "b-mama-3-abc-hobby", action: "start" });
    expect(started).toMatchObject({ success: true, output: { status: "RUNNING", fellBackToStandard: true } });
    expect(restarted.writeVmState).toHaveBeenCalledWith("b-mama-3-abc-hobby", { ...vmState, updatedAt: 1_000 });

    const none = harness(gceRecord);
    expect(await none.run({ gatewayId: "b-x", action: "start" })).toMatchObject({ success: false, error: /no VM to start/ });
    expect(none.client.start).not.toHaveBeenCalled();
  });

  it("delete clears the VM state even when Compute already lost the instance", async () => {
    const h = harness({ ...gceRecord, vm: vmState }, { delete: vi.fn(async () => false) });

    const result = await h.run({ gatewayId: "b-mama-3-abc-hobby", action: "delete" });

    expect(result).toMatchObject({ success: true, output: { deleted: false } });
    expect(h.writeVmState).toHaveBeenCalledWith("b-mama-3-abc-hobby", null);
  });

  it("replace asks the agent for a final home checkpoint, waits for one newer than the request, then deletes the VM and clears it for converge to recreate", async () => {
    let reads = 0;
    const h = harness({ ...gceRecord, vm: vmState }, {}, { completedAt: () => (reads++ < 2 ? 900 : 1_000) });
    const result = await h.run({ gatewayId: "b-mama-3-abc-hobby", action: "replace" });

    expect(result.success).toBe(true);
    expect(h.requestHomeCheckpoint).toHaveBeenCalledWith("b-mama-3-abc-hobby", 1_000);
    expect(h.waits).toEqual([10_000, 10_000]);
    expect(h.client.delete).toHaveBeenCalledWith(vmState.instanceName, "us-west1-b");
    expect(h.clearVmForReplacement).toHaveBeenCalledWith("b-mama-3-abc-hobby");
    expect(h.writeVmState).not.toHaveBeenCalled();
    expect(h.client.start).not.toHaveBeenCalled();
    expect(h.client.create).not.toHaveBeenCalled();
    expect(h.steps.map((s) => (s as { name: string; status: string }).name)).toEqual(["vm-replace-checkpoint", "vm-replace-delete"]);
    expect(result.output).toEqual({ instanceName: vmState.instanceName, deleted: true, checkpointCompletedAt: 1_000 });
  });

  it("replace starts a stopped computer first so its agent can take the final checkpoint, then deletes it", async () => {
    const stopped = { ...description, status: "TERMINATED", internalIp: null };
    let describes = 0;
    let reads = 0;
    const h = harness(
      { ...gceRecord, vm: { ...vmState, status: "TERMINATED", internalIp: null, stopReason: "operator" } },
      { describe: vi.fn(async () => (describes++ === 0 ? stopped : description)) },
      { completedAt: () => (reads++ < 1 ? null : 2_000) },
    );

    const result = await h.run({ gatewayId: "b-mama-3-abc-hobby", action: "replace" });

    expect(result.success).toBe(true);
    expect(h.client.start).toHaveBeenCalledWith(vmState.instanceName, "us-west1-b");
    expect(h.writeVmState).toHaveBeenCalledWith("b-mama-3-abc-hobby", { ...vmState, updatedAt: 1_000 });
    expect(h.client.start.mock.invocationCallOrder[0]).toBeLessThan(h.requestHomeCheckpoint.mock.invocationCallOrder[0]);
    expect(h.client.delete).toHaveBeenCalledWith(vmState.instanceName, "us-west1-b");
    expect(h.clearVmForReplacement).toHaveBeenCalledWith("b-mama-3-abc-hobby");
    expect(h.steps.map((s) => (s as { name: string; status: string }).name)).toEqual(["vm-replace-start", "vm-replace-checkpoint", "vm-replace-delete"]);
    expect(result.output).toMatchObject({ deleted: true, checkpointCompletedAt: 2_000 });
  });

  it("replace refuses a computer that is still stopping or already absent from Compute, without touching it", async () => {
    const stopping = harness({ ...gceRecord, vm: vmState }, { describe: vi.fn(async () => ({ ...description, status: "STOPPING" })) });
    expect(await stopping.run({ gatewayId: "b-x", action: "replace" })).toMatchObject({ success: false, error: /still stopping/ });
    expect(stopping.requestHomeCheckpoint).not.toHaveBeenCalled();
    expect(stopping.client.delete).not.toHaveBeenCalled();

    const absent = harness({ ...gceRecord, vm: vmState }, { describe: vi.fn(async () => null) });
    expect(await absent.run({ gatewayId: "b-x", action: "replace" })).toMatchObject({ success: false, error: /absent from Compute/ });
    expect(absent.requestHomeCheckpoint).not.toHaveBeenCalled();
    expect(absent.clearVmForReplacement).not.toHaveBeenCalled();
  });

  it("replace keeps the VM when the agent never checkpoints in time, when the operator cancels, or when there is no VM", async () => {
    const stale = harness({ ...gceRecord, vm: vmState }, {}, { completedAt: () => 999 });
    const timedOut = await stale.run({ gatewayId: "b-x", action: "replace" });
    expect(timedOut).toMatchObject({ success: false, error: /did not complete the requested home checkpoint within 60000ms; VM kept/ });
    expect(stale.waits).toEqual([10_000, 10_000, 10_000, 10_000, 10_000, 10_000]);
    expect(stale.client.delete).not.toHaveBeenCalled();
    expect(stale.clearVmForReplacement).not.toHaveBeenCalled();
    expect(stale.steps).toEqual([expect.objectContaining({ name: "vm-replace-checkpoint", status: "failed" })]);

    const cancelled = harness({ ...gceRecord, vm: vmState }, {}, { completedAt: () => null, cancelled: () => true });
    expect(await cancelled.run({ gatewayId: "b-x", action: "replace" })).toMatchObject({ success: false, error: /replace cancelled/ });
    expect(cancelled.client.delete).not.toHaveBeenCalled();
    expect(cancelled.clearHomeCheckpointRequest).toHaveBeenCalledWith("b-x");

    const none = harness(gceRecord);
    expect(await none.run({ gatewayId: "b-x", action: "replace" })).toMatchObject({ success: false, error: /no VM to replace/ });
    expect(none.requestHomeCheckpoint).not.toHaveBeenCalled();
  });

  it("replace reports the delete phase as failed and leaves the record intact when Compute refuses the delete", async () => {
    const h = harness({ ...gceRecord, vm: vmState }, { delete: vi.fn(async () => { throw new Error("PERMISSION_DENIED"); }) }, { completedAt: () => 5_000 });
    const result = await h.run({ gatewayId: "b-x", action: "replace" });
    expect(result).toMatchObject({ success: false, error: "PERMISSION_DENIED" });
    expect(h.steps.map((s) => (s as { name: string; status: string }).status)).toEqual(["done", "failed"]);
    expect(h.clearVmForReplacement).not.toHaveBeenCalled();
  });

  it("replace on a parked computer with a fresh park checkpoint deletes it without starting it and clears the Builder's parked record", async () => {
    const h = harness(null, { describe: vi.fn(async () => parkedDescription) }, { parked: parkedFresh });

    const result = await h.run({ ownerUid: "UidA", action: "replace" });

    expect(result).toEqual({ steps: [expect.objectContaining({ name: "vm-replace-parked", status: "done" })], success: true, output: { instanceName: description.name, deleted: true, checkpointCompletedAt: 750 } });
    expect(h.client.describe).toHaveBeenCalledWith(description.name, "us-west1-b");
    expect(h.client.delete).toHaveBeenCalledWith(description.name, "us-west1-b");
    expect(h.client.start).not.toHaveBeenCalled();
    expect(h.requestHomeCheckpoint).not.toHaveBeenCalled();
    expect(h.writeVmState).not.toHaveBeenCalled();
    expect(h.clearParkedComputer).toHaveBeenCalledWith("UidA");
  });

  it("replace refuses a parked computer whose park checkpoint is stale, pointing at the live-gateway path, without touching Compute", async () => {
    const h = harness(null, {}, { parked: { ...parkedFresh, checkpoint: { outcome: "stale", requestedAt: 700, completedAt: 100 } } });

    const result = await h.run({ ownerUid: "UidA", action: "replace" });

    expect(result).toMatchObject({ success: false, error: /park checkpoint is stale \(last checkpoint 100\).*activate the Builder.*replace through that gateway/ });
    expect(h.steps).toEqual([expect.objectContaining({ name: "vm-replace-parked", status: "failed" })]);
    expect(h.client.describe).not.toHaveBeenCalled();
    expect(h.client.delete).not.toHaveBeenCalled();
    expect(h.clearParkedComputer).not.toHaveBeenCalled();
  });

  it("replace clears a parked record whose computer is already gone, and refuses one that is running, bound to a live gateway, or labelled for another Builder", async () => {
    const gone = harness(null, { describe: vi.fn(async () => null) }, { parked: parkedFresh });
    expect(await gone.run({ ownerUid: "UidA", action: "replace" })).toMatchObject({ success: true, output: { deleted: false } });
    expect(gone.client.delete).not.toHaveBeenCalled();
    expect(gone.clearParkedComputer).toHaveBeenCalledWith("UidA");

    const running = harness(null, { describe: vi.fn(async () => ({ ...parkedDescription, status: "RUNNING" })) }, { parked: parkedFresh });
    expect(await running.run({ ownerUid: "UidA", action: "replace" })).toMatchObject({ success: false, error: /expected the parked computer to be stopped, found RUNNING/ });

    const live = harness(gceRecord, { describe: vi.fn(async () => parkedDescription) }, { parked: parkedFresh });
    expect(await live.run({ ownerUid: "UidA", action: "replace" })).toMatchObject({ success: false, error: /bound to live gateway b-old; replace it through that gateway/ });

    const foreign = harness(null, { describe: vi.fn(async () => ({ ...parkedDescription, labels: { ...parkedDescription.labels, "octogee-owner-uid": "uidb" } })) }, { parked: parkedFresh });
    expect(await foreign.run({ ownerUid: "UidA", action: "replace" })).toMatchObject({ success: false, error: /labelled for uidb, not UidA/ });

    for (const h of [running, live, foreign]) {
      expect(h.client.delete).not.toHaveBeenCalled();
      expect(h.clearParkedComputer).not.toHaveBeenCalled();
    }
  });

  it("the ownerUid form supports only replace, and refuses a Builder without a parked computer", async () => {
    const stop = harness(null, {}, { parked: parkedFresh });
    expect(await stop.run({ ownerUid: "UidA", action: "stop" })).toMatchObject({ success: false, error: /ownerUid form supports only replace/ });
    expect(stop.client.describe).not.toHaveBeenCalled();

    const none = harness(null);
    expect(await none.run({ ownerUid: "UidA", action: "replace" })).toMatchObject({ success: false, error: /UidA has no parked computer/ });
    expect(none.client.delete).not.toHaveBeenCalled();
  });

  it("reports a failed step and leaves state untouched when Compute throws", async () => {
    const h = harness({ ...gceRecord, vm: vmState }, { start: vi.fn(async () => { throw new Error("QUOTA_EXCEEDED: cpus"); }) });

    const result = await h.run({ gatewayId: "b-x", action: "start" });

    expect(result).toMatchObject({ success: false, error: "QUOTA_EXCEEDED: cpus" });
    expect(h.steps).toEqual([expect.objectContaining({ name: "vm-start", status: "failed", error: "QUOTA_EXCEEDED: cpus" })]);
    expect(h.writeVmState).not.toHaveBeenCalled();
  });
});
