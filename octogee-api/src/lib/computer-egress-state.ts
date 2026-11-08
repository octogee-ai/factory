import { MissingRecordError, type PlatformStateRepositories } from "@octogee/core/platform-state";
import { isGatewayVmEgressState, type GatewayVmEgressState } from "@octogee/shared/types/glm";

export type ComputerEgressRecord =
  | { kind: "missing" }
  | { kind: "absent" }
  | { kind: "malformed"; stored: unknown }
  | { kind: "stored"; egress: GatewayVmEgressState };

export async function readComputerEgress(store: PlatformStateRepositories, gatewayId: string): Promise<ComputerEgressRecord> {
  const runtime = await store.fleetRegistry.get(gatewayId);
  if (!runtime) return { kind: "missing" };
  const stored: unknown = runtime.vmEgress;
  if (stored === undefined) return { kind: "absent" };
  return isGatewayVmEgressState(stored) ? { kind: "stored", egress: stored } : { kind: "malformed", stored };
}

export async function recordComputerEgress(store: PlatformStateRepositories, gatewayId: string, egress: GatewayVmEgressState): Promise<"recorded" | "missing"> {
  try {
    await store.fleetRegistry.patch(gatewayId, { vmEgress: egress });
    return "recorded";
  } catch (error) {
    if (error instanceof MissingRecordError) return "missing";
    throw error;
  }
}
