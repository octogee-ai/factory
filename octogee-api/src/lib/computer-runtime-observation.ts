import {
  DuplicateRecordError,
  type BuilderRecord,
  type FleetRegistryRecord,
  type PlatformStateRepositories,
  type PlatformStateStore,
  type PlatformStateTransaction,
  type Stored,
} from "@octogee/core/platform-state";
import {
  isGatewayVmDiskObservation,
  isDisposableHomeCheckpoint,
  resolveGatewayRuntime,
  vmDiskFreePercent,
  type GatewayVmDiskObservation,
  type GatewayVmBootRecoverySample,
  type GatewayVmHomeState,
  type GatewayVmHomeCheckpoint,
  type GatewayVmImageObservation,
  type GatewayVmPreemptionNotice,
} from "@octogee/shared/types/glm";

export const COMPUTER_DISK_OBSERVATION_REFRESH_MS = 10 * 60_000;

async function runtimeForInstance(
  store: Pick<PlatformStateRepositories, "fleetRegistry">,
  instanceId: string,
): Promise<Stored<FleetRegistryRecord> | null> {
  try {
    return await store.fleetRegistry.findByVmInstanceId(instanceId);
  } catch (error) {
    if (error instanceof DuplicateRecordError) return null;
    throw error;
  }
}

export async function findComputerRuntimeForInstance(
  store: Pick<PlatformStateRepositories, "fleetRegistry">,
  instanceId: string,
): Promise<{ gatewayId: string; home: Partial<GatewayVmHomeState> | undefined } | null> {
  const runtime = await runtimeForInstance(store, instanceId);
  if (!runtime || resolveGatewayRuntime(runtime.runtime) !== "gce-vm") return null;
  return { gatewayId: runtime.gatewayId, home: runtime.vmHome };
}

export async function readComputerRuntimeObservation(store: Pick<PlatformStateRepositories, "fleetRegistry">, gatewayId: string): Promise<Stored<FleetRegistryRecord> | undefined> {
  return (await store.fleetRegistry.get(gatewayId)) ?? undefined;
}

type CheckpointOwner = { uid: string; instanceId: string };

function runtimeCheckpointMatches(runtime: FleetRegistryRecord, owner: CheckpointOwner): boolean {
  return runtime.runtime === "gce-vm" && runtime.vm?.instanceId === owner.instanceId;
}

async function checkpointOwnerAuthority(tx: PlatformStateTransaction, gatewayId: string, owner?: CheckpointOwner): Promise<Stored<BuilderRecord> | null> {
  if (!owner) return null;
  const [builder, gateway] = await Promise.all([tx.builders.records.get(owner.uid), tx.gateways.roots.get(gatewayId)]);
  if (!builder || gateway?.ownerUid !== owner.uid) throw new Error("computer checkpoint owner changed before acceptance");
  return builder;
}

function checkpointObservationAdvances(previous: Partial<GatewayVmHomeState> | undefined, home: Partial<GatewayVmHomeState>, incoming: GatewayVmHomeCheckpoint): boolean {
  const previousName = previous?.lastCheckpoint?.name;
  if (previousName && previousName > incoming.name) return false;
  return previousName !== incoming.name || (previous?.checkpointAcknowledgedAt ?? -1) < (home.checkpointAcknowledgedAt ?? -1);
}

function nextHomeRecovery(builder: Stored<BuilderRecord>, incoming: GatewayVmHomeCheckpoint): GatewayVmHomeCheckpoint | null {
  if (!isDisposableHomeCheckpoint(incoming)) return null;
  const recovery: unknown = builder.home.homeCheckpoint;
  if (recovery === undefined) return incoming;
  if (!isDisposableHomeCheckpoint(recovery)) throw new Error("Builder home recovery checkpoint is malformed");
  return recovery.name <= incoming.name ? incoming : null;
}

