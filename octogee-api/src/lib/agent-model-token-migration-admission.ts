import type { Firestore } from "firebase-admin/firestore";

import { hasRunningOutboundMigrationForUid } from "@octogee/core/assigned-roster";

function readPath(data: Record<string, unknown>, dotted: string): unknown {
  let value: unknown = data;
  for (const segment of dotted.split(".")) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    value = (value as Record<string, unknown>)[segment];
  }
  return value;
}

function userCarriesAgentId(data: Record<string, unknown>, agentId: string): boolean {
  if (readPath(data, "provisioning.openclaw.agentId") === agentId) return true;
  const agentIds = readPath(data, "provisioning.openclaw.agentIds");
  return Array.isArray(agentIds) && agentIds.includes(agentId);
}

export async function findRunningOutboundMigrationUserByAgentId(
  db: Firestore,
  gatewayId: string,
  agentId: string,
): Promise<{ uid: string; data: Record<string, unknown> } | null> {
  const candidates = new Map<string, Record<string, unknown>>();
  for (const query of [
    db.collection("users").where("provisioning.openclaw.agentId", "==", agentId).limit(10),
    db
      .collection("users")
      .where("provisioning.openclaw.agentIds", "array-contains", agentId)
      .limit(10),
  ]) {
    const snapshot = await query.get();
    for (const doc of snapshot.docs) {
      const data = doc.data() as Record<string, unknown> | undefined;
      if (data && userCarriesAgentId(data, agentId)) candidates.set(doc.id, data);
    }
  }
  for (const [uid, data] of candidates) {
    if (await hasRunningOutboundMigrationForUid(db, gatewayId, uid)) return { uid, data };
  }
  return null;
}
