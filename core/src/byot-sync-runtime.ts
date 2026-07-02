import * as path from "path";
import * as os from "os";
import {
  applyByotState,
  byosCoachConfigPatch,
  coachFullAgentList,
  deriveDesiredByotState,
  platformCoachModelInputForUser,
  STANDARD_CODEX_APP_SERVER,
  type CoachModelInput,
} from "./byot-sync.js";
import { createGatewayRpc, OpenclawWireError } from "./gateway-rpc.js";
import { internalFetch } from "./internal-fetch.js";
import {
  claudeCliRuntimeConfig,
  codexRuntimeConfig,
  isModelCredentialOauthProvider,
} from "./model-credential-materializer.js";
import {
  restoreByosubForAgents,
  type ByosubProvider,
  type ByosubRef,
} from "./byosub-restore.js";
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
import {
  OPENROUTER_BROKER_PROVIDER_ID,
  openRouterBrokerProviderConfig,
  upsertAnthropicBrokerProfile,
} from "./agent-model-token-materializer.js";

// byot-sync fires at pod boot, before openclaw is listening on :18789, so the
// coach-model patch must wait for the runtime to finish booting (ECONNREFUSED)
// rather than burn a fixed 3-shot budget. Deadline-bounded (matches the
// coach-attach verify's runtime-readiness budget); permanent errors still fail
// fast inside applyConfigPatch.
const BYOT_RUNTIME_BOOT_PATIENCE_MS = 120_000;

function currentCodexAppServerConfig(current: unknown): typeof STANDARD_CODEX_APP_SERVER {
  const appServer = (current as {
    plugins?: {
      entries?: {
        codex?: {
          config?: {
            appServer?: {
              sandbox?: unknown;
              approvalPolicy?: unknown;
            };
          };
        };
      };
    };
  } | null | undefined)?.plugins?.entries?.codex?.config?.appServer;
  return {
    sandbox:
      typeof appServer?.sandbox === "string"
        ? appServer.sandbox
        : STANDARD_CODEX_APP_SERVER.sandbox,
    approvalPolicy:
      typeof appServer?.approvalPolicy === "string"
        ? appServer.approvalPolicy
        : STANDARD_CODEX_APP_SERVER.approvalPolicy,
  };
}

export async function applyCoachModelPatch(
  input: CoachModelInput | null,
  deps?: {
    applyConfigPatch?: typeof applyConfigPatch;
    logFn?: (m: string) => void;
    isOperatorGateway?: () => boolean;
  },
): Promise<boolean> {
  const logFn = deps?.logFn ?? log;
  if (!input) return false;
  const patch = byosCoachConfigPatch(input);
  if (!patch) return false;
  const { id: agentId, model } = patch.agents.list[0];
  const modelPrimary = typeof model === "string" ? model : model.primary;
  const modelFallbacks = typeof model === "string" ? [] : model.fallbacks;
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
      `[byot-sync] ${input.slug}: coach model → ${modelPrimary}${
        modelFallbacks.length ? ` (fallback ${modelFallbacks.join(", ")})` : ""
      }`,
    );
    return true;
  } catch (e) {
    logFn(
      `⚠ [byot-sync] coach-model patch failed for ${input.slug}: ${(e as Error).message}`,
    );
    return false;
  }
}

export async function applyOauthRuntimeModelAllowlist(
  providers: readonly ByosubProvider[],
  deps?: {
    applyConfigPatch?: typeof applyConfigPatch;
    logFn?: (m: string) => void;
  },
): Promise<OauthRuntimeModelAllowlistResult> {
  const uniqueProviders = Array.from(new Set(providers));
  const models: Record<string, unknown> = {};
  let enableCodex = false;
  let enableClaudeCli = false;
  if (uniqueProviders.includes("openai")) {
    Object.assign(models, codexRuntimeConfig().modelsDef);
    enableCodex = true;
  }
  if (uniqueProviders.includes("anthropic")) {
    Object.assign(models, claudeCliRuntimeConfig().modelsDef);
    enableClaudeCli = true;
  }
  if (Object.keys(models).length === 0) {
    return { patched: false, changed: false, restartRequired: false };
  }

  const buildPatch = (current: unknown) => ({
    agents: { defaults: { models } },
    ...(enableCodex
      ? {
          plugins: {
            entries: {
              codex: {
                enabled: true,
                config: { appServer: currentCodexAppServerConfig(current) },
              },
            },
          },
        }
      : {}),
  });
  const logFn = deps?.logFn ?? log;
  const applyConfigPatchFn = deps?.applyConfigPatch ?? applyConfigPatch;
  try {
    const result = await applyConfigPatchFn(
      {
        buildPatch,
        logPrefix: "[byot-sync:oauth-runtime]",
      },
      { maxRetries: Number.POSITIVE_INFINITY, totalDeadlineMs: BYOT_RUNTIME_BOOT_PATIENCE_MS },
    );
    logFn(
      `[byot-sync] OAuth runtime models allowlisted for ${uniqueProviders.sort().join(", ")}`,
    );
    const changed = result.noop !== true;
    return { patched: true, changed, restartRequired: changed && enableClaudeCli };
  } catch (e) {
    logFn(`⚠ [byot-sync] OAuth runtime allowlist patch failed: ${(e as Error).message}`);
    return { patched: false, changed: false, restartRequired: false };
  }
}