export async function recordComputerHomeCheckpoint(store: PlatformStateStore, gatewayId: string, home: Partial<GatewayVmHomeState>, owner?: CheckpointOwner): Promise<void> {
  const incoming = home.lastCheckpoint;
  if (!incoming) throw new Error("cannot record an empty computer checkpoint");
  await store.transaction({ label: "computer-runtime.home-checkpoint" }, async (tx) => {
    const runtime = await tx.fleetRegistry.get(gatewayId);
    if (!runtime) return;
    if (owner && !runtimeCheckpointMatches(runtime, owner)) throw new Error("computer checkpoint binding changed before acceptance");
    const builder = await checkpointOwnerAuthority(tx, gatewayId, owner);
    if (!checkpointObservationAdvances(runtime.vmHome, home, incoming)) return;
    const recovery = builder ? nextHomeRecovery(builder, incoming) : null;
    await tx.fleetRegistry.patch(gatewayId, { vmHome: { ...runtime.vmHome, ...home } });
    if (builder && recovery) await tx.builders.records.patch(builder.uid, { home: { homeCheckpoint: recovery } });
  });
}

export function computerDiskObservationDue(previous: unknown, next: GatewayVmDiskObservation): boolean {
  if (!isGatewayVmDiskObservation(previous) || previous.instanceId !== next.instanceId) return true;
  if (next.observedAt - previous.observedAt >= COMPUTER_DISK_OBSERVATION_REFRESH_MS) return true;
  return vmDiskFreePercent(previous) !== vmDiskFreePercent(next);
}

export async function recordComputerDiskObservation(
  store: PlatformStateRepositories,
  gatewayId: string,
  previous: unknown,
  next: GatewayVmDiskObservation,
): Promise<boolean> {
  if (!computerDiskObservationDue(previous, next)) return false;
  await store.fleetRegistry.patch(gatewayId, { vmDisk: { ...next } });
  return true;
}

export async function recordComputerPreemptionNotice(
  store: PlatformStateRepositories,
  gatewayId: string,
  notice: GatewayVmPreemptionNotice,
): Promise<void> {
  await store.fleetRegistry.patch(gatewayId, { vmPreemption: { ...notice } });
}

function currentComputerRuntime(runtime: FleetRegistryRecord | null, gatewayId: string, instanceId: string): runtime is FleetRegistryRecord {
  return runtime !== null && runtime.gatewayId === gatewayId && runtime.runtime === "gce-vm" && runtime.vm?.instanceId === instanceId;
}

export async function recordComputerImageObservation(
  store: PlatformStateStore,
  gatewayId: string,
  next: GatewayVmImageObservation,
): Promise<void> {
  await store.transaction({ label: "computer-runtime.image-observation" }, async (tx) => {
    const runtime = await tx.fleetRegistry.get(gatewayId);
    if (!currentComputerRuntime(runtime, gatewayId, next.instanceId)) return;
    const previous = runtime.vmImages as Partial<GatewayVmImageObservation> | undefined;
    if (typeof previous?.observedAt === "number" && previous.instanceId === next.instanceId && previous.observedAt > next.observedAt) return;
    await tx.fleetRegistry.patch(gatewayId, { vmImages: { ...next } });
  });
}

export async function recordComputerBootRecovery(
  store: PlatformStateStore,
  gatewayId: string,
  next: GatewayVmBootRecoverySample & { instanceId: string; observedAt: number },
): Promise<void> {
  await store.transaction({ label: "computer-runtime.boot-recovery" }, async (tx) => {
    const runtime = await tx.fleetRegistry.get(gatewayId);
    if (!currentComputerRuntime(runtime, gatewayId, next.instanceId)) return;
    const previousObservedAt = runtime.vmBootRecovery?.observedAt;
    if (typeof previousObservedAt === "number" && previousObservedAt > next.observedAt) return;
    await tx.fleetRegistry.patch(gatewayId, { vmBootRecovery: { ...next } });
  });
}
