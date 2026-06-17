import * as path from "path";
import {
  applyByotState,
  byosCoachConfigPatch,
  deriveDesiredByotState,
  isShellRuntimeProvider,
  type ByotInput,
} from "./byot-sync.js";
import { createGatewayRpc, OpenclawWireError } from "./gateway-rpc.js";
import { isOauthProvider } from "./byot-multi-provider-config.js";
import { restoreByosubForAgents, type ByosubRef } from "./byosub-restore.js";
import { applyConfigPatch } from "./apply-config-patch.js";
import { OPENCLAW_DIR, isOperatorGateway, log } from "./config.js";

// byot-sync fires at pod boot, before openclaw is listening on :18789, so the
// coach-model patch must wait for the runtime to finish booting (ECONNREFUSED)
// rather than burn a fixed 3-shot budget. Deadline-bounded (matches the
// coach-attach verify's runtime-readiness budget); permanent errors still fail
// fast inside applyConfigPatch.
const BYOT_RUNTIME_BOOT_PATIENCE_MS = 120_000;

export async function applyCoachModelPatch(
  input: ByotInput | null,
  deps?: {
    applyPatch?: (patch: object) => Promise<void>;
    applyConfigPatch?: typeof applyConfigPatch;
    logFn?: (m: string) => void;
    isOperatorGateway?: () => boolean;
  },
): Promise<boolean> {
  const logFn = deps?.logFn ?? log;
  const isOp = deps?.isOperatorGateway ?? isOperatorGateway;
  if (isOp()) return false;
  if (!input) return false;
  if (isShellRuntimeProvider(input.provider)) {
    logFn(
      `[byot-sync] ${input.slug}: ${input.provider} requires a private exec gateway; skipping standard gateway runtime patch`,
    );
    return false;
  }
  const patch = byosCoachConfigPatch(input);
  if (!patch) return false;
  const applyConfigPatchFn = deps?.applyConfigPatch ?? applyConfigPatch;
  const applyPatch =
    deps?.applyPatch ??
    (async (p: object) => {
      await applyConfigPatchFn(
        { buildPatch: () => p, logPrefix: `[byot-sync:${input.slug}]` },
        { maxRetries: Number.POSITIVE_INFINITY, totalDeadlineMs: BYOT_RUNTIME_BOOT_PATIENCE_MS },
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
    allowLegacyGatewayTokenFallback: true,
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

export interface OauthStoreRestoreResult {
  restored: boolean;
  present: boolean;
}

export function markerProviderForSlot(
  byosub: Record<string, ByosubRef> | undefined,
  agentId: string,
): "claude-cli" | "openai-codex" {
  return byosub?.[agentId]?.provider === "anthropic" ? "claude-cli" : "openai-codex";
}

export async function restoreOauthStoreForSlug(
  slug: string,
  deps?: {
    fetchGlmByosub?: () => Promise<Record<string, ByosubRef> | undefined>;
    fetchSecret?: (name: string) => Promise<string>;
    openclawDir?: string;
    logFn?: (m: string) => void;
    isOperatorGateway?: () => boolean;
  },
): Promise<OauthStoreRestoreResult> {
  const agentId = `octogee-${slug}-coach`;
  const logFn = deps?.logFn ?? log;
  const isOp = deps?.isOperatorGateway ?? isOperatorGateway;
  if (isOp()) return { restored: false, present: false };
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
    const byosub = await fetchGlmByosub();
    const r = await restoreByosubForAgents({
      agentIds: [agentId],
      byosub,
      openclawDir: ocDir,
      fetchSecret,
      logFn,
    });

if (r.restored > 0) {
      // The byosub slot maps to the PROVIDERS-registry oauth provider so the
      // marker/log reflect the real subscription (marker-only for oauth, but the
      // label must be honest).
      const provider = markerProviderForSlot(byosub, agentId);
      applyByotState(slug, { slug, provider }, path.join(ocDir, "agents"));
    }

return { restored: r.restored > 0, present: r.restored > 0 || r.skipped > 0 };
  } catch (e) {
    logFn(`⚠ [byot-sync] oauth-store restore failed for ${slug}: ${(e as Error).message}`);
    return { restored: false, present: false };
  }
}

export interface SyncByotForCustomerDeps {
  isOperatorGateway?: () => boolean;
  applyByotState?: typeof applyByotState;
  restoreOauthStoreForSlug?: typeof restoreOauthStoreForSlug;
  applyCoachModelPatch?: typeof applyCoachModelPatch;
  triggerSecretsReload?: typeof triggerSecretsReload;
}

export async function syncByotForCustomer(
  userData: {
    byotActive?: boolean;
    username?: string;
    provisioning?: { openclaw?: { status?: string } };
    systemConfig?: { byot?: { provider?: string; baseUrl?: string; model?: string } };
  },
  deps?: SyncByotForCustomerDeps,
): Promise<void> {
  const isOp = deps?.isOperatorGateway ?? isOperatorGateway;
  if (isOp()) return;

  const applyByotStateFn = deps?.applyByotState ?? applyByotState;
  const restoreOauthFn = deps?.restoreOauthStoreForSlug ?? restoreOauthStoreForSlug;
  const applyCoachModelPatchFn = deps?.applyCoachModelPatch ?? applyCoachModelPatch;
  const triggerSecretsReloadFn = deps?.triggerSecretsReload ?? triggerSecretsReload;

  const desired = deriveDesiredByotState(userData);
  const slug = userData.username;
  if (!slug) return;

  if (desired.input && isShellRuntimeProvider(desired.input.provider)) {
    const changed = applyByotStateFn(slug, null);
    log(
      `[byot-sync] ${slug}: ${desired.input.provider} requires a private exec gateway; leaving standard gateway on native providers`,
    );
    if (changed) await triggerSecretsReloadFn();
    return;
  }

  const changed = applyByotStateFn(slug, desired.input);

  const provider = desired.input?.provider;
  const restored =
    provider && isOauthProvider(provider)
      ? (await restoreOauthFn(slug)).restored
      : false;

  const patched = await applyCoachModelPatchFn(desired.input);

  if (changed || restored || patched) await triggerSecretsReloadFn();
}
