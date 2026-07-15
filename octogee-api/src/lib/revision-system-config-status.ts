import { FieldValue, type Firestore } from "firebase-admin/firestore";

import { GLM_GATEWAYS_COLLECTION } from "@octogee/shared/types/glm";

export async function recordRevisionSystemConfigStatus(
  db: Firestore,
  input: {
    gatewayId: string;
    revisionId: string;
    status: Record<string, unknown>;
  },
): Promise<boolean> {
  const revisionRef = db.collection(GLM_GATEWAYS_COLLECTION).doc(input.revisionId);
  return db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(revisionRef);
    const data = snapshot.data();
    if (
      !snapshot.exists ||
      data?.docKind !== "revision" ||
      data.gateway !== input.gatewayId ||
      data.revisionId !== input.revisionId
    ) {
      return false;
    }
    transaction.update(revisionRef, {
      "heartbeat.configStatus": {
        ...input.status,
        observedAt: FieldValue.serverTimestamp(),
      },
    });
    return true;
  });
}
