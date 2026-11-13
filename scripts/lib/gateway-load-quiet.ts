import { cpuQuantityCores, type Kubectl } from "./gateway-load-sampler.js";
import { SHARED_SLOT_RE, TEST_NAMESPACE } from "./gateway-load-test.js";

export interface QuietSlot { slot: string; cores: number; pods: number; ready: boolean }

export interface QuietSample { at: number; deploysRunning: number; slots: QuietSlot[] }

export function busyReasons(sample: QuietSample, maxCores: number): string[] {
  const reasons: string[] = [];
  if (sample.deploysRunning > 0) reasons.push("a Ship TEST or platform deploy is running");
  if (sample.slots.length === 0) reasons.push("no shared slot is serving");
  for (const slot of sample.slots) {
    if (slot.cores >= maxCores) reasons.push(`${slot.slot} at ${slot.cores.toFixed(2)} cores`);
    if (slot.pods !== 1) reasons.push(`${slot.slot} has ${slot.pods} pods`);
    if (!slot.ready) reasons.push(`${slot.slot} is not ready`);
  }
  return reasons;
}

export function quietSince(since: number | null, sample: QuietSample, maxCores: number): number | null {
  if (busyReasons(sample, maxCores).length > 0) return null;
  return since ?? sample.at;
}

type Pod = {
  metadata: { name: string; deletionTimestamp?: string; labels?: Record<string, string> };
  spec: { containers: { name: string }[] };
  status: { containerStatuses?: { ready: boolean }[] };
};

export async function readSharedQuietSlots(kubectl: Kubectl): Promise<QuietSlot[]> {
  const pods = (JSON.parse(await kubectl("get", "pods", "-l", "app=octogee-gateway", "-o", "json")).items as Pod[])
    .filter((pod) => !pod.metadata.deletionTimestamp && SHARED_SLOT_RE.test(pod.metadata.labels?.["gateway-id"] ?? ""));
  const slots = new Map<string, QuietSlot>();
  for (const pod of pods) {
    const slot = pod.metadata.labels!["gateway-id"];
    const ready = pod.status.containerStatuses?.length === pod.spec.containers.length && pod.status.containerStatuses.every((c) => c.ready);
    const metrics = ready
      ? JSON.parse(await kubectl("get", "--raw", `/apis/metrics.k8s.io/v1beta1/namespaces/${TEST_NAMESPACE}/pods/${pod.metadata.name}`))
      : { containers: [] };
    const cores = ready ? pod.spec.containers.reduce((sum, container) => {
      const usage = (metrics.containers as { name: string; usage?: { cpu?: string } }[])
        .find((c) => c.name === container.name)?.usage;
      if (!usage) throw new Error(`Missing CPU metrics for ${pod.metadata.name}/${container.name}`);
      return sum + cpuQuantityCores(usage.cpu);
    }, 0) : 0;
    const current = slots.get(slot) ?? { slot, cores: 0, pods: 0, ready: true };
    slots.set(slot, { slot, cores: current.cores + cores, pods: current.pods + 1, ready: current.ready && ready });
  }
  return [...slots.values()].sort((a, b) => a.slot.localeCompare(b.slot));
}
