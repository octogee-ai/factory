import { describe, expect, it } from "vitest";
import type { MirrorDocChange } from "../fleet-informer.js";
import { applyVmDiskChanges, vmDiskSampleFromDoc } from "./vm-disk-usage.js";

const disk = { sizeBytes: 40_000_000_000, freeBytes: 3_000_000_000, instanceId: "4242", observedAt: 1_000 };
const running = (overrides: Record<string, unknown> = {}) => ({ runtime: "gce-vm", vm: { status: "RUNNING", instanceId: "4242" }, vmDisk: disk, ...overrides });
const change = (type: string, id: string, data: Record<string, unknown> | undefined): MirrorDocChange =>
  ({ type, doc: { id, data: () => data } } as unknown as MirrorDocChange);

describe("vmDiskSampleFromDoc", () => {
  it("samples only a running gce-vm whose observation came from its current instance", () => {
    expect(vmDiskSampleFromDoc("b-x", running())).toEqual({ gatewayId: "b-x", sizeBytes: disk.sizeBytes, freeBytes: disk.freeBytes, observedAt: 1_000 });
    expect(vmDiskSampleFromDoc("b-x", running({ runtime: "cluster" }))).toBeNull();
    expect(vmDiskSampleFromDoc("b-x", running({ vm: { status: "TERMINATED", instanceId: "4242" } }))).toBeNull();
    expect(vmDiskSampleFromDoc("b-x", running({ vm: { status: "RUNNING", instanceId: "9999" } }))).toBeNull();
    expect(vmDiskSampleFromDoc("b-x", running({ vmDisk: { ...disk, freeBytes: -1 } }))).toBeNull();
    expect(vmDiskSampleFromDoc("b-x", running({ vmDisk: undefined }))).toBeNull();
    expect(vmDiskSampleFromDoc("b-x", undefined)).toBeNull();
  });
});

describe("applyVmDiskChanges", () => {
  it("tracks the mirror: adds, modifies, drops removed or no-longer-sampled gateways, and resets on a primed delivery", () => {
    const samples = new Map();
    expect(applyVmDiskChanges(samples, [change("added", "b-y", running()), change("added", "b-x", running())], { reset: true }).map((s) => s.gatewayId)).toEqual(["b-x", "b-y"]);
    expect(applyVmDiskChanges(samples, [change("modified", "b-x", running({ vmDisk: { ...disk, freeBytes: 1 } }))], { reset: false })).toMatchObject([{ gatewayId: "b-x", freeBytes: 1 }, { gatewayId: "b-y" }]);
    expect(applyVmDiskChanges(samples, [change("modified", "b-y", running({ vm: { status: "STOPPING", instanceId: "4242" } }))], { reset: false }).map((s) => s.gatewayId)).toEqual(["b-x"]);
    expect(applyVmDiskChanges(samples, [change("removed", "b-x", undefined)], { reset: false })).toEqual([]);
    samples.set("stale", { gatewayId: "stale", sizeBytes: 1, freeBytes: 1, observedAt: 1 });
    expect(applyVmDiskChanges(samples, [change("added", "b-x", running())], { reset: true }).map((s) => s.gatewayId)).toEqual(["b-x"]);
  });
});
