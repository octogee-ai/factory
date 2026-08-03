import type { QueryDocumentSnapshot } from "firebase-admin/firestore";
import type { FleetInformer } from "../../fleet-informer.js";

/** Every mirror cold by default — override only the ones a case warms. */
export function stubInformer(overrides: Partial<FleetInformer> = {}): FleetInformer {
  return {
    gateways: () => null,
    glmGateways: () => null,
    users: () => null,
    assignments: () => null,
    ingestGateways: () => undefined,
    ingestGlmGateways: () => undefined,
    markGatewaysStale: () => undefined,
    markGlmGatewaysStale: () => undefined,
    stop: () => undefined,
    ...overrides,
  };
}

export function mirrorDoc(
  id: string,
  data: Record<string, unknown>,
): QueryDocumentSnapshot {
  return { id, data: () => data, ref: { id } } as unknown as QueryDocumentSnapshot;
}
