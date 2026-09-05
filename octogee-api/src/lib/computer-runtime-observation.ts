import type { Firestore } from "firebase-admin/firestore";
import { GLM_GATEWAYS_COLLECTION, resolveGatewayRuntime, type GatewayVmHomeState } from "@octogee/shared/types/glm";

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
