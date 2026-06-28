import * as path from "path";
import * as os from "os";
import {
  applyByotState,
  byosCoachConfigPatch,
  coachFullAgentList,
  deriveDesiredByotState,
  type CoachModelInput,
} from "./byot-sync.js";
import { createGatewayRpc, OpenclawWireError } from "./gateway-rpc.js";
import { internalFetch } from "./internal-fetch.js";
import { isModelCredentialOauthProvider } from "./model-credential-materializer.js";
import { restoreByosubForAgents, type ByosubRef } from "./byosub-restore.js";
import { applyConfigPatch } from "./apply-config-patch.js";
import {
  AGENTS_DIR,
  GATEWAY_CLASS,
  OPENCLAW_DIR,
  isOperatorGateway,
  isSharedGateway,
  log,
  usesLlmBrokerToken,
} from "./config.js";
import { upsertAnthropicBrokerProfile } from "./agent-model-token-materializer.js";

// byot-sync fires at pod boot, before openclaw is listening on :18789, so the
// coach-model patch must wait for the runtime to finish booting (ECONNREFUSED)
// rather than burn a fixed 3-shot budget. Deadline-bounded (matches the
// coach-attach verify's runtime-readiness budget); permanent errors still fail
// fast inside applyConfigPatch.
const BYOT_RUNTIME_BOOT_PATIENCE_MS = 120_000;

