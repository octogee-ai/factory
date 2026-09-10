import { isGatewayVmDiskObservation, resolveGatewayRuntime, type GatewayVmState } from "@octogee/shared/types/glm";
import type { MirrorDocChange } from "../fleet-informer.js";

export interface VmDiskSample {
  gatewayId: string;
  sizeBytes: number;
  freeBytes: number;
  observedAt: number;
}

export function vmDiskSampleFromDoc(gatewayId: string, data: Record<string, unknown> | undefined): VmDiskSample | null {
  if (resolveGatewayRuntime(data?.runtime) !== "gce-vm") return null;
  const vm = data?.vm as Partial<GatewayVmState> | null | undefined;
  const disk = data?.vmDisk;
  if (!vm || vm.status !== "RUNNING" || !isGatewayVmDiskObservation(disk) || disk.instanceId !== vm.instanceId) return null;
  return { gatewayId, sizeBytes: disk.sizeBytes, freeBytes: disk.freeBytes, observedAt: disk.observedAt };
}

export function applyVmDiskChanges(
  samples: Map<string, VmDiskSample>,
  changes: readonly MirrorDocChange[],
  options: { reset: boolean },
): VmDiskSample[] {
  if (options.reset) samples.clear();
  for (const change of changes) {
    const sample = change.type === "removed" ? null : vmDiskSampleFromDoc(change.doc.id, change.doc.data());
    if (sample) samples.set(change.doc.id, sample);
    else samples.delete(change.doc.id);
  }
  return [...samples.values()].sort((a, b) => a.gatewayId.localeCompare(b.gatewayId));
}
