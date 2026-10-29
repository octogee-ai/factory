import type { Firestore } from "firebase-admin/firestore";
import { disposableBuilderPrelaunchReserved } from "@octogee/core/disposable-builder-prelaunch";
export { disposableBuilderPrelaunchReserved } from "@octogee/core/disposable-builder-prelaunch";
import {
  isGatewayRuntimeDoc,
} from "@octogee/shared/types/gateway-releases";
import { gatewayHeartbeatMatchesImageTag } from "@octogee/shared/types/image-tag";
import type { DurableGateway } from "./converge-gateway.js";

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export function runtimeMatchesPrelaunchRelease(
  gateway: DurableGateway,
  runtime: unknown,
  image: { imageRepository: string; imageTag: string },
): boolean {
  if (!isGatewayRuntimeDoc(runtime) || record(runtime)?.runtime !== "gce-vm") return false;
  return [
    gateway.liveRelease !== null && gateway.liveRelease < gateway.desiredRelease,
    runtime.gatewayId === gateway.gatewayId,
    runtime.release === gateway.desiredRelease,
    runtime.helm?.imageRepository === image.imageRepository,
    runtime.helm?.imageTag === image.imageTag,
    runtime.heartbeat?.status === "booting",
    gatewayHeartbeatMatchesImageTag(runtime.heartbeat?.version, image.imageTag),
    Array.isArray(runtime.heartbeat?.mountedCustomers) && runtime.heartbeat.mountedCustomers.length === 0,
  ].every(Boolean);
}

export async function readDisposableBuilderPrelaunchRefresh(input: {
  db: Firestore;
  gateway: DurableGateway;
  runtime: unknown;
  image: { imageRepository: string; imageTag: string };
  observedImage: { imageRepository: string | null; imageTag: string | null } | null;
}): Promise<boolean> {
  return runtimeMatchesPrelaunchRelease(input.gateway, input.runtime, input.image) &&
    input.observedImage?.imageRepository === input.image.imageRepository &&
    input.observedImage.imageTag === input.image.imageTag &&
    await disposableBuilderPrelaunchReserved(input);
}
