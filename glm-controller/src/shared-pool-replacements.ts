import type { PlatformStateRepositories } from "@octogee/core/platform-state";
import { parseSharedPoolReplacements, type SharedPoolReplacement } from "@octogee/shared/types/shared-gateway-pool";

export { parseSharedPoolReplacements };

export async function readSharedPoolReplacements(
  repositories: Pick<PlatformStateRepositories, "controllerState">,
): Promise<SharedPoolReplacement[]> {
  const state = await repositories.controllerState.sharedPoolScaler.get();
  return [...(state?.replacements ?? [])];
}

export function pairedReplacementTarget(
  replacements: readonly SharedPoolReplacement[],
  sourceGatewayId: string,
): string | null {
  return replacements.find((replacement) => replacement.sourceGatewayId === sourceGatewayId)?.targetGatewayId ?? null;
}
