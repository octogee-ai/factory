import * as path from "path";
import { applyByotState, deriveDesiredByotState } from "./byot-sync.js";
import { createGatewayRpc, OpenclawWireError } from "./gateway-rpc.js";
import { isOauthProvider } from "./byot-multi-provider-config.js";
import { restoreByosubForAgents, type ByosubRef } from "./byosub-restore.js";
import { OPENCLAW_DIR, log } from "./config.js";

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
      err instanceof OpenclawWireError
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
 * Materialize an oauth provider's per-agent credential store (the file
 * codex reads) for a single mounted customer — the post-boot analog of
 * pre-boot's restore, reusing the SAME `restoreByosubForAgents`. api_key
 * providers need none of this (openclaw exec-resolves the SecretRef).
 * Deps injected for tests; production lazily wires Firestore + Secret
 * Manager (same pattern as pre-boot). Never throws.
 */
export async function restoreOauthStoreForSlug(
  slug: string,
  deps?: {
    fetchGlmByosub?: () => Promise<Record<string, ByosubRef> | undefined>;
    fetchSecret?: (name: string) => Promise<string>;
    openclawDir?: string;
    logFn?: (m: string) => void;
  },
): Promise<boolean> {
  const agentId = `octogee-${slug}-coach`;
  const logFn = deps?.logFn ?? log;
  try {
    const fetchGlmByosub =
      deps?.fetchGlmByosub ??
      (async () => {
        const gatewayId = process.env.GATEWAY_ID;
        if (!gatewayId) return undefined;
        const { db } = await import("./firebase.js");
        const snap = await db.collection("glmGateways").doc(gatewayId).get();
        return snap.exists
          ? (snap.data() as { byosub?: Record<string, ByosubRef> } | undefined)?.byosub
          : undefined;
      });
    const fetchSecret =
      deps?.fetchSecret ??
      (async (name: string) => {
        const { readSecret } = await import("./secret-manager.js");
        return readSecret(name);
      });
    const ocDir = deps?.openclawDir ?? OPENCLAW_DIR;
    const r = await restoreByosubForAgents({
      agentIds: [agentId],
      byosub: await fetchGlmByosub(),
      openclawDir: ocDir,
      fetchSecret,
      logFn,
    });
    // Converge activation from the DURABLE glmGateways.byosub ref, not
    // the user-doc signal. Gate on r.restored (the auth.json is freshly
    // on disk THIS run) — NOT r.planned: flipping routing to codex while
    // the codex-home is absent (e.g. a transient Secret Manager failure,
    // restored=0/failed>0) would break the agent. On a failed restore we
    // simply don't activate; the next mount retries. Write auth-profiles
    // under the SAME agents base as the restored codex-home.
    if (r.restored > 0) {
      applyByotState(
        slug,
        { slug, provider: "openai-codex" },
        path.join(ocDir, "agents"),
      );
    }
    return r.restored > 0;
  } catch (e) {
    logFn(`⚠ [byot-sync] oauth-store restore failed for ${slug}: ${(e as Error).message}`);
    return false;
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

  // oauth providers also need their per-agent credential store on disk
  // (the post-boot-mount restore gap); api_key is exec-resolved by openclaw.
  const provider = desired.input?.provider;
  const restored =
    provider && isOauthProvider(provider)
      ? await restoreOauthStoreForSlug(slug)
      : false;

  if (changed || restored) await triggerSecretsReload();
}