export interface OauthRuntimeModelAllowlistResult {
  patched: boolean;
  changed: boolean;
  restartRequired: boolean;
}

export async function requestGatewayRestartForRuntimeChange(
  reason = "byosub.oauth-runtime",
): Promise<boolean> {
  const rpc = createGatewayRpc({
    allowLegacyGatewayTokenFallback: true,
    connectTimeoutMs: 10_000,
    callTimeoutMs: 10_000,
  });
  try {
    await rpc.gatewayRestartRequest({
      reason,
      skipDeferral: true,
    });
    log(`[byot-sync] gateway restart requested after runtime change (${reason})`);
    return true;
  } catch (err) {
    let detail: string;
    if (err instanceof OpenclawWireError) {
      detail = `${err.code}: ${err.message}`;
    } else if (err instanceof Error) {
      detail = err.message;
    } else {
      detail = String(err);
    }
    log(`⚠ [byot-sync] gateway restart request failed after runtime change (${reason}): ${detail}`);
    return false;
  } finally {
    await rpc.close();
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
  providers?: ByosubProvider[];
}

export function markerProvidersForSlot(
  byosub: Record<string, ByosubRef> | undefined,
  agentId: string,
): Array<"claude-cli" | "openai-codex"> {
  const providers = byosub?.[agentId]?.providers;
  if (!providers) return [];
  return [
    ...(providers.openai ? (["openai-codex"] as const) : []),
    ...(providers.anthropic ? (["claude-cli"] as const) : []),
  ];
}

export interface ByosubCred {
  provider: ByosubProvider;
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

export async function brokerFetchByosubCreds(agentId: string): Promise<ByosubCred[] | null> {
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
  const data = (await r.json()) as { credentials?: unknown };
  const credentials = data.credentials;
  if (
    !Array.isArray(credentials) ||
    credentials.some(
      (cred) =>
        !cred ||
        typeof cred !== "object" ||
        ((cred as { provider?: unknown }).provider !== "openai" &&
          (cred as { provider?: unknown }).provider !== "anthropic") ||
        typeof (cred as { secretName?: unknown }).secretName !== "string" ||
        typeof (cred as { credential?: unknown }).credential !== "string",
    )
  ) {
    throw new Error("byosub-cred: malformed broker response");
  }
  return credentials.map((cred) => ({
    provider: (cred as { provider: ByosubProvider }).provider,
    secretName: (cred as { secretName: string }).secretName,
    credential: (cred as { credential: string }).credential,
  }));
}

export async function fetchAgentModelBrokerToken(input: {
  agentId: string;
  provider: "openrouter";
}): Promise<string> {
  const r = await internalFetch(`${byokBrokerBaseUrl()}/internal/byok/agent-model-token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!r.ok) {
    const body = (await r.text().catch(() => "")).slice(0, 200);
    throw new Error(`agent-model-token ${r.status} ${body}`);
  }
  const data = (await r.json()) as { value?: unknown };
  if (typeof data.value !== "string" || data.value.length === 0) {
    throw new Error("agent-model-token: malformed broker response");
  }
  return data.value;
}

export interface RuntimeRegistryPatchResult {
  patched: boolean;
  changed: boolean;
  restartRequired: boolean;
}

export async function applyOpenRouterPlatformCohortPatch(
  input: { slug: string; model: string; contextTokens?: number },
  deps?: {
    applyConfigPatch?: typeof applyConfigPatch;
    fetchAgentModelBrokerToken?: typeof fetchAgentModelBrokerToken;
    openRouterBaseUrl?: typeof configuredOpenRouterBaseUrl;
    logFn?: (m: string) => void;
  },
): Promise<RuntimeRegistryPatchResult> {
  const logFn = deps?.logFn ?? log;
  const baseUrl = (deps?.openRouterBaseUrl ?? configuredOpenRouterBaseUrl)();
  if (!baseUrl) {
    logFn(`⚠ [byot-sync] ${input.slug}: OPENROUTER_BASE_URL is not configured`);
    return { patched: false, changed: false, restartRequired: false };
  }
  const agentId = `octogee-${input.slug}-coach`;
  const fetchToken = deps?.fetchAgentModelBrokerToken ?? fetchAgentModelBrokerToken;
  let apiKey: string;
  try {
    apiKey = await fetchToken({ agentId, provider: "openrouter" });
  } catch (e) {
    logFn(
      `⚠ [byot-sync] ${input.slug}: OpenRouter broker token materialization failed: ${(e as Error).message}`,
    );
    return { patched: false, changed: false, restartRequired: false };
  }

  const modelRef = `${OPENROUTER_BROKER_PROVIDER_ID}/${input.model}`;
  const provider = openRouterBrokerProviderConfig({
    baseUrl,
    model: input.model,
    apiKey,
    ...(typeof input.contextTokens === "number" ? { contextTokens: input.contextTokens } : {}),
  });
  const applyConfigPatchFn = deps?.applyConfigPatch ?? applyConfigPatch;
  const buildPatch = (current: unknown) => ({
    models: { providers: { [OPENROUTER_BROKER_PROVIDER_ID]: provider } },
    agents: {
      defaults: { models: { [modelRef]: {} } },
      list: coachFullAgentList(current, agentId, modelRef),
    },
  });

  try {
    const result = await applyConfigPatchFn(
      {
        buildPatch,
        buildReplacePaths: () => ["agents.list"],
        logPrefix: `[byot-sync:${input.slug}:openrouter]`,
      },
      { maxRetries: Number.POSITIVE_INFINITY, totalDeadlineMs: BYOT_RUNTIME_BOOT_PATIENCE_MS },
    );
    const changed = result.noop !== true;
    logFn(`[byot-sync] ${input.slug}: OpenRouter platform model → ${modelRef}`);
    return { patched: true, changed, restartRequired: changed };
  } catch (e) {
    logFn(`⚠ [byot-sync] ${input.slug}: OpenRouter platform patch failed: ${(e as Error).message}`);
    return { patched: false, changed: false, restartRequired: false };
  }
}

export async function restoreOauthStoreForSlug(
  slug: string,
  deps?: {
    fetchByosubCreds?: (agentId: string) => Promise<ByosubCred[] | null>;
    openclawDir?: string;
    claudeCliNativeHomeDir?: string;
    logFn?: (m: string) => void;
  },
): Promise<OauthStoreRestoreResult> {
  const agentId = `octogee-${slug}-coach`;
  const logFn = deps?.logFn ?? log;
  try {
    const fetchByosubCreds = deps?.fetchByosubCreds ?? brokerFetchByosubCreds;
    const ocDir = deps?.openclawDir ?? OPENCLAW_DIR;
    const creds = await fetchByosubCreds(agentId);
    if (!creds || creds.length === 0) {
      return { restored: false, present: false, providers: [] };
    }
    const providers = Array.from(new Set(creds.map((cred) => cred.provider)));
    const byosub: Record<string, ByosubRef> = {
      [agentId]: {
        providers: Object.fromEntries(
          creds.map((cred) => [
            cred.provider,
            { provider: cred.provider, secretName: cred.secretName },
          ]),
        ),
      },
    };
    const claudeCliNativeHomeDir =
      deps?.claudeCliNativeHomeDir ?? claudeCliNativeHomeDirForGateway();
    const r = await restoreByosubForAgents({
      agentIds: [agentId],
      byosub,
      openclawDir: ocDir,
      fetchSecret: async (secretName) => {
        const cred = creds.find((candidate) => candidate.secretName === secretName);
        if (!cred) throw new Error(`broker response omitted ${secretName}`);
        return cred.credential;
      },
      logFn,
      ...(claudeCliNativeHomeDir ? { claudeCliNativeHomeDir } : {}),
    });

    return { restored: r.restored > 0, present: r.restored > 0 || r.skipped > 0, providers };
  } catch (e) {
    logFn(`⚠ [byot-sync] oauth-store restore failed for ${slug}: ${(e as Error).message}`);
    return { restored: false, present: false, providers: [] };
  }
}

export interface SyncByotForCustomerDeps {
  isOperatorGateway?: () => boolean;
  isSharedGateway?: () => boolean;
  usesLlmBrokerToken?: () => boolean;
  logFn?: (m: string) => void;
  applyByotState?: typeof applyByotState;
  restoreOauthStoreForSlug?: typeof restoreOauthStoreForSlug;
  applyCoachModelPatch?: typeof applyCoachModelPatch;
  applyOauthRuntimeModelAllowlist?: typeof applyOauthRuntimeModelAllowlist;
  requestGatewayRestart?: typeof requestGatewayRestartForRuntimeChange;
  triggerSecretsReload?: typeof triggerSecretsReload;
  materializeAnthropicBroker?: (slug: string) => boolean;
  applyOpenRouterPlatformCohortPatch?: typeof applyOpenRouterPlatformCohortPatch;
}

type DesiredByotState = ReturnType<typeof deriveDesiredByotState>;
type SyncByotUserData = Parameters<typeof deriveDesiredByotState>[0];

interface SyncByotActions {
  applyByotState: typeof applyByotState;
  restoreOauthStoreForSlug: typeof restoreOauthStoreForSlug;
  applyCoachModelPatch: typeof applyCoachModelPatch;
  applyOauthRuntimeModelAllowlist: typeof applyOauthRuntimeModelAllowlist;
  requestGatewayRestart: typeof requestGatewayRestartForRuntimeChange;
  triggerSecretsReload: typeof triggerSecretsReload;
  materializeAnthropicBroker: (slug: string) => boolean;
  applyOpenRouterPlatformCohortPatch: typeof applyOpenRouterPlatformCohortPatch;
}

function materializeAnthropicBroker(slug: string): boolean {
  const agentId = `octogee-${slug}-coach`;
  return upsertAnthropicBrokerProfile(path.join(AGENTS_DIR, agentId, "agent"), agentId);
}

function configuredOpenRouterBaseUrl(): string | null {
  const raw = process.env.OPENROUTER_BASE_URL?.trim();
  return raw || null;
}

// eslint-disable-next-line complexity -- Dependency injection defaults are intentionally centralized for runtime and tests.
function syncActions(deps?: SyncByotForCustomerDeps): SyncByotActions {
  return {
    applyByotState: deps?.applyByotState ?? applyByotState,
    restoreOauthStoreForSlug: deps?.restoreOauthStoreForSlug ?? restoreOauthStoreForSlug,
    applyCoachModelPatch: deps?.applyCoachModelPatch ?? applyCoachModelPatch,
    applyOauthRuntimeModelAllowlist:
      deps?.applyOauthRuntimeModelAllowlist ?? applyOauthRuntimeModelAllowlist,
    requestGatewayRestart: deps?.requestGatewayRestart ?? requestGatewayRestartForRuntimeChange,
    triggerSecretsReload: deps?.triggerSecretsReload ?? triggerSecretsReload,
    materializeAnthropicBroker: deps?.materializeAnthropicBroker ?? materializeAnthropicBroker,
    applyOpenRouterPlatformCohortPatch:
      deps?.applyOpenRouterPlatformCohortPatch ?? applyOpenRouterPlatformCohortPatch,
  };
}

async function applyRestoredOauthRuntimeAllowlist(
  restore: OauthStoreRestoreResult,
  actions: SyncByotActions,
): Promise<OauthRuntimeModelAllowlistResult> {
  if (!restore.present) return { patched: false, changed: false, restartRequired: false };
  return actions.applyOauthRuntimeModelAllowlist(restore.providers ?? []);
}

async function requestRestartIfRequired(
  runtimePatch: OauthRuntimeModelAllowlistResult,
  actions: SyncByotActions,
): Promise<boolean> {
  if (!runtimePatch.restartRequired) return false;
  return actions.requestGatewayRestart();
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
  const materialized = actions.materializeAnthropicBroker(slug);
  log(
    `[byot-sync] ${slug}: anthropic BYOT is broker-resolved; local provider-key refs removed`,
  );
  if (changed || materialized) await actions.triggerSecretsReload();
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
  const runtimePatched = await applyRestoredOauthRuntimeAllowlist(restore, actions);
  const patched = restore.present && desired.coachModelInput
    ? await actions.applyCoachModelPatch(desired.coachModelInput)
    : false;
  const restartRequested = await requestRestartIfRequired(runtimePatched, actions);

  if ((changed || restore.restored || runtimePatched.patched || patched) && !restartRequested) {
    await actions.triggerSecretsReload();
  }
}

async function syncOperatorByotState(
  slug: string,
  desired: DesiredByotState,
  actions: SyncByotActions,
): Promise<void> {
  const restore = await restoreOauthIfNeeded(slug, desired, actions);
  const runtimePatched = await applyRestoredOauthRuntimeAllowlist(restore, actions);
  const patched = restore.present && desired.coachModelInput
    ? await actions.applyCoachModelPatch(desired.coachModelInput)
    : false;
  const restartRequested = await requestRestartIfRequired(runtimePatched, actions);
  if ((restore.restored || runtimePatched.patched || patched) && !restartRequested) {
    await actions.triggerSecretsReload();
  }
}

// Shared (multi-tenant) pods route EACH customer-agent's anthropic through the
// broker with its own per-customer token. Unlike builder/operator (one env gateway
// token), the per-agent anthropic:default broker-token profile is the load-bearing
// credential — the primary for platform/anthropic-BYOK customers and the Haiku
// fallback for BYOS / non-anthropic-BYOK ones — so it is always (re)asserted, the
// auth-profile store is never torn down, and byosub OAuth + custom-provider
// models.json coexist alongside it.
// BYOSUB is single-trust-boundary-only: an OAuth model credential (claude-cli,
// codex) never materializes on a multi-tenant pod. The owner runs the platform
// broker profile with their OWN tier grant — same models and budgets as any
// platform customer on shared — and the subscription resumes automatically
// when the migrate plane moves them to a builder/operator gateway (class-gated
// materialization at pod boot, no user action).
export function gateSharedByosub(
  desired: DesiredByotState,
  userData: SyncByotUserData,
  logFn: (m: string) => void,
): { desired: DesiredByotState; suppressed: boolean } {
  const provider = desired.input?.provider;
  if (!provider || !isModelCredentialOauthProvider(provider)) {
    return { desired, suppressed: false };
  }
  const slug = userData.username ?? "";
  logFn(
    `[byot-sync] ${slug}: byosub (${provider}) suppressed on shared gateway — ` +
      `OAuth model credentials are single-trust-boundary only; serving the platform ` +
      `broker profile with the owner's tier grant`,
  );
  return {
    desired: {
      enabled: false,
      input: null,
      coachModelInput: platformCoachModelInputForUser(slug, userData),
    },
    suppressed: true,
  };
}

// eslint-disable-next-line complexity -- Shared gateways reconcile BYOT, broker profiles, OAuth allowlists, and cohort models in one ordered pass.
async function syncSharedBrokerByotState(
  slug: string,
  desired: DesiredByotState,
  actions: SyncByotActions,
  opts?: { purgeAuthProfileStore?: boolean },
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
    // A suppressed byosub owner may carry a pre-gate OAuth profile in the
    // store — purge it; every other shared path preserves the store.
    { preserveAuthProfileStore: opts?.purgeAuthProfileStore !== true },
  );

  const materialized = actions.materializeAnthropicBroker(slug);
  const platformOpenRouterInput =
    desired.coachModelInput &&
    "source" in desired.coachModelInput &&
    desired.coachModelInput.source === "platform-cohort" &&
    desired.coachModelInput.provider === "openrouter"
      ? {
          slug,
          model: desired.coachModelInput.model,
          ...(typeof desired.coachModelInput.contextTokens === "number"
            ? { contextTokens: desired.coachModelInput.contextTokens }
            : {}),
        }
      : null;
  const openRouterRuntimePatch = platformOpenRouterInput
    ? await actions.applyOpenRouterPlatformCohortPatch(platformOpenRouterInput)
    : { patched: false, changed: false, restartRequired: false };
  const runtimePatched = await applyRestoredOauthRuntimeAllowlist(restore, actions);

  const patched = restore.present && desired.coachModelInput && !platformOpenRouterInput
    ? await actions.applyCoachModelPatch(desired.coachModelInput)
    : false;
  const oauthRestartRequested = await requestRestartIfRequired(runtimePatched, actions);
  const openRouterRestartRequested = openRouterRuntimePatch.restartRequired
    ? await actions.requestGatewayRestart("platform-cohort.openrouter")
    : false;
  const restartRequested = oauthRestartRequested || openRouterRestartRequested;

  if (
    (changed ||
      restore.restored ||
      materialized ||
      openRouterRuntimePatch.patched ||
      runtimePatched.patched ||
      patched) &&
    !restartRequested
  ) {
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
    const gate = gateSharedByosub(desired, userData, deps?.logFn ?? log);
    await syncSharedBrokerByotState(slug, gate.desired, actions, {
      purgeAuthProfileStore: gate.suppressed,
    });
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
