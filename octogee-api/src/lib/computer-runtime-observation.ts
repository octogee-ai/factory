import type { Firestore, Transaction, DocumentData } from "firebase-admin/firestore";
import {
  GLM_GATEWAYS_COLLECTION,
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

type CheckpointOwner = { uid: string; instanceId: string };

function runtimeCheckpointMatches(data: DocumentData | undefined, owner: CheckpointOwner): boolean {
  return data?.runtime === "gce-vm" && data?.vm?.instanceId === owner.instanceId;
}

async function checkpointOwnerAuthority(tx: Transaction, db: Pick<Firestore, "doc">, gatewayId: string, owner?: CheckpointOwner) {
  if (!owner) return { userRef: null, userData: undefined };
  const userRef = db.doc(`users/${owner.uid}`);
  const user = await tx.get(userRef);
  const gateway = await tx.get(db.doc(`gateways/${gatewayId}`));
  if (!user.exists || gateway.data()?.ownerUid !== owner.uid) throw new Error("computer checkpoint owner changed before acceptance");
  return { userRef, userData: user.data() };
}

function checkpointObservationAdvances(previous: Partial<GatewayVmHomeState> | undefined, home: Partial<GatewayVmHomeState>, incoming: GatewayVmHomeCheckpoint): boolean {
  const previousName = previous?.lastCheckpoint?.name;
  if (previousName && previousName > incoming.name) return false;
  return previousName !== incoming.name || (previous?.checkpointAcknowledgedAt ?? -1) < (home.checkpointAcknowledgedAt ?? -1);
}

function nextHomeRecovery(userData: DocumentData | undefined, incoming: GatewayVmHomeCheckpoint): GatewayVmHomeCheckpoint | null {
  if (!isDisposableHomeCheckpoint(incoming)) return null;
  const recovery = userData?.provisioning?.homeCheckpoint;
  if (recovery === undefined) return incoming;
  if (!isDisposableHomeCheckpoint(recovery)) throw new Error("Builder home recovery checkpoint is malformed");
  return recovery.name <= incoming.name ? incoming : null;
}

export async function recordComputerHomeCheckpoint(db: Pick<Firestore, "doc" | "runTransaction">, gatewayId: string, home: Partial<GatewayVmHomeState>, owner?: CheckpointOwner): Promise<void> {
  const incoming = home.lastCheckpoint;
  if (!incoming) throw new Error("cannot record an empty computer checkpoint");
  const ref = db.doc(`${GLM_GATEWAYS_COLLECTION}/${gatewayId}`);
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return;
    if (owner && !runtimeCheckpointMatches(snap.data(), owner)) throw new Error("computer checkpoint binding changed before acceptance");
    const { userRef, userData } = await checkpointOwnerAuthority(tx, db, gatewayId, owner);
    if (!checkpointObservationAdvances(snap.data()?.vmHome, home, incoming)) return;
    const recovery = userRef ? nextHomeRecovery(userData, incoming) : null;
    tx.set(ref, { vmHome: home }, { merge: true });
    if (userRef && recovery) tx.set(userRef, { provisioning: { homeCheckpoint: recovery } }, { merge: true });
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

export async function recordComputerBootRecovery(
  db: Pick<Firestore, "doc" | "runTransaction">,
  gatewayId: string,
  next: GatewayVmBootRecoverySample & { instanceId: string; observedAt: number },
): Promise<void> {
  const ref = db.doc(`${GLM_GATEWAYS_COLLECTION}/${gatewayId}`);
  await db.runTransaction(async tx => {
    const snap = await tx.get(ref);
    const data = snap.data();
    if (!snap.exists || data?.gatewayId !== gatewayId || data.runtime !== "gce-vm" || data.vm?.instanceId !== next.instanceId) return;
    if (data.vmBootRecovery?.observedAt > next.observedAt) return;
    tx.set(ref, { vmBootRecovery: next }, { merge: true });
  });
}
