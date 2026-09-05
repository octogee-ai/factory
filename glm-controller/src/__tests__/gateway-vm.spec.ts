import { describe, it, expect, vi } from "vitest";
import type { Operation, GatewayVmState } from "@octogee/shared/types/glm";
import { createGatewayVmHandler, type GatewayVmRecord } from "../handlers/gateway-vm";
import type { GatewayVmClient, GatewayVmDescription } from "../lib/compute-vm";

const spec = {
  zone: "us-west1-b",
  machineType: "n2-standard-4",
  imageFamily: "octogee-computer",
  diskSizeGb: 40,
  provisioningModel: "SPOT" as const,
  serviceAccountEmail: "octogee-gw-b-mama-3-abc-hobby@octogee-test.iam.gserviceaccount.com",
  subnetwork: "regions/us-west1/subnetworks/octogee-gateways",
};

const description: GatewayVmDescription = {
  name: "octogee-gw-b-mama-3-abc-hobby",
  zone: "us-west1-b",
  status: "RUNNING",
  instanceId: "42",
  internalIp: "10.138.0.9",
  provisioningModel: "SPOT",
};

const vmState: GatewayVmState = {
  instanceName: description.name,
  zone: "us-west1-b",
  instanceId: "42",
  internalIp: "10.138.0.9",
  status: "RUNNING",
  provisioningModel: "SPOT",
  updatedAt: 1,
};

function op(input: Record<string, unknown>): Operation {
  return { id: "op-1", kind: "gateway-vm", input } as unknown as Operation;
}

function harness(record: GatewayVmRecord | null, vm: Partial<GatewayVmClient> = {}) {
  const client: GatewayVmClient = {
    create: vi.fn(async () => ({ description, provisioningModel: "SPOT", fellBackToStandard: false, alreadyExisted: false })),
    describe: vi.fn(async () => description),
    stop: vi.fn(async () => {}),
    start: vi.fn(async () => {}),
    delete: vi.fn(async () => true),
    ...vm,
  };
  const writeVmState = vi.fn(async () => {});
  const steps: unknown[] = [];
  const handler = createGatewayVmHandler({
    vm: client,
    readGateway: vi.fn(async () => record),
    writeVmState,
    environment: "test",
    now: () => 1_000,
    log: vi.fn(),
  });
  const run = (input: Record<string, unknown>) => handler(op(input), { reportStep: (s) => { steps.push(s); } });
  return { client, writeVmState, steps, run };
}

const gceRecord: GatewayVmRecord = { runtime: "gce-vm", vmSpec: spec, vm: null, ownerUid: "UidA" };

describe("gateway-vm handler", () => {
  it("rejects a missing gateway, a bad action, and a cluster-runtime gateway without touching Compute", async () => {
    const missing = harness(null);
    expect(await missing.run({ gatewayId: "b-x", action: "create" })).toMatchObject({ success: false, error: /does not exist/ });

    const cluster = harness({ ...gceRecord, runtime: "cluster" });
    expect(await cluster.run({ gatewayId: "b-x", action: "create" })).toMatchObject({ success: false, error: /runtime is cluster/ });

    const bad = harness(gceRecord);
    expect(await bad.run({ gatewayId: "b-x", action: "reboot" })).toMatchObject({ success: false, error: /action must be one of/ });
    expect(await bad.run({ action: "create" })).toMatchObject({ success: false, error: /missing gatewayId/ });
    expect(bad.client.create).not.toHaveBeenCalled();
    expect(bad.writeVmState).not.toHaveBeenCalled();
  });

  it("create derives the instance from the spec, labels it for the tenant, and records the VM state", async () => {
    const h = harness(gceRecord);

    const result = await h.run({ gatewayId: "b-mama-3-abc-hobby", action: "create" });

    expect(result.success).toBe(true);
    expect(h.client.create).toHaveBeenCalledWith({
      instanceName: "octogee-gw-b-mama-3-abc-hobby",
      ...spec,
      labels: {
        "octogee-gateway-id": "b-mama-3-abc-hobby",
        "octogee-environment": "test",
        purpose: "octogee-computer",
        "octogee-owner-uid": "uida",
      },
      metadata: { "gateway-id": "b-mama-3-abc-hobby", "octogee-environment": "test" },
    });
    expect(h.writeVmState).toHaveBeenCalledWith("b-mama-3-abc-hobby", { ...vmState, updatedAt: 1_000 });
    expect(result.output).toMatchObject({ instanceName: "octogee-gw-b-mama-3-abc-hobby", provisioningModel: "SPOT", internalIp: "10.138.0.9" });
    expect(h.steps).toEqual([{ name: "vm-create", status: "done", startedAt: 1_000, completedAt: 1_000 }]);
  });

  it("create deletes the VM it just made when the gateway record refuses the state, and keeps an adopted one", async () => {
    const fresh = harness(gceRecord);
    fresh.writeVmState.mockRejectedValueOnce(new Error("NOT_FOUND: glmGateways/b-x"));
    const result = await fresh.run({ gatewayId: "b-x", action: "create" });
    expect(result).toMatchObject({ success: false, error: /NOT_FOUND/ });
    expect(fresh.client.delete).toHaveBeenCalledWith("octogee-gw-b-x", "us-west1-b");
    expect(fresh.steps).toEqual([{ name: "vm-create", status: "failed", startedAt: 1_000, completedAt: 1_000, error: "NOT_FOUND: glmGateways/b-x" }]);

    const adopted = harness(gceRecord, {
      create: vi.fn(async () => ({ description, provisioningModel: "SPOT", fellBackToStandard: false, alreadyExisted: true })),
    });
    adopted.writeVmState.mockRejectedValueOnce(new Error("NOT_FOUND"));
    await adopted.run({ gatewayId: "b-x", action: "create" });
    expect(adopted.client.delete).not.toHaveBeenCalled();
  });

  it("create refuses a gateway without a valid vmSpec", async () => {
    const h = harness({ ...gceRecord, vmSpec: { ...spec, diskSizeGb: 0 } });
    const result = await h.run({ gatewayId: "b-x", action: "create" });
    expect(result).toMatchObject({ success: false, error: /no valid vmSpec/ });
    expect(h.client.create).not.toHaveBeenCalled();
  });

  it("stop and start need a recorded VM, then refresh the state from Compute", async () => {
    const stopped = { ...description, status: "TERMINATED" };
    const h = harness({ ...gceRecord, vm: vmState }, { describe: vi.fn(async () => stopped) });

    const result = await h.run({ gatewayId: "b-mama-3-abc-hobby", action: "stop" });

    expect(result.success).toBe(true);
    expect(h.client.stop).toHaveBeenCalledWith(vmState.instanceName, "us-west1-b");
    expect(h.writeVmState).toHaveBeenCalledWith("b-mama-3-abc-hobby", expect.objectContaining({ status: "TERMINATED" }));

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

  it("reports a failed step and leaves state untouched when Compute throws", async () => {
    const h = harness(gceRecord, { create: vi.fn(async () => { throw new Error("QUOTA_EXCEEDED: cpus"); }) });

    const result = await h.run({ gatewayId: "b-x", action: "create" });

    expect(result).toMatchObject({ success: false, error: "QUOTA_EXCEEDED: cpus" });
    expect(h.steps).toEqual([expect.objectContaining({ name: "vm-create", status: "failed", error: "QUOTA_EXCEEDED: cpus" })]);
    expect(h.writeVmState).not.toHaveBeenCalled();
  });
});
