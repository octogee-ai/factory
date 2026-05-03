import { applyByotState, deriveDesiredByotState } from "./byot-sync.js";
import { createGatewayRpc, GatewayRpcError } from "./gateway-rpc.js";
import { log } from "./config.js";

export async function triggerSecretsReload(): Promise<void> {
  const rpc = createGatewayRpc({
    connectTimeoutMs: 10_000,
    callTimeoutMs: 10_000,
  });
  try {
    const result = await rpc.secretsReload();
    const warnings = Number(result.warningCount ?? 0);
    if (warnings > 0) {
      log(`[byot-sync] secrets reload ok — ${warnings} warning(s)`);
    } else {
      log("[byot-sync] secrets reload ok");
    }
  } catch (err) {
    const detail =
      err instanceof GatewayRpcError
        ? `${err.code}: ${err.message}`
        : err instanceof Error
          ? err.message
          : String(err);
    log(`⚠ [byot-sync] secrets reload failed: ${detail}`);
  } finally {
    await rpc.close();
  }
}

export async function syncByotForCustomer(userData: {
  byotActive?: boolean;
  username?: string;
  provisioning?: { openclaw?: { status?: string } };
  systemConfig?: { byot?: { provider?: string; baseUrl?: string; model?: string } };
}): Promise<void> {
  const desired = deriveDesiredByotState(userData);
  const slug = userData.username;
  if (!slug) return;

  const changed = applyByotState(slug, desired.input);
  if (changed) await triggerSecretsReload();
}
