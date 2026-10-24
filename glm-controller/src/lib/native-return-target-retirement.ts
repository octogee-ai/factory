import type { Firestore } from "firebase-admin/firestore";
import { isRetiredSharedGateway } from "./customer-ops/retired-shared-gateway.js";

export function createNativeReturnTargetRetirementVerifier(input: {
  db: Firestore;
  runtimeAbsent(gatewayId: string): Promise<boolean>;
  credentialsRetired(gatewayId: string, assertCurrent: () => Promise<void>): Promise<boolean>;
}) {
  return async (gatewayId: string, assertCurrent: () => Promise<void>): Promise<boolean> => {
    await assertCurrent();
    if (!await isRetiredSharedGateway(input.db, gatewayId, input.runtimeAbsent)) return false;
    await assertCurrent();
    if (!await input.credentialsRetired(gatewayId, assertCurrent)) return false;
    await assertCurrent();
    return isRetiredSharedGateway(input.db, gatewayId, input.runtimeAbsent);
  };
}
