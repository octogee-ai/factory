import type { FleetInformer } from "../../fleet-informer.js";

export function stubInformer(overrides: Partial<FleetInformer> = {}): FleetInformer {
  return {
    gateways: () => null,
    fleetRegistry: () => null,
    fleetRegistryWithoutMalformed: () => null,
    builders: () => null,
    buildersWithoutMalformed: () => null,
    assignments: () => null,
    subscribe: () => () => undefined,
    stop: () => undefined,
    ...overrides,
  };
}
