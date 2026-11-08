import { builderActivateOperationId } from "./builder-activation-lease.js";
import { accountAllowsInteractiveAccess } from "@octogee/shared/types/account-lifecycle";
import type { GatewayDoc } from "@octogee/shared/types/gateway-releases";
import type { GatewayMutableConfig } from "@octogee/shared/types/gateway-mutable-config";
import type { BuilderActivationLease, BuilderRecord } from "./platform-state/builders.js";
import type { PlatformStateRepositories } from "./platform-state/store.js";

type DurableGateway = GatewayDoc & GatewayMutableConfig;

export type PrelaunchAuthorityReader = Pick<PlatformStateRepositories, "builders" | "gateways">;

function prelaunchStatusMatches(gatewayId: string, generation: number, lease: BuilderActivationLease, activationBoot: boolean): boolean {
  return lease.status === "provisioning" && lease.activationOperationId === undefined && lease.activatingAt === undefined ||
    activationBoot && ["provisioning", "activating"].includes(lease.status) &&
    lease.activationOperationId === builderActivateOperationId(gatewayId, generation);
}

function prelaunchLease(gateway: DurableGateway, builder: BuilderRecord | null, activationBoot = false): BuilderActivationLease | null {
  const lease = builder?.activationLease ?? null;
  const allocation = gateway.allocation;
  if (!builder || !accountAllowsInteractiveAccess({ accountLifecycle: builder.accountLifecycle }) || !lease || !allocation) return null;
  return [
    gateway.desiredStatus === "running",
    gateway.gatewayClass === "builder",
    allocation.kind === "disposable-builder",
    gateway.ownerUid === allocation.claimedByUid,
    lease.leaseId === allocation.leaseId,
    lease.generation === allocation.generation,
    lease.targetGatewayId === gateway.gatewayId,
    prelaunchStatusMatches(gateway.gatewayId, allocation.generation, lease, activationBoot),
    lease.activeAt === undefined,
    typeof lease.sourceGatewayId === "string",
    lease.sourceGatewayId !== gateway.gatewayId,
    builder.gateway?.gatewayId === lease.sourceGatewayId,
    builder.slug === gateway.builderSlug,
    lease.builderSlug === gateway.builderSlug,
    Number.isSafeInteger(lease.sourceAssignmentEpoch),
  ].every(Boolean) ? lease : null;
}

function samePrelaunchAllocation(gateway: DurableGateway, expected: DurableGateway): boolean {
  return [
    gateway.ownerUid === expected.ownerUid,
    gateway.builderSlug === expected.builderSlug,
    gateway.allocation?.leaseId === expected.allocation?.leaseId,
    gateway.allocation?.generation === expected.allocation?.generation,
    gateway.latestRelease === expected.latestRelease,
  ].every(Boolean);
}

export async function disposableBuilderPrelaunchReserved(input: {
  reader: PrelaunchAuthorityReader;
  gateway: DurableGateway;
  expectedGateway?: DurableGateway;
  activationBoot?: true;
}): Promise<boolean> {
  const { reader, gateway, expectedGateway } = input;
  if (expectedGateway && !samePrelaunchAllocation(gateway, expectedGateway)) return false;
  if (gateway.gatewayClass !== "builder" || gateway.allocation?.kind !== "disposable-builder" || !gateway.ownerUid) {
    return false;
  }
  const lease = prelaunchLease(gateway, await reader.builders.records.get(gateway.ownerUid), input.activationBoot);
  if (!lease) return false;
  const sourceGatewayId = lease.sourceGatewayId!;
  const [sourceRoot, assigned, targetEmpty] = await Promise.all([
    reader.gateways.roots.get(sourceGatewayId),
    reader.gateways.assignments.get(sourceGatewayId, gateway.ownerUid),
    reader.gateways.assignments.isEmpty(gateway.gatewayId),
  ]);
  if (!assigned || sourceRoot?.gatewayClass !== "shared") return false;
  return [
    assigned.uid === gateway.ownerUid,
    assigned.slug === gateway.builderSlug,
    assigned.gatewayId === sourceGatewayId,
    assigned.state === "serving",
    assigned.epoch === lease.sourceAssignmentEpoch,
    targetEmpty,
  ].every(Boolean);
}

function activationLeaseMatches(gateway: DurableGateway, lease: BuilderActivationLease | null): lease is BuilderActivationLease {
  return Boolean(lease && lease.leaseId === gateway.allocation?.leaseId && lease.generation === gateway.allocation?.generation &&
    lease.targetGatewayId === gateway.gatewayId && gateway.allocation?.claimedByUid === gateway.ownerUid && lease.builderSlug === gateway.builderSlug);
}

function activationBootMode(gateway: DurableGateway, lease: BuilderActivationLease): { mode: "prelaunch" | "normal" | "activating"; migrationId?: string } {
  if (["active", "returning", "failed"].includes(lease.status)) return { mode: "normal" };
  if (lease.status === "activating" || (lease.status === "provisioning" && lease.activationOperationId !== undefined)) {
    if (typeof lease.activationOperationId !== "string" || lease.activationOperationId !== builderActivateOperationId(gateway.gatewayId, gateway.allocation!.generation)) {
      throw new Error("Builder activation operation is unavailable");
    }
    return { mode: "activating", migrationId: `mig-${lease.activationOperationId}` };
  }
  if (lease.status !== "provisioning" || lease.activatingAt !== undefined || lease.activeAt !== undefined) throw new Error("Builder prelaunch authority is inconsistent");
  return { mode: "prelaunch" };
}

async function hasServingBuilderAssignment(reader: PrelaunchAuthorityReader, gateway: DurableGateway, builder: BuilderRecord): Promise<boolean> {
  if (builder.gateway?.gatewayId !== gateway.gatewayId) return false;
  const assigned = await reader.gateways.assignments.get(gateway.gatewayId, builder.uid);
  return assigned?.uid === builder.uid && assigned.state === "serving";
}

export async function disposableBuilderBootMode(input: {
  reader: PrelaunchAuthorityReader; gateway: DurableGateway;
}): Promise<{ mode: "prelaunch" | "normal" | "activating"; migrationId?: string }> {
  const { gateway, reader } = input;
  if (gateway.gatewayClass !== "builder" || gateway.allocation?.kind !== "disposable-builder") return { mode: "normal" };
  if (!gateway.ownerUid) throw new Error("Builder prelaunch owner is unavailable");
  const builder = await reader.builders.records.get(gateway.ownerUid);
  if (!builder) throw new Error("Builder prelaunch owner is unavailable");
  if (await hasServingBuilderAssignment(reader, gateway, builder)) return { mode: "normal" };
  const lease = builder.activationLease;
  if (!activationLeaseMatches(gateway, lease)) {
    throw new Error("Builder activation authority is inconsistent");
  }
  const boot = activationBootMode(gateway, lease);
  if (boot.mode !== "normal" && await disposableBuilderPrelaunchReserved({ ...input, activationBoot: true })) return { mode: "prelaunch" };
  if (boot.mode === "prelaunch") throw new Error("Builder prelaunch authority is inconsistent");
  return boot;
}
