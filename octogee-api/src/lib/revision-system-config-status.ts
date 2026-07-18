import { FieldValue, type Firestore } from "firebase-admin/firestore";

import { isGatewayRuntimeDoc } from "@octogee/shared/types/gateway-releases";
import { GLM_GATEWAYS_COLLECTION } from "@octogee/shared/types/glm";

export async function recordRevisionSystemConfigStatus(
  db: Firestore,
  input: {
    gatewayId: string;
    revisionId: string;
    status: Record<string, unknown>;
  },
): Promise<boolean> {
  const runtimeRef = db.collection(GLM_GATEWAYS_COLLECTION).doc(input.gatewayId);
  return db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(runtimeRef);
    const data = snapshot.data();
    if (
      !snapshot.exists ||
      input.revisionId !== input.gatewayId ||
      !isGatewayRuntimeDoc(data) ||
      data.gatewayId !== input.gatewayId
    ) {
      return false;
    }
    transaction.update(runtimeRef, {
      "heartbeat.configStatus": {
        ...input.status,
        observedAt: FieldValue.serverTimestamp(),
      },
    });
    return true;
  });
}
