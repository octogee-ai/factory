/**
 * BYOT runtime hand-off — the bits of byot-sync that talk to the running
 * gateway via WS RPC. Split out from byot-sync.ts so the cross-package
 * `tests/` workspace can typecheck pure-logic specs against byot-sync
 * without dragging `ws` (gateway-rpc's runtime dep) into its transitive
 * type graph. See header of byot-sync.ts for the full rationale.
 *
 * What lives here:
 *   - triggerSecretsReload: best-effort RPC to make OpenClaw atomically
 *     swap its in-memory snapshot, picking up the auth-profiles.json
 *     that byot-sync just wrote.
 *   - syncByotForCustomer: orchestrator — calls byot-sync's
 *     applyByotState first, then triggerSecretsReload iff a file
 *     actually changed on disk.
 *
 * The provisioner (local-provisioner.ts) is the only caller for
 * syncByotForCustomer; the post-write reload is internal.
 */

import { applyByotState, deriveDesiredByotState } from "./byot-sync.js";
import { createGatewayRpc, GatewayRpcError } from "./gateway-rpc.js";
import { log } from "./config.js";

/**
 * Trigger OpenClaw's in-memory snapshot swap. Safe to call any time —
 * OpenClaw atomically keeps the last-known-good snapshot on failure.
 *
 * Implementation: opens a short-lived WS to the local gateway and calls
 * the `secrets.reload` RPC method directly via gateway-rpc. The token
 * comes from `OPENCLAW_GATEWAY_TOKEN` in env (resolved inside
 * gateway-rpc.ts) — never written to disk and never exposed via process
 * argv (no subprocess). This preserves the hardening that moved the
 * gateway token off `openclaw.json` to a runtime-only env var.
 *
 * History: previously shelled out to `openclaw secrets reload --json`,
 * which silently failed in prod with `unauthorized: token_missing`
 * because the OpenClaw CLI does not honor `OPENCLAW_GATEWAY_TOKEN` from
 * env — it requires `gateway.remote.token` in openclaw.json or `--token
 * <value>` on argv. Both regress the no-token-on-disk / no-token-in-argv
 * stance, so we use the in-process RPC client instead.
 */
export async function triggerSecretsReload(): Promise<void> {
  // Tighter timeouts than the gateway-rpc default (30s). Reload is a
  // best-effort hand-off from a Firestore watcher that can fire many
  // times in a burst; long timeouts let concurrent reloads pile up
  // against the gateway. 10s matches the old `spawnSync` budget and is
  // the same shape the rest of the byot-sync flow uses for "fast,
  // best-effort, retry on next tick if it fails."
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

/**
 * One-shot sync for a single customer — apply the desired state and
 * trigger secrets reload if anything actually changed on disk.
 *
 * Caller must pass the system/config.byot subdoc separately; the
 * provisioner's onSnapshot watcher reads it from a sibling Firestore
 * doc, not the user doc.
 */
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