export async function applyCoachModelPatch(
  input: CoachModelInput | null,
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
    logFn(
      `[byot-sync] ${input.slug}: coach model → ${model.primary} (fallback ${model.fallbacks.join(", ")})`,
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

export interface ByosubCred {
  provider: string;
  secretName: string;
  credential: string;
}

function claudeCliNativeHomeDirForGateway(): string | undefined {
  return GATEWAY_CLASS === "builder" || isOperatorGateway() ? os.homedir() : undefined;
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
    claudeCliNativeHomeDir?: string;
    logFn?: (m: string) => void;
  },
): Promise<OauthStoreRestoreResult> {
  const agentId = `octogee-${slug}-coach`;
  const logFn = deps?.logFn ?? log;
  try {
    const fetchByosubCred = deps?.fetchByosubCred ?? brokerFetchByosubCred;
    const ocDir = deps?.openclawDir ?? OPENCLAW_DIR;
    const cred = await fetchByosubCred(agentId);
    if (!cred) return { restored: false, present: false };
    const byosub: Record<string, ByosubRef> = {
      [agentId]: {
        provider: cred.provider as ByosubRef["provider"],
        secretName: cred.secretName,
      },
    };
    const claudeCliNativeHomeDir =
      deps?.claudeCliNativeHomeDir ?? claudeCliNativeHomeDirForGateway();
    const r = await restoreByosubForAgents({
      agentIds: [agentId],
      byosub,
      openclawDir: ocDir,
      fetchSecret: async () => cred.credential,
      logFn,
      ...(claudeCliNativeHomeDir ? { claudeCliNativeHomeDir } : {}),
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
  isSharedGateway?: () => boolean;
  usesLlmBrokerToken?: () => boolean;
  applyByotState?: typeof applyByotState;
  restoreOauthStoreForSlug?: typeof restoreOauthStoreForSlug;
  applyCoachModelPatch?: typeof applyCoachModelPatch;
  triggerSecretsReload?: typeof triggerSecretsReload;
  materializeAnthropicBroker?: (slug: string) => boolean;
}

type DesiredByotState = ReturnType<typeof deriveDesiredByotState>;
type SyncByotUserData = Parameters<typeof deriveDesiredByotState>[0];

interface SyncByotActions {
  applyByotState: typeof applyByotState;
  restoreOauthStoreForSlug: typeof restoreOauthStoreForSlug;
  applyCoachModelPatch: typeof applyCoachModelPatch;
  triggerSecretsReload: typeof triggerSecretsReload;
  materializeAnthropicBroker: (slug: string) => boolean;
}

function materializeAnthropicBroker(slug: string): boolean {
  const agentId = `octogee-${slug}-coach`;
  return upsertAnthropicBrokerProfile(path.join(AGENTS_DIR, agentId, "agent"), agentId);
}

function syncActions(deps?: SyncByotForCustomerDeps): SyncByotActions {
  return {
    applyByotState: deps?.applyByotState ?? applyByotState,
    restoreOauthStoreForSlug: deps?.restoreOauthStoreForSlug ?? restoreOauthStoreForSlug,
    applyCoachModelPatch: deps?.applyCoachModelPatch ?? applyCoachModelPatch,
    triggerSecretsReload: deps?.triggerSecretsReload ?? triggerSecretsReload,
    materializeAnthropicBroker: deps?.materializeAnthropicBroker ?? materializeAnthropicBroker,
  };
}

function isBrokerResolvedAnthropic(
  desired: DesiredByotState,
  usesBrokerToken: boolean,
): boolean {
  return usesBrokerToken && desired.input?.provider === "anthropic";
}

async function clearBrokerResolvedAnthropic(
  slug: string,
  actions: SyncByotActions,
): Promise<void> {
  const changed = actions.applyByotState(slug, null);
  log(
    `[byot-sync] ${slug}: anthropic BYOT is broker-resolved; local provider-key refs removed`,
  );
  if (changed) await actions.triggerSecretsReload();
}

async function restoreOauthIfNeeded(
  slug: string,
  desired: DesiredByotState,
  actions: SyncByotActions,
): Promise<OauthStoreRestoreResult> {
  const provider = desired.input?.provider;
  if (!provider || !isModelCredentialOauthProvider(provider)) {
    return { restored: false, present: true };
  }
  return actions.restoreOauthStoreForSlug(slug);
}

async function syncStandardByotState(
  slug: string,
  desired: DesiredByotState,
  actions: SyncByotActions,
): Promise<void> {
  const changed = actions.applyByotState(slug, desired.input);
  const restore = await restoreOauthIfNeeded(slug, desired, actions);
  const patched = restore.present && desired.coachModelInput
    ? await actions.applyCoachModelPatch(desired.coachModelInput)
    : false;

  if (changed || restore.restored || patched) await actions.triggerSecretsReload();
}

async function syncOperatorByotState(
  slug: string,
  desired: DesiredByotState,
  actions: SyncByotActions,
): Promise<void> {
  const restore = await restoreOauthIfNeeded(slug, desired, actions);
  if (restore.restored) await actions.triggerSecretsReload();
}

// Shared (multi-tenant) pods route EACH customer-agent's anthropic through the
// broker with its own per-customer token. Unlike builder/operator (one env gateway
// token), the per-agent anthropic:default broker-token profile is the load-bearing
// credential — the primary for platform/anthropic-BYOK customers and the Haiku
// fallback for BYOS / non-anthropic-BYOK ones — so it is always (re)asserted, the
// auth-profile store is never torn down, and byosub OAuth + custom-provider
// models.json coexist alongside it.
async function syncSharedBrokerByotState(
  slug: string,
  desired: DesiredByotState,
  actions: SyncByotActions,
): Promise<void> {
  const provider = desired.input?.provider;
  const isOauth = Boolean(provider && isModelCredentialOauthProvider(provider));
  const isNonAnthropicKey = Boolean(provider && provider !== "anthropic" && !isOauth);

  const restore = isOauth
    ? await actions.restoreOauthStoreForSlug(slug)
    : { restored: false, present: true };

  const changed = actions.applyByotState(
    slug,
    isNonAnthropicKey ? desired.input : null,
    undefined,
    { preserveAuthProfileStore: true },
  );

  const materialized = actions.materializeAnthropicBroker(slug);

  const patched = desired.coachModelInput
    ? await actions.applyCoachModelPatch(desired.coachModelInput)
    : false;

  if (changed || restore.restored || materialized || patched) {
    await actions.triggerSecretsReload();
  }
}

export async function syncByotForCustomer(
  userData: SyncByotUserData,
  deps?: SyncByotForCustomerDeps,
): Promise<void> {
  const isOp = deps?.isOperatorGateway ?? isOperatorGateway;
  const isShared = deps?.isSharedGateway ?? isSharedGateway;
  const usesBrokerToken = deps?.usesLlmBrokerToken ?? usesLlmBrokerToken;
  const actions = syncActions(deps);

  const desired = deriveDesiredByotState(userData);
  const slug = userData.username;
  if (!slug) return;

  if (isShared()) {
    await syncSharedBrokerByotState(slug, desired, actions);
    return;
  }

  if (isBrokerResolvedAnthropic(desired, usesBrokerToken())) {
    await clearBrokerResolvedAnthropic(slug, actions);
    return;
  }

  if (isOp()) {
    await syncOperatorByotState(slug, desired, actions);
    return;
  }
  await syncStandardByotState(slug, desired, actions);
}
