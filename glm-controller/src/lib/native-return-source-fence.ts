import type { DocumentData } from "firebase-admin/firestore";
import type { GatewayVmClient } from "./compute-vm.js";

export function nativeReturnSourceIdentity(runtime: DocumentData | undefined, root: DocumentData | undefined) {
  const vm = runtime?.vm;
  if (runtime?.runtime !== "gce-vm" || root?.gatewayClass !== "builder" ||
      !["paused", "retired"].includes(root.desiredStatus) ||
      ![root.ownerUid, root.builderSlug, vm?.instanceName, vm?.zone, vm?.instanceId].every(v => typeof v === "string" && v.length > 0)) return null;
  return { ownerUid: root.ownerUid, slug: root.builderSlug, desiredStatus: root.desiredStatus,
    instanceName: vm.instanceName, zone: vm.zone, instanceId: vm.instanceId };
}

export async function nativeReturnSourceStopped(vm: Pick<GatewayVmClient, "describe">,
  identity: NonNullable<ReturnType<typeof nativeReturnSourceIdentity>>): Promise<boolean> {
  const current = await vm.describe(identity.instanceName, identity.zone);
  return current === null || current.instanceId === identity.instanceId && ["TERMINATED", "STOPPED", "SUSPENDED"].includes(current.status);
}
