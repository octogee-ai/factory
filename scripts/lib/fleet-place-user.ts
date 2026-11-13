import { commitOperatorPlacement } from "@octogee/core/operator-placement";
import type { PlatformStateStore } from "@octogee/core/platform-state";

export type AddUserPlacementOutcome = "placed" | "repaired" | "unchanged";

export async function commitAddUserPlacement(
  store: PlatformStateStore,
  input: { uid: string; gatewayId: string; now: number },
): Promise<AddUserPlacementOutcome> {
  const outcome = await commitOperatorPlacement(store, { ...input, source: "repair" });
  if (outcome.kind === "refused") throw new Error(outcome.message);
  return outcome.kind;
}
