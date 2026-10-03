import type { Firestore } from "firebase-admin/firestore";
import { GLM_GATEWAYS_COLLECTION, isGatewayVmEgressState, type GatewayVmEgressState } from "@octogee/shared/types/glm";

export type ComputerEgressRecord =
  | { kind: "missing" }
  | { kind: "absent" }
  | { kind: "malformed"; stored: unknown }
  | { kind: "stored"; egress: GatewayVmEgressState };

export async function readComputerEgress(db: Pick<Firestore, "doc">, gatewayId: string): Promise<ComputerEgressRecord> {
  const snap = await db.doc(`${GLM_GATEWAYS_COLLECTION}/${gatewayId}`).get();
  if (!snap.exists) return { kind: "missing" };
  const stored = snap.data()?.vmEgress;
  if (stored === undefined) return { kind: "absent" };
  return isGatewayVmEgressState(stored) ? { kind: "stored", egress: stored } : { kind: "malformed", stored };
}

const FIRESTORE_NOT_FOUND = 5;

export async function recordComputerEgress(db: Pick<Firestore, "doc">, gatewayId: string, egress: GatewayVmEgressState): Promise<"recorded" | "missing"> {
  try {
    await db.doc(`${GLM_GATEWAYS_COLLECTION}/${gatewayId}`).update({ vmEgress: egress });
    return "recorded";
  } catch (error) {
    if ((error as { code?: unknown } | null)?.code === FIRESTORE_NOT_FOUND) return "missing";
    throw error;
  }
}
