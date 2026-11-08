import type { QueryDocumentSnapshot } from "firebase-admin/firestore";
import type { FleetInformer } from "../../fleet-informer.js";

export function stubInformer(overrides: Partial<FleetInformer> = {}): FleetInformer {
  return {
    gateways: () => null,
    fleetRegistry: () => null,
    fleetRegistryWithoutMalformed: () => null,
    users: () => null,
    assignments: () => null,
    subscribe: () => () => undefined,
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
