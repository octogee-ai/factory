import { isGatewayVmImageObservation } from "@octogee/shared/types/glm";
import type { FleetLiveObservation } from "./fleet-deploy.js";

export function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function text(value: unknown, field: string): string {
  if (typeof value !== "string" || !value) throw new Error(`live observation is missing ${field}`);
  return value;
}

export function observedDigest(value: unknown): string | null {
  return typeof value === "string" ? /(sha256:[a-f0-9]{64})$/.exec(value)?.[1] ?? null : null;
}

function podInstance(value: Record<string, unknown>): FleetLiveObservation["instances"][number] {
  const metadata = object(value.metadata);
  const status = object(value.status);
  const statuses = array(status.containerStatuses).map(object);
  return {
    id: text(metadata.uid, "pod UID"),
    ready: !metadata.deletionTimestamp && array(status.conditions).map(object).some((condition) => condition.type === "Ready" && condition.status === "True"),
    containers: array(object(value.spec).containers).map((entry) => {
      const container = object(entry);
      const name = text(container.name, "container name");
      const observed = statuses.find((candidate) => candidate.name === name);
      const digest = observedDigest(observed?.imageID);
      return {
        name, image: text(container.image, "container image"), digests: digest ? [digest] : [],
        running: observed?.ready === true && object(observed.state).running !== undefined,
      };
    }),
  };
}

export function fleetPodObservations(value: unknown, observedAt: number): Map<string, FleetLiveObservation> {
  const list = object(value);
  if (!Array.isArray(list.items)) throw new Error("Kubernetes pod list has no items array");
  const result = new Map<string, FleetLiveObservation>();
  for (const entry of list.items) {
    const pod = object(entry);
    const gatewayId = text(object(object(pod.metadata).labels)["gateway-instance"], "gateway-instance label");
    const observation = result.get(gatewayId) ?? { observedAt, instances: [] };
    const phase = object(pod.status).phase;
    if (phase !== "Succeeded" && phase !== "Failed") observation.instances.push(podInstance(pod));
    result.set(gatewayId, observation);
  }
  return result;
}

export function fleetVmObservation(runtime: Record<string, unknown>): FleetLiveObservation | null {
  const images = runtime.vmImages;
  const vm = object(runtime.vm);
  if (!isGatewayVmImageObservation(images) || images.instanceId !== vm.instanceId || vm.status !== "RUNNING") return null;
  const containers = images.containers.map((container) => ({
    name: container.name, image: container.imageReference, running: container.running,
    digests: container.digests.map(observedDigest).filter((digest): digest is string => digest !== null),
  }));
  return { observedAt: images.observedAt, instances: [{ id: images.instanceId, ready: containers.every((container) => container.running), containers }] };
}
