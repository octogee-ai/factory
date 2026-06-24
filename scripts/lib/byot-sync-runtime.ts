import * as path from "path";
import {
  applyByotState,
  byosCoachConfigPatch,
  coachFullAgentList,
  deriveDesiredByotState,
  type ByotInput,
} from "./byot-sync.js";
import { createGatewayRpc, OpenclawWireError } from "./gateway-rpc.js";
import { internalFetch } from "./internal-fetch.js";
import { isOauthProvider } from "./byot-multi-provider-config.js";
import { restoreByosubForAgents, type ByosubRef } from "./byosub-restore.js";
import { applyConfigPatch } from "./apply-config-patch.js";
import { OPENCLAW_DIR, isOperatorGateway, log, usesLlmBrokerToken } from "./config.js";

// byot-sync fires at pod boot, before openclaw is listening on :18789, so the
// coach-model patch must wait for the runtime to finish booting (ECONNREFUSED)
// rather than burn a fixed 3-shot budget. Deadline-bounded (matches the
// coach-attach verify's runtime-readiness budget); permanent errors still fail
// fast inside applyConfigPatch.
const BYOT_RUNTIME_BOOT_PATIENCE_MS = 120_000;

export async function applyCoachModelPatch(
  input: ByotInput | null,
  deps?: {
    applyConfigPatch?: typeof applyConfigPatch;
    logFn?: (m: string) => void;
    isOperatorGateway?: () => boolean;
  },
): Promise<boolean> {
  const logFn = deps?.logFn ?? log;
  const isOp = deps?.isOperatorGateway ?? isOperatorGateway;
  if (isOp()) return false;
  if (!input) return false;
  const patch = byosCoachConfigPatch(input);
  if (!patch) return false;
  const { id: agentId, model } = patch.agents.list[0];
  const applyConfigPatchFn = deps?.applyConfigPatch ?? applyConfigPatch;
  // Ship the FULL agents.list (coach model updated, siblings preserved verbatim)
  // WITH replacePaths:["agents.list"]. On a multi-agent gateway an id-less base
  // agent disables id-keyed merge for agents.list, so the destructive-array guard
  // falls back to arrayPreservesBaseEntries — a deep-equal base↔merged check that
  // flags the coach entry we just re-modeled as "removed" even though no entry is
  // dropped. replacePaths confirms the wholesale replacement (the load-bearing
  // half of the prod adapter's full-list pattern). Rebuilt per attempt against the
  // freshly-fetched config (hash-mismatch safe; see coachFullAgentList).
  const buildPatch = (current: unknown) => ({
    ...patch,
    agents: { ...patch.agents, list: coachFullAgentList(current, agentId, model) },
  });
  try {
    await applyConfigPatchFn(
      {
        buildPatch,
        buildReplacePaths: () => ["agents.list"],
        logPrefix: `[byot-sync:${input.slug}]`,
      },
      { maxRetries: Number.POSITIVE_INFINITY, totalDeadlineMs: BYOT_RUNTIME_BOOT_PATIENCE_MS },
    );
    logFn(`[byot-sync] ${input.slug}: coach model → ${model}`);
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

export interface ByosubCred {
  provider: string;
  secretName: string;
  credential: string;
}

// Cattle gateways are egress-blocked from the GCP metadata server, so they
// cannot read Firestore (the byosub ref) or Secret Manager (the credential)
// directly. octogee-api brokers both — KSA-tenant-bound to this gateway and
// scoped to its own glmGateways.byosub. internalFetch attaches the projected
// octogee-api KSA token the broker authorizes on.
function byokBrokerBaseUrl(): string {
  const configured = process.env.FLEET_BROKER_URL || process.env.OCTOGEE_API_URL;
  if (configured) {
    let base = configured;
    while (base.endsWith("/")) base = base.slice(0, -1);
    return base;
  }
  const ns = process.env.K8S_NAMESPACE ?? "octogee";
  return `http://octogee-api.${ns}.svc.cluster.local:3001`;
}

export async function brokerFetchByosubCred(agentId: string): Promise<ByosubCred | null> {
  const r = await internalFetch(`${byokBrokerBaseUrl()}/internal/byok/byosub-cred`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ agentId }),
  });
  if (r.status === 404) return null;
  if (!r.ok) {
    const body = (await r.text().catch(() => "")).slice(0, 200);
    throw new Error(`byosub-cred ${r.status} ${body}`);
  }
  const data = (await r.json()) as Partial<ByosubCred>;
  if (
    typeof data.provider !== "string" ||
    typeof data.secretName !== "string" ||
    typeof data.credential !== "string"
  ) {
    throw new Error("byosub-cred: malformed broker response");
  }
  return { provider: data.provider, secretName: data.secretName, credential: data.credential };
}

export async function restoreOauthStoreForSlug(
  slug: string,
  deps?: {
    fetchByosubCred?: (agentId: string) => Promise<ByosubCred | null>;
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
    const fetchByosubCred = deps?.fetchByosubCred ?? brokerFetchByosubCred;
    const ocDir = deps?.openclawDir ?? OPENCLAW_DIR;
    const cred = await fetchByosubCred(agentId);
    if (!cred) return { restored: false, present: false };
    const byosub: Record<string, ByosubRef> = {
      [agentId]: { provider: cred.provider as ByosubRef["provider"], secretName: cred.secretName },
    };
    const r = await restoreByosubForAgents({
      agentIds: [agentId],
      byosub,
      openclawDir: ocDir,
      fetchSecret: async () => cred.credential,
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
  usesLlmBrokerToken?: () => boolean;
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
  const usesBrokerToken = deps?.usesLlmBrokerToken ?? usesLlmBrokerToken;

  const applyByotStateFn = deps?.applyByotState ?? applyByotState;
  const restoreOauthFn = deps?.restoreOauthStoreForSlug ?? restoreOauthStoreForSlug;
  const applyCoachModelPatchFn = deps?.applyCoachModelPatch ?? applyCoachModelPatch;
  const triggerSecretsReloadFn = deps?.triggerSecretsReload ?? triggerSecretsReload;

  const desired = deriveDesiredByotState(userData);
  const slug = userData.username;
  if (!slug) return;

  if (
    usesBrokerToken() &&
    (!desired.input || desired.input.provider === "anthropic")
  ) {
    const changed = applyByotStateFn(slug, null);
    if (desired.input?.provider === "anthropic") {
      log(
        `[byot-sync] ${slug}: anthropic BYOT is broker-resolved; local provider-key refs removed`,
      );
    }
    if (changed) await triggerSecretsReloadFn();
    return;
  }

  if (isOp()) return;

  const changed = applyByotStateFn(slug, desired.input);

  const provider = desired.input?.provider;
  const isOauth = Boolean(provider && isOauthProvider(provider));
  const restore = isOauth ? await restoreOauthFn(slug) : null;

  // OAuth subscriptions (codex / claude-cli) would pin the coach to a
  // credential-less harness if patched before the credential materializes — a
  // missing byosub ref or a transient Secret Manager read leaves the coach
  // broken with no platform-key fallback. Only patch when the credential is
  // present (restored now or healthy on disk); otherwise leave the coach on the
  // platform key and let a later sync complete the swap.
  const credentialPresent = !isOauth || restore!.present;
  const patched = credentialPresent
    ? await applyCoachModelPatchFn(desired.input)
    : false;

  if (changed || restore?.restored || patched) await triggerSecretsReloadFn();
}
