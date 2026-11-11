import { DEFAULT_OPENCLAW_DIR, readUserClaim } from "@octogee/shared/server/user-claim";
import type { ConfiguredUserReport } from "../../shared/types/fleet-controller.js";

export function configuredUserReport(env: NodeJS.ProcessEnv = process.env): ConfiguredUserReport | null {
  if (env.GATEWAY_CLASS !== "builder") return null;
  const claim = readUserClaim(env.OPENCLAW_DIR?.trim() || DEFAULT_OPENCLAW_DIR, env.GATEWAY_ID?.trim() || undefined);
  return claim ? { state: "claimed", generation: claim.generation } : null;
}
