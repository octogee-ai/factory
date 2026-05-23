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
  if (!patch) return false; 
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

export interface OauthStoreRestoreResult {
  restored: boolean;
  present: boolean;
}

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

if (r.restored > 0) {
      applyByotState(
        slug,
        { slug, provider: "openai-codex" },
        path.join(ocDir, "agents"),
      );
    }

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

const provider = desired.input?.provider;
  const restored =
    provider && isOauthProvider(provider)
      ? (await restoreOauthStoreForSlug(slug)).restored
      : false;

const patched = await applyCoachModelPatch(desired.input);

  if (changed || restored || patched) await triggerSecretsReload();
}
