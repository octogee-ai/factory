import * as path from "path";
import * as os from "os";
import * as fs from "fs";
import {
  applyByotState,
  byosCoachConfigPatch,
  coachFullAgentList,
  deriveDesiredByotState,
  FREE_TIER_COACH_TOOLS,
  isPlatformProviderRef,
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
  codexAuthJsonPath,
  restoreByosubCredentials,
  type ByosubProvider,
  type ByosubRestorePlanItem,
} from "./byosub-restore.js";
import { applyConfigPatch, fullAgentListReplacePaths } from "./apply-config-patch.js";
import {
  AGENTS_DIR,
  GATEWAY_CLASS,
  OPENCLAW_DIR,
  isOperatorGateway,
  isSharedGateway,
  log,
  readOpenClawConfig,
  usesLlmBrokerToken,
} from "./config.js";
import {
  openAiCatalogInputForBaseUrl,
  openRouterCatalogInputForBaseUrl,
  upsertAnthropicBrokerProfile,
  upsertOpenAiBrokerCatalog,
  upsertOpenRouterBrokerCatalog,
} from "./agent-model-token-materializer.js";
import { agentIdBelongsToSlug, type AgentModelSelections } from "@octogee/shared/types/agent-models";
import { resolveBillingProfile } from "@octogee/shared/types/billing";

// byot-sync fires at pod boot, before openclaw is listening on :18789, so the
// coach-model patch must wait for the runtime to finish booting (ECONNREFUSED)
// rather than burn a fixed 3-shot budget. Deadline-bounded (matches the
// coach-attach verify's runtime-readiness budget); permanent errors still fail
// fast inside applyConfigPatch.
const BYOT_RUNTIME_BOOT_PATIENCE_MS = 120_000;
const PLATFORM_CATALOG_RESTART_MARKER = path.join(
  OPENCLAW_DIR,
  ".platform-model-catalog-restart-required",
);

function hasPendingPlatformCatalogRestart(): boolean {
  return fs.existsSync(PLATFORM_CATALOG_RESTART_MARKER);
}

function markPlatformCatalogRestartPending(): void {
  fs.mkdirSync(OPENCLAW_DIR, { recursive: true });
  fs.writeFileSync(PLATFORM_CATALOG_RESTART_MARKER, "pending\n", "utf-8");
}

