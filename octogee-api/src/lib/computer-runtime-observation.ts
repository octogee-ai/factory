import type { Firestore } from "firebase-admin/firestore";
import {
  GLM_GATEWAYS_COLLECTION,
  isGatewayVmDiskObservation,
  resolveGatewayRuntime,
  vmDiskFreePercent,
  type GatewayVmDiskObservation,
  type GatewayVmHomeState,
  type GatewayVmImageObservation,
  type GatewayVmPreemptionNotice,
} from "@octogee/shared/types/glm";

export const COMPUTER_DISK_OBSERVATION_REFRESH_MS = 10 * 60_000;

type RuntimeDb = Pick<Firestore, "collection">;

export async function findComputerRuntimeForInstance(db: RuntimeDb, instanceId: string): Promise<{ gatewayId: string; home: Partial<GatewayVmHomeState> | undefined } | null> {
  const runtimes = await db.collection(GLM_GATEWAYS_COLLECTION).where("vm.instanceId", "==", instanceId).get();
  if (runtimes.docs.length !== 1) return null;
  const runtime = runtimes.docs[0];
  const data = runtime.data();
  if (data?.gatewayId !== runtime.id || resolveGatewayRuntime(data?.runtime) !== "gce-vm") return null;
  return { gatewayId: runtime.id, home: data?.vmHome as Partial<GatewayVmHomeState> | undefined };
}

export async function readComputerRuntimeObservation(db: Pick<Firestore, "doc">, gatewayId: string): Promise<Record<string, unknown> | undefined> {
  const snap = await db.doc(`${GLM_GATEWAYS_COLLECTION}/${gatewayId}`).get();
  return snap.exists ? snap.data() : undefined;
}

export async function recordComputerHomeCheckpoint(db: Pick<Firestore, "doc" | "runTransaction">, gatewayId: string, home: Partial<GatewayVmHomeState>): Promise<void> {
  const incoming = home.lastCheckpoint;
  if (!incoming) throw new Error("cannot record an empty computer checkpoint");
  const ref = db.doc(`${GLM_GATEWAYS_COLLECTION}/${gatewayId}`);
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return;
    const previous = snap.data()?.vmHome as Partial<GatewayVmHomeState> | undefined;
    const previousName = previous?.lastCheckpoint?.name;
    if (previousName && previousName > incoming.name) return;
    if (previousName === incoming.name && (previous?.checkpointAcknowledgedAt ?? -1) >= (home.checkpointAcknowledgedAt ?? -1)) return;
    tx.set(ref, { vmHome: home }, { merge: true });
  });
}

export function computerDiskObservationDue(previous: unknown, next: GatewayVmDiskObservation): boolean {
  if (!isGatewayVmDiskObservation(previous) || previous.instanceId !== next.instanceId) return true;
  if (next.observedAt - previous.observedAt >= COMPUTER_DISK_OBSERVATION_REFRESH_MS) return true;
  return vmDiskFreePercent(previous) !== vmDiskFreePercent(next);
}

export async function recordComputerDiskObservation(
  db: Pick<Firestore, "doc">,
  gatewayId: string,
  previous: unknown,
  next: GatewayVmDiskObservation,
): Promise<boolean> {
  if (!computerDiskObservationDue(previous, next)) return false;
  await db.doc(`${GLM_GATEWAYS_COLLECTION}/${gatewayId}`).set({ vmDisk: next }, { merge: true });
  return true;
}

export async function recordComputerPreemptionNotice(
  db: Pick<Firestore, "doc">,
  gatewayId: string,
  notice: GatewayVmPreemptionNotice,
): Promise<void> {
  await db.doc(`${GLM_GATEWAYS_COLLECTION}/${gatewayId}`).set({ vmPreemption: notice }, { merge: true });
}

export async function recordComputerImageObservation(
  db: Pick<Firestore, "doc" | "runTransaction">,
  gatewayId: string,
  next: GatewayVmImageObservation,
): Promise<void> {
  const ref = db.doc(`${GLM_GATEWAYS_COLLECTION}/${gatewayId}`);
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const data = snap.data();
    if (!snap.exists || data?.gatewayId !== gatewayId || data.runtime !== "gce-vm" || data.vm?.instanceId !== next.instanceId) return;
    const previous = data.vmImages as Partial<GatewayVmImageObservation> | undefined;
    if (typeof previous?.observedAt === "number" && previous.instanceId === next.instanceId && previous.observedAt > next.observedAt) return;
    tx.set(ref, { vmImages: next }, { merge: true });
  });
}
