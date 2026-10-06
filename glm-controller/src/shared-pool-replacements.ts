import type { DocumentSnapshot, Firestore, Transaction } from "firebase-admin/firestore";
import { parseSharedPoolReplacements, type SharedPoolReplacement } from "@octogee/shared/types/shared-gateway-pool";

export { parseSharedPoolReplacements };

export const SHARED_POOL_SCALER_STATE_DOC_PATH = "glmControllerState/sharedPoolScaler";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function parseSharedPoolReplacementsFromState(snapshot: DocumentSnapshot): SharedPoolReplacement[] {
  if (!snapshot.exists) return [];
  const data = snapshot.data();
  if (!isRecord(data)) throw new Error("shared pool scaler state is malformed");
  return parseSharedPoolReplacements(data.replacements);
}

export async function readSharedPoolReplacements(
  db: Firestore,
  transaction?: Transaction,
): Promise<SharedPoolReplacement[]> {
  const reference = db.doc(SHARED_POOL_SCALER_STATE_DOC_PATH);
  const snapshot = transaction ? await transaction.get(reference) : await reference.get();
  return parseSharedPoolReplacementsFromState(snapshot);
}

export function pairedReplacementTarget(
  replacements: readonly SharedPoolReplacement[],
  sourceGatewayId: string,
): string | null {
  return replacements.find((replacement) => replacement.sourceGatewayId === sourceGatewayId)?.targetGatewayId ?? null;
}