function clearPlatformCatalogRestartPending(): void {
  fs.rmSync(PLATFORM_CATALOG_RESTART_MARKER, { force: true });
}

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
  const { id: agentId, model, tools } = patch.agents.list[0];
  const modelPrimary = typeof model === "string" ? model : model.primary;
  const modelFallbacks = typeof model === "string" ? [] : model.fallbacks;
  const applyConfigPatchFn = deps?.applyConfigPatch ?? applyConfigPatch;
  // Ship the FULL agents.list (coach model updated, siblings preserved verbatim)
  // WITH fullAgentListReplacePaths(). On a multi-agent gateway an id-less base
  // agent disables id-keyed merge for agents.list, so the destructive-array guard
  // falls back to arrayPreservesBaseEntries — a deep-equal base↔merged check that
  // flags the coach entry we just re-modeled as "removed" even though no entry is
  // dropped; "agents.list" confirms the wholesale replacement. On an all-id base
  // the guard instead descends INTO the coach entry and names its shrunk arrays
  // (model.fallbacks on the override → house-pin transition, tools.alsoAllow on a
  // trim rewrite) as agents.list[].* paths needing their own confirmation — the
  // per-entry wildcard half of the set. Rebuilt per attempt against the
  // freshly-fetched config (hash-mismatch safe; see coachFullAgentList).
  // tools convergence rides the same full-list patch: the free-tier trim when
  // the entry carries it, an explicit strip (null) for every catalog-access
  // input so an upgrade removes the trim on the next re-assert.
  const buildPatch = (current: unknown) => ({
    ...patch,
    agents: { ...patch.agents, list: coachFullAgentList(current, agentId, model, tools ?? null) },
  });
  try {
    await applyConfigPatchFn(
      {
        buildPatch,
        buildReplacePaths: () => fullAgentListReplacePaths(),
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

// Plan-gated tools reassert for syncs that ship no coach-model patch (catalog
// plan, no BYOK, no explicit pick — the config-default coach). The model
// patch converges tools whenever it ships; this covers the remaining lapse/
// upgrade transitions so the free-tier trim appears and disappears exactly
// like the model pin does. Model untouched (model:null).
export async function applyCoachToolsConvergence(
  slug: string,
  houseOnly: boolean,
  deps?: {
    applyConfigPatch?: typeof applyConfigPatch;
    logFn?: (m: string) => void;
  },
): Promise<boolean> {
  const logFn = deps?.logFn ?? log;
  const agentId = `octogee-${slug}-coach`;
  const tools = houseOnly ? FREE_TIER_COACH_TOOLS : null;
  const applyConfigPatchFn = deps?.applyConfigPatch ?? applyConfigPatch;
  // A missing coach entry means there is nothing to converge — succeeding
  // silently here would mask an unmounted/half-mounted customer on the very
  // path that exists to repair upgrade/lapse drift. Fail loudly instead; the
  // next sync/re-mount retries.
  const buildPatch = (current: unknown) => {
    const list = (current as { agents?: { list?: unknown } } | undefined)?.agents?.list;
    const agents = Array.isArray(list) ? list : [];
    const coachPresent = agents.some(
      (a) => a !== null && typeof a === "object" && (a as { id?: unknown }).id === agentId,
    );
    if (!coachPresent) {
      throw new Error(
        `coach entry ${agentId} missing from agents.list — nothing to converge (customer not mounted on this pod?)`,
      );
    }
    return { agents: { list: coachFullAgentList(current, agentId, null, tools) } };
  };
  try {
    await applyConfigPatchFn(
      {
        buildPatch,
        buildReplacePaths: () => fullAgentListReplacePaths(),
        logPrefix: `[coach-tools:${slug}]`,
      },
      { maxRetries: Number.POSITIVE_INFINITY, totalDeadlineMs: BYOT_RUNTIME_BOOT_PATIENCE_MS },
    );
    logFn(
      `[byot-sync] ${slug}: coach tools ${houseOnly ? "trimmed to the free-tier surface" : "converged to the inherited gateway surface"}`,
    );
    return true;
  } catch (e) {
    logFn(`⚠ [byot-sync] coach-tools convergence failed for ${slug}: ${(e as Error).message}`);
    return false;
  }
}

// Per-agent model picks from the PWA catalog picker (users/{uid}/system/
// config.agentModels). Applied last so an explicit pick wins over the class
// default the standard sync just wrote. Absence means "leave the agent
// alone" — partial userData from other trigger sites must never reset models.
export async function applyAgentModelOverrides(
  slug: string,
  agentModels: AgentModelSelections | undefined,
  opts: { houseOnly: boolean },
  deps?: {
    applyConfigPatch?: typeof applyConfigPatch;
    logFn?: (m: string) => void;
  },
): Promise<boolean> {
  const logFn = deps?.logFn ?? log;
  const owned = Object.entries(agentModels ?? {}).filter(([agentId]) => {
    if (agentIdBelongsToSlug(agentId, slug)) return true;
    logFn(`⚠ [byot-sync] ${slug}: agent-model override for foreign agent ${agentId} ignored`);
    return false;
  });
  if (owned.length === 0) return false;
  if (opts.houseOnly) {
    logFn(
      `[byot-sync] ${slug}: agent-model overrides deferred — house-only plan pins the house model`,
    );
    return false;
  }

  const applyConfigPatchFn = deps?.applyConfigPatch ?? applyConfigPatch;
  let patched = false;
  for (const [agentId, selection] of owned) {
    const model = { primary: selection.primary, fallbacks: selection.fallbacks };
    const platformRefs = [selection.primary, ...selection.fallbacks].filter(
      isPlatformProviderRef,
    );
    // Overrides only run for catalog plans (house-only defers above), so the
    // coach's rebuild also strips a lingering free-tier trim (fingerprint-
    // gated). The trim is coach-only, so every other owned agent's tools keys
    // are left untouched.
    const toolsConvergence = agentId === `octogee-${slug}-coach` ? null : undefined;
    const buildPatch = (current: unknown) => ({
      agents: {
        ...(platformRefs.length > 0
          ? {
              defaults: {
                models: Object.fromEntries(platformRefs.map((ref) => [ref, {}])),
              },
            }
          : {}),
        list: coachFullAgentList(current, agentId, model, toolsConvergence),
      },
    });
    try {
      await applyConfigPatchFn(
        {
          buildPatch,
          buildReplacePaths: () => fullAgentListReplacePaths(),
          logPrefix: `[agent-models:${slug}]`,
        },
        { maxRetries: Number.POSITIVE_INFINITY, totalDeadlineMs: BYOT_RUNTIME_BOOT_PATIENCE_MS },
      );
      logFn(
        `[byot-sync] ${slug}: ${agentId} model → ${selection.primary}${
          selection.fallbacks.length ? ` (fallback ${selection.fallbacks.join(", ")})` : ""
        }`,
      );
      patched = true;
    } catch (e) {
      logFn(
        `⚠ [byot-sync] agent-model override failed for ${agentId}: ${(e as Error).message}`,
      );
    }
  }
  return patched;
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

export interface ByosubCred {
  provider: ByosubProvider;
  secretName: string;
  credential: string;
}

function claudeCliNativeHomeDirForGateway(): string | undefined {
  return GATEWAY_CLASS === "builder" || isOperatorGateway() ? os.homedir() : undefined;
}

// Cattle gateways are egress-blocked from the GCP metadata server, so they
// cannot read user integration state or Secret Manager directly. octogee-api
// proves the assigned user for the KSA-bound gateway, then derives the user's
// BYOSUB secret name from that integration. internalFetch attaches the projected
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


export interface RuntimeRegistryPatchResult {
  patched: boolean;
  changed: boolean;
  restartRequired: boolean;
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
    const plan: ByosubRestorePlanItem[] = creds.map((cred) => ({
      agentId,
      provider: cred.provider,
      secretName: cred.secretName,
      openclawDir: ocDir,
      ...(cred.provider === "openai" ? { targetPath: codexAuthJsonPath(ocDir, agentId) } : {}),
    }));
    const claudeCliNativeHomeDir =
      deps?.claudeCliNativeHomeDir ?? claudeCliNativeHomeDirForGateway();
    const r = await restoreByosubCredentials({
      plan,
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
  applyConfigPatch?: typeof applyConfigPatch;
  applyByotState?: typeof applyByotState;
  restoreOauthStoreForSlug?: typeof restoreOauthStoreForSlug;
  applyCoachModelPatch?: typeof applyCoachModelPatch;
  applyCoachToolsConvergence?: typeof applyCoachToolsConvergence;
  applyOauthRuntimeModelAllowlist?: typeof applyOauthRuntimeModelAllowlist;
  requestGatewayRestart?: typeof requestGatewayRestartForRuntimeChange;
  triggerSecretsReload?: typeof triggerSecretsReload;
  materializeAnthropicBroker?: (slug: string) => boolean;
  applyAgentModelOverrides?: typeof applyAgentModelOverrides;
  hasPendingPlatformCatalogRestart?: () => boolean;
  markPlatformCatalogRestartPending?: () => void;
  clearPlatformCatalogRestartPending?: () => void;
}

type DesiredByotState = ReturnType<typeof deriveDesiredByotState>;
type SyncByotUserData = Parameters<typeof deriveDesiredByotState>[0];

interface SyncByotActions {
  applyByotState: typeof applyByotState;
  restoreOauthStoreForSlug: typeof restoreOauthStoreForSlug;
  applyCoachModelPatch: typeof applyCoachModelPatch;
  applyCoachToolsConvergence: typeof applyCoachToolsConvergence;
  applyOauthRuntimeModelAllowlist: typeof applyOauthRuntimeModelAllowlist;
  requestGatewayRestart: typeof requestGatewayRestartForRuntimeChange;
  triggerSecretsReload: typeof triggerSecretsReload;
  materializeAnthropicBroker: (slug: string) => boolean;
  applyAgentModelOverrides: typeof applyAgentModelOverrides;
  hasPendingPlatformCatalogRestart: () => boolean;
  markPlatformCatalogRestartPending: () => void;
  clearPlatformCatalogRestartPending: () => void;
}

// Model-readiness: every customer-agent gets BOTH broker provider surfaces —
// the anthropic:default profile and the full OpenRouter catalog — so "/models
// switch to <any catalog model>" is a pure agents.list flip. Plan policy gates
// at the broker, so pre-wiring every provider on every agent is safe.
export function agentIdsForSlug(slug: string, config: unknown): string[] {
  const list = (config as { agents?: { list?: unknown } } | null)?.agents?.list;
  if (!Array.isArray(list)) return [];
  return Array.from(new Set(list.flatMap((entry) => {
    const agentId = (entry as { id?: unknown } | null)?.id;
    return typeof agentId === "string" && agentIdBelongsToSlug(agentId, slug) ? [agentId] : [];
  })));
}

function mountedAgentIdsForSlug(slug: string): string[] {
  try {
    const mounted = agentIdsForSlug(slug, readOpenClawConfig());
    return mounted.length > 0 ? mounted : [`octogee-${slug}-coach`];
  } catch (error) {
    log(`⚠ [byot-sync] failed to enumerate mounted agents for ${slug}: ${(error as Error).message}`);
    return [`octogee-${slug}-coach`];
  }
}

function materializeAnthropicBroker(slug: string): boolean {
  const baseUrl = configuredOpenRouterBaseUrl();
  const openAiBaseUrl = configuredPlatformOpenAiBaseUrl();
  let changed = false;
  for (const agentId of mountedAgentIdsForSlug(slug)) {
    try {
      const agentHome = path.join(AGENTS_DIR, agentId, "agent");
      const wroteProfile = upsertAnthropicBrokerProfile(agentHome, agentId);
      const wroteCatalog = baseUrl
        ? upsertOpenRouterBrokerCatalog(agentHome, agentId, openRouterCatalogInputForBaseUrl(baseUrl))
        : false;
      const wroteOpenAi = openAiBaseUrl
        ? upsertOpenAiBrokerCatalog(agentHome, agentId, openAiCatalogInputForBaseUrl(openAiBaseUrl))
        : false;
      changed = wroteProfile || wroteCatalog || wroteOpenAi || changed;
    } catch (error) {
      log(`⚠ [byot-sync] model catalog materialization failed for ${agentId}: ${(error as Error).message}`);
    }
  }
  return changed;
}

function configuredOpenRouterBaseUrl(): string | null {
  const raw = process.env.OPENROUTER_BASE_URL?.trim();
  return raw || null;
}

// Deliberately NOT OPENAI_BASE_URL — that name would repoint BYOK-openai and
// the embeddings flows at the broker. This env only feeds the platform-openai
// broker provider profile.
function configuredPlatformOpenAiBaseUrl(): string | null {
  const raw = process.env.PLATFORM_OPENAI_BASE_URL?.trim();
  return raw || null;
}

// eslint-disable-next-line complexity -- Dependency injection defaults are intentionally centralized for runtime and tests.
function syncActions(deps?: SyncByotForCustomerDeps): SyncByotActions {
  const patchDeps = deps?.applyConfigPatch
    ? { applyConfigPatch: deps.applyConfigPatch, logFn: deps.logFn }
    : undefined;
  return {
    applyByotState: deps?.applyByotState ?? applyByotState,
    restoreOauthStoreForSlug: deps?.restoreOauthStoreForSlug ?? restoreOauthStoreForSlug,
    applyCoachModelPatch:
      deps?.applyCoachModelPatch ?? ((input) => applyCoachModelPatch(input, patchDeps)),
    applyCoachToolsConvergence:
      deps?.applyCoachToolsConvergence ??
      ((slug, houseOnly) => applyCoachToolsConvergence(slug, houseOnly, patchDeps)),
    applyOauthRuntimeModelAllowlist:
      deps?.applyOauthRuntimeModelAllowlist ??
      ((providers) => applyOauthRuntimeModelAllowlist(providers, patchDeps)),
    requestGatewayRestart: deps?.requestGatewayRestart ?? requestGatewayRestartForRuntimeChange,
    triggerSecretsReload: deps?.triggerSecretsReload ?? triggerSecretsReload,
    materializeAnthropicBroker: deps?.materializeAnthropicBroker ?? materializeAnthropicBroker,
    applyAgentModelOverrides:
      deps?.applyAgentModelOverrides ??
      ((slug, agentModels, opts) => applyAgentModelOverrides(slug, agentModels, opts, patchDeps)),
    hasPendingPlatformCatalogRestart:
      deps?.hasPendingPlatformCatalogRestart ?? hasPendingPlatformCatalogRestart,
    markPlatformCatalogRestartPending:
      deps?.markPlatformCatalogRestartPending ?? markPlatformCatalogRestartPending,
    clearPlatformCatalogRestartPending:
      deps?.clearPlatformCatalogRestartPending ?? clearPlatformCatalogRestartPending,
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
  reason?: string,
  platformCatalogRestartPending = false,
): Promise<boolean> {
  if (!runtimePatch.restartRequired && !platformCatalogRestartPending) return false;
  const requested = await actions.requestGatewayRestart(
    platformCatalogRestartPending ? "platform-model-catalog" : reason,
  );
  if (requested && platformCatalogRestartPending) {
    actions.clearPlatformCatalogRestartPending();
  }
  return requested;
}

function materializePlatformCatalog(
  slug: string,
  actions: SyncByotActions,
): { changed: boolean; restartPending: boolean } {
  const changed = actions.materializeAnthropicBroker(slug);
  if (changed) actions.markPlatformCatalogRestartPending();
  return {
    changed,
    restartPending: changed || actions.hasPendingPlatformCatalogRestart(),
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
  const catalog = materializePlatformCatalog(slug, actions);
  log(
    `[byot-sync] ${slug}: anthropic BYOT is broker-resolved; local provider-key refs removed`,
  );
  const restartRequested = await requestRestartIfRequired(
    { patched: false, changed: false, restartRequired: false },
    actions,
    undefined,
    catalog.restartPending,
  );
  if ((changed || catalog.changed || catalog.restartPending) && !restartRequested) {
    await actions.triggerSecretsReload();
  }
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
  const catalogRestartPending = actions.hasPendingPlatformCatalogRestart();
  const restartRequested = await requestRestartIfRequired(
    runtimePatched,
    actions,
    undefined,
    catalogRestartPending,
  );

  if (
    (changed || restore.restored || runtimePatched.patched || patched || catalogRestartPending) &&
    !restartRequested
  ) {
    await actions.triggerSecretsReload();
  }
}

async function syncOperatorByotState(
  slug: string,
  desired: DesiredByotState,
  actions: SyncByotActions,
): Promise<void> {
  const restore = await restoreOauthIfNeeded(slug, desired, actions);
  const catalog = materializePlatformCatalog(slug, actions);
  const runtimePatched = await applyRestoredOauthRuntimeAllowlist(restore, actions);
  const patched = restore.present && desired.coachModelInput
    ? await actions.applyCoachModelPatch(desired.coachModelInput)
    : false;
  const restartRequested = await requestRestartIfRequired(
    runtimePatched,
    actions,
    undefined,
    catalog.restartPending,
  );
  if (
    (restore.restored || catalog.changed || catalog.restartPending || runtimePatched.patched || patched) &&
    !restartRequested
  ) {
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

// eslint-disable-next-line complexity -- Shared gateways reconcile BYOT, broker profiles, and OAuth allowlists in one ordered pass.
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

  const catalog = materializePlatformCatalog(slug, actions);
  const runtimePatched = await applyRestoredOauthRuntimeAllowlist(restore, actions);

  const patched = restore.present && desired.coachModelInput
    ? await actions.applyCoachModelPatch(desired.coachModelInput)
    : false;
  const restartRequested = await requestRestartIfRequired(
    runtimePatched,
    actions,
    undefined,
    catalog.restartPending,
  );

  if (
    (changed || restore.restored || catalog.changed || catalog.restartPending || runtimePatched.patched || patched) &&
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

  await syncByotStateForClass({ slug, desired, userData, actions, isShared, isOp, usesBrokerToken, logFn: deps?.logFn });

  await convergeCoachToolsIfNoModelPatch(slug, desired, userData, actions);

  // Explicit per-agent picks land last so they win over the class default the
  // sync just wrote; house-only plans stay pinned to the house model.
  await actions.applyAgentModelOverrides(slug, userData.systemConfig?.agentModels, {
    houseOnly: resolveBillingProfile(userData).modelAccess === "house_only",
  });
}

// When a coach-model patch ships it converges tools inline; whenever no patch
// will ship — config-default coach (catalog, no BYOK, no pick) OR a
// no-model-override BYOK provider like plain anthropic — the plan-gated tools
// reassert must run standalone, or an upgrade/lapse (and the BYOK carve-out:
// BYOK-active house_only keeps the inherited surface) would never converge.
// The trim target follows the model-pin gate exactly: only the free-tier
// house pin trims, and that pin always ships its own patch.
async function convergeCoachToolsIfNoModelPatch(
  slug: string,
  desired: DesiredByotState,
  userData: SyncByotUserData,
  actions: SyncByotActions,
): Promise<void> {
  const modelPatchWillShip =
    desired.coachModelInput != null && byosCoachConfigPatch(desired.coachModelInput) != null;
  if (modelPatchWillShip || userData.provisioning?.openclaw?.status !== "complete") return;
  const trimTarget = desired.coachModelInput != null && "source" in desired.coachModelInput;
  await actions.applyCoachToolsConvergence(slug, trimTarget);
}

async function syncByotStateForClass(args: {
  slug: string;
  desired: DesiredByotState;
  userData: SyncByotUserData;
  actions: SyncByotActions;
  isShared: () => boolean;
  isOp: () => boolean;
  usesBrokerToken: () => boolean;
  logFn?: (m: string) => void;
}): Promise<void> {
  const { slug, desired, userData, actions } = args;
  if (args.isShared()) {
    const gate = gateSharedByosub(desired, userData, args.logFn ?? log);
    await syncSharedBrokerByotState(slug, gate.desired, actions, {
      purgeAuthProfileStore: gate.suppressed,
    });
    return;
  }

  if (isBrokerResolvedAnthropic(desired, args.usesBrokerToken())) {
    await clearBrokerResolvedAnthropic(slug, actions);
    return;
  }

  if (args.isOp()) {
    await syncOperatorByotState(slug, desired, actions);
    return;
  }
  await syncStandardByotState(slug, desired, actions);
}
