import type { Firestore } from "firebase-admin/firestore";
import { GATEWAYS_COLLECTION } from "@octogee/shared/types/fleet-controller";
import { GLM_GATEWAYS_COLLECTION } from "@octogee/shared/types/glm";
import { isGatewayRuntimeDoc } from "@octogee/shared/types/gateway-releases";
import type { GatewayVmClient, GatewayVmDescription } from "./compute-vm.js";

interface NativeRetirementInput {
  gatewayId: string;
  operationId: string;
  version: number;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function pausedRetirementClaimMatches(root: Record<string, unknown>, input: NativeRetirementInput): boolean {
  const claim = record(root.retirementClaim);
  return root.gatewayId === input.gatewayId && root.gatewayClass === "builder" &&
    nonEmpty(root.ownerUid) && root.desiredStatus === "retired" &&
    claim.operationId === input.operationId && claim.version === input.version &&
    claim.phase === "claimed" && claim.previousDesiredStatus === "paused";
}

function stoppedComputerMatches(
  current: GatewayVmDescription,
  vm: Record<string, unknown>,
  root: Record<string, unknown>,
  gatewayId: string,
): boolean {
  return current.instanceId === vm.instanceId &&
    current.name === vm.instanceName && current.zone === vm.zone &&
    current.gatewayId === gatewayId &&
    current.labels["octogee-owner-uid"] === (root.ownerUid as string).toLowerCase() &&
    current.metadata["octogee-owner-uid"] === root.ownerUid &&
    ["TERMINATED", "STOPPED", "SUSPENDED"].includes(current.status);
}

export async function pausedNativeRetirementSourceFencedOff(
  deps: { db: Pick<Firestore, "collection">; describe: GatewayVmClient["describe"] },
  input: NativeRetirementInput,
): Promise<boolean> {
  const [rootSnap, runtimeSnap] = await Promise.all([
    deps.db.collection(GATEWAYS_COLLECTION).doc(input.gatewayId).get(),
    deps.db.collection(GLM_GATEWAYS_COLLECTION).doc(input.gatewayId).get(),
  ]);
  const root = record(rootSnap.data());
  if (!pausedRetirementClaimMatches(root, input)) return false;
  if (!runtimeSnap.exists) return false;
  const runtime = runtimeSnap.data();
  const observed = record(runtime);
  if (!isGatewayRuntimeDoc(runtime) || runtime.gatewayId !== input.gatewayId || observed.runtime !== "gce-vm") return false;
  const vm = record(observed.vm);
  if (!nonEmpty(vm.instanceName) || !nonEmpty(vm.instanceId) || !nonEmpty(vm.zone)) return false;
  const current = await deps.describe(vm.instanceName, vm.zone);
  return current === null || stoppedComputerMatches(current, vm, root, input.gatewayId);
}
