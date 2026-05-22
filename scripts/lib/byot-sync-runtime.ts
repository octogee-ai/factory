import * as path from "path";
import {
  applyByotState,
  byosCoachConfigPatch,
  deriveDesiredByotState,
  type ByotInput,
} from "./byot-sync.js";
import { createGatewayRpc, OpenclawWireError } from "./gateway-rpc.js";
import { isOauthProvider } from "./byot-multi-provider-config.js";
import { restoreByosubForAgents, type ByosubRef } from "./byosub-restore.js";
import { applyConfigPatch } from "./apply-config-patch.js";
import { OPENCLAW_DIR, log } from "./config.js";

/**
 * Point the customer's coach agent at the model their durable BYOT/BYOS
 * state requires (#1001). The credential restore + secrets.reload alone
 * never switched the agent — only the customer-lifecycle ADD path set the
 * model, gated on a transient caller flag a BYOS Connect (on an existing
 * customer) never drives. Applying it here, from `deriveDesiredByotState`
 * on every sync, makes a Connect actually flip the agent AND re-asserts it
 * on every post-reschedule mount (the openclaw.json regen otherwise reverts
 * it to the gateway default). Best-effort: a failed patch never breaks the
 * sync — the next sync retries.
 */
export async function applyCoachModelPatch(
  input: ByotInput | null,
  deps?: {
    applyPatch?: (patch: object) => Promise<void>;
    logFn?: (m: string) => void;
  },
): Promise<boolean> {
  const logFn = deps?.logFn ?? log;
  if (!input) return false;
  const patch = byosCoachConfigPatch(input);
  if (!patch) return false; // anthropic / tool-only → keep gateway default
  const applyPatch =
    deps?.applyPatch ??
    (async (p: object) => {
      await applyConfigPatch(
        { buildPatch: () => p, logPrefix: `[byot-sync:${input.slug}]` },
        { maxRetries: 3, totalDeadlineMs: 30_000 },
      );
    });
  try {
    await applyPatch(patch);
    logFn(
      `[byot-sync] ${input.slug}: coach model → ${patch.agents.list[0].model}`,
    );
    return true;
  } catch (e) {
    logFn(
      `⚠ [byot-sync] coach-model patch failed for ${input.slug}: ${(e as Error).message}`,
    );
    return false;
  }
}

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
    let detail: string;
    if (err instanceof OpenclawWireError) {
      detail = `${err.code}: ${err.message}`;
    } else if (err instanceof Error) {
      detail = err.message;
    } else {
      detail = String(err);
    }
    log(`⚠ [byot-sync] secrets reload failed: ${detail}`);
  } finally {
    await rpc.close();
  }
}

/**
 * `restored` — a credential was freshly written to disk THIS call (cold
 *   start or a recovery signal). Gates `applyByotState` + `secrets.reload`:
 *   only a fresh write needs the routing re-asserted / the gateway reloaded.
 * `present` — a usable BYOS credential is on disk after this call: freshly
 *   restored OR a conservative-skip over a healthy on-disk cred (openclaw
 *   owns + rotates it in place). NOT set on a failed/absent restore. Drives
 *   `byosActive` on the restore-customer re-mount — so an already-provisioned
 *   BYOS customer is never clobbered back to the platform-default coach model.
 */
export interface OauthStoreRestoreResult {
  restored: boolean;
  present: boolean;
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
): Promise<OauthStoreRestoreResult> {
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
    // present = cred on disk: a fresh write OR a conservative-skip over a
    // healthy on-disk cred. A skip means BYOS IS active — the re-mount must
    // not clobber the coach model. failed/absent (restored=0, skipped=0)
    // stays not-present so we never route to codex without the cred.
    return { restored: r.restored > 0, present: r.restored > 0 || r.skipped > 0 };
  } catch (e) {
    logFn(`⚠ [byot-sync] oauth-store restore failed for ${slug}: ${(e as Error).message}`);
    return { restored: false, present: false };
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
      ? (await restoreOauthStoreForSlug(slug)).restored
      : false;

  // #1001: point the coach agent at the provider's model (codex → gpt-5.5
  // + agentRuntime:codex). Credential-on-disk + secrets.reload alone never
  // switched the agent. Driven by the durable desired state every sync.
  const patched = await applyCoachModelPatch(desired.input);

  if (changed || restored || patched) await triggerSecretsReload();
}
