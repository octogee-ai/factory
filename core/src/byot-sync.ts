import * as fs from "fs";
import * as path from "path";
import { resolveBillingProfile } from "@octogee/shared/types/billing";
import {
  catalogEntryForModelRef,
  OPENAI_PLATFORM_PROVIDER_ID,
  OPENROUTER_PLATFORM_PROVIDER_ID,
  type AgentModelSelections,
} from "@octogee/shared/types/agent-models";
import { DEFAULT_FREE_TIER_MODEL_REF } from "@octogee/shared/types/platform-config";
import {
  buildModelCredentialConfigForProvider,
  claudeCliRuntimeConfig,
  codexRuntimeConfig,
  isModelCredentialOauthProvider,
  MODEL_CREDENTIAL_MATERIALIZER_PROVIDERS,
  type ModelCredentialConfigInput,
  type ModelCredentialMaterializerProvider,
} from "./model-credential-materializer.js";
import { AGENTS_DIR, log } from "./config.js";
import {
  deleteAuthProfileStore,
  readAuthProfileStore,
  writeAuthProfileStore,
} from "./auth-profile-sqlite.js";

function agentIdForSlug(slug: string): string {
  return `octogee-${slug}-coach`;
}

function agentDirForSlug(slug: string, agentsDir: string = AGENTS_DIR): string {
  return path.join(agentsDir, agentIdForSlug(slug), "agent");
}

// auth-profiles moved to SQLite in openclaw v2026.6.1+ (PR #89102) — we
// write that row directly via auth-profile-sqlite. models.json stayed as a
// file, so it's the only entry in this list.
const BYOT_FILES = ["models.json"] as const;
type ByotFile = (typeof BYOT_FILES)[number];

const BYOT_MARKER = ".byot-managed";

export type ByotInput = ModelCredentialConfigInput;
export interface FreeTierCoachModelInput {
  slug: string;
  model: string;
  source: "free-tier";
}

// The BYOK coach input plus the operator's free-tier dial ref — the fallback
// chain's platform baseline follows the dial, not a compiled constant.
export type ByotCoachModelInput = ByotInput & { houseModelRef?: string };

export type CoachModelInput = ByotCoachModelInput | FreeTierCoachModelInput;

// A per-agent BYOS model override. codex (a plugin) pins agentRuntime:{id:codex}
// to route a gpt-5.5 override through the codex harness; claude-cli (a core
// runtime) uses the native claude-cli/<model> id with an empty allowlist entry
// (the prefix selects the runtime) — so agentRuntime is optional.
type RuntimeModelsDef = Record<string, { agentRuntime?: { id: string } }>;
type CoachModelRef = string | { primary: string; fallbacks: string[] };
interface CodexAppServerPatch {
  sandbox: string;
  approvalPolicy: string;
}
export interface CoachModelPatch {
  agents: {
    // Primary+fallback chain: the Builder's BYOK model, with the platform model
    // as the fallback so an unavailable/exhausted BYOK provider degrades to the
    // platform key instead of leaving a credential-less coach (B6).
    list: Array<{ id: string; model: CoachModelRef }>;
    defaults?: { models: RuntimeModelsDef };
  };
}

// Shared gateways run the codex app-server sandboxed. Builder/operator runtime
// gateways get their broader app-server policy from the gateway class boot
// policy and this fallback must not downgrade an existing runtime policy.
export const STANDARD_CODEX_APP_SERVER: CodexAppServerPatch = {
  sandbox: "workspace-write",
  approvalPolicy: "never",
};

// The always-available platform house model: the operator's free-tier dial
// (snapshot freeTierModelRef), compiled default DEFAULT_FREE_TIER_MODEL_REF.
// A failed/exhausted BYOK provider degrades here rather than leaving the
// coach credential-less, and house-only plans pin the coach here so config,
// status, and broker routing agree. Refs are revalidated against the catalog
// at this trust boundary.
function houseModelRefFrom(ref: unknown): string {
  return typeof ref === "string" && catalogEntryForModelRef(ref)
    ? ref
    : DEFAULT_FREE_TIER_MODEL_REF;
}

// A platform-provider ref (openrouter/openai) may sit outside the boot
// template's model set — declare it in agents.defaults.models (the picker
// path's pattern) so the pin resolves on every pod. Anthropic refs are
// declared by the boot materializer.
export function isPlatformProviderRef(ref: string): boolean {
  return (
    ref.startsWith(`${OPENROUTER_PLATFORM_PROVIDER_ID}/`) ||
    ref.startsWith(`${OPENAI_PLATFORM_PROVIDER_ID}/`)
  );
}

function platformModelsDef(refs: string[]): { models: RuntimeModelsDef } | null {
  const platformRefs = refs.filter(isPlatformProviderRef);
  if (platformRefs.length === 0) return null;
  return { models: Object.fromEntries(platformRefs.map((ref) => [ref, {}])) };
}

function runtimeModelsForProvider(provider: string): RuntimeModelsDef | null {
  if (provider === "openai-codex") return codexRuntimeConfig().modelsDef;
  if (provider === "claude-cli") return claudeCliRuntimeConfig().modelsDef;
  return null;
}

export function byosCoachConfigPatch(
  input: CoachModelInput | null,
): CoachModelPatch | null {
  if (!input) return null;
  if ("source" in input) {
    const defaults = platformModelsDef([input.model]);
    return {
      agents: {
        ...(defaults ? { defaults } : {}),
        list: [
          {
            id: agentIdForSlug(input.slug),
            model: { primary: input.model, fallbacks: [] },
          },
        ],
      },
    };
  }
  const cfg = buildModelCredentialConfigForProvider(input);
  if (cfg.agentModelOverride == null) return null;
  const houseModelRef = houseModelRefFrom(input.houseModelRef);
  const patch: CoachModelPatch = {
    agents: {
      list: [
        {
          id: agentIdForSlug(input.slug),
          model: { primary: cfg.agentModelOverride, fallbacks: [houseModelRef] },
        },
      ],
    },
  };
  const runtimeModels = runtimeModelsForProvider(input.provider);
  const houseDefaults = platformModelsDef([houseModelRef]);
  if (runtimeModels || houseDefaults) {
    patch.agents.defaults = {
      models: { ...(runtimeModels ?? {}), ...(houseDefaults?.models ?? {}) },
    };
  }
  return patch;
}

function isAgentRecord(a: unknown): a is { id?: unknown } {
  return a !== null && typeof a === "object" && !Array.isArray(a);
}

// The coach-model config.patch must ship the FULL agents.list — the coach's
// model updated, every sibling agent preserved verbatim — not a single-entry
// list. openclaw's id-keyed array merge (config/merge-patch.ts) upserts by id
// ONLY when every base entry carries a string id; a single id-less agent flips
// the whole array to wholesale replacement, so a one-entry patch drops the rest
// and trips the destructive-array guard (observed live 2026-06-23). A full list
// is safe under both the id-keyed merge and the wholesale fallback — no entries
// are removed either way.
export function coachFullAgentList(
  current: unknown,
  agentId: string,
  model: CoachModelPatch["agents"]["list"][number]["model"],
): unknown[] {
  const list = (current as { agents?: { list?: unknown } } | undefined)?.agents?.list;
  const agents = Array.isArray(list) ? list : [];
  return agents.map((a) => (isAgentRecord(a) && a.id === agentId ? { ...a, model } : a));
}

export function deriveDesiredByotState(userData: {
  byotActive?: boolean;
  username?: string;
  tier?: string;
  selectedTier?: string;
  subscription?: unknown;
  // Builder infra subscription (pricing v3): resolveBillingProfile reads it so a
  // credits-rail builder resolves catalog, not house_only.
  builderSubscription?: unknown;
  trialStartedAt?: unknown;
  // The operator's free-tier model dial, stamped on the snapshot by the
  // trusted side; revalidated here against the catalog.
  freeTierModelRef?: unknown;
  provisioning?: { openclaw?: { status?: string } };
  systemConfig?: {
    byot?: { provider?: string; baseUrl?: string; model?: string };
    agentModels?: AgentModelSelections;
  };
}): { enabled: boolean; input: ByotInput | null; coachModelInput: CoachModelInput | null } {
  const status = userData.provisioning?.openclaw?.status;
  const slug = userData.username;
  if (!slug || status !== "complete") {
    return { enabled: false, input: null, coachModelInput: null };
  }
  if (!userData.byotActive) {
    return {
      enabled: false,
      input: null,
      coachModelInput: freeTierCoachModelInput(slug, userData),
    };
  }
  const input = byotInputForSlug(slug, userData.systemConfig?.byot);
  return {
    enabled: true,
    input,
    coachModelInput: { ...input, houseModelRef: houseModelRefFrom(userData.freeTierModelRef) },
  };
}

// The model a non-byot customer would run: the house pin for house-only
// plans, else null — the config default stands and the PWA picker's per-agent
// overrides land afterwards. Used by deriveDesiredByotState and the
// shared-gateway byosub gate.
export function platformCoachModelInputForUser(
  slug: string,
  userData: Parameters<typeof deriveDesiredByotState>[0],
): CoachModelInput | null {
  return freeTierCoachModelInput(slug, userData);
}


// House-only (Personal Free with no live trial boost) pins the coach to the
// house model. The broker would degrade anyway; pinning keeps the config
// honest so /status and the agent's self-report agree with the wire.
function freeTierCoachModelInput(
  slug: string,
  userData: Parameters<typeof deriveDesiredByotState>[0],
): FreeTierCoachModelInput | null {
  const plan = resolveBillingProfile(userData);
  return plan.modelAccess === "house_only"
    ? { slug, model: houseModelRefFrom(userData.freeTierModelRef), source: "free-tier" }
    : null;
}

function byotInputForSlug(
  slug: string,
  cfg: { provider?: string; baseUrl?: string; model?: string } | undefined,
): ByotInput {
  const provider = cfg?.provider && Object.prototype.hasOwnProperty.call(
    MODEL_CREDENTIAL_MATERIALIZER_PROVIDERS,
    cfg.provider,
  )
    ? (cfg.provider as ModelCredentialMaterializerProvider)
    : "anthropic";
  return { slug, provider, baseUrl: cfg?.baseUrl, model: cfg?.model };
}

function writeAtomic(target: string, content: string): void {
  const tmp = `${target}.tmp`;
  fs.writeFileSync(tmp, content, { mode: 0o600 });
  fs.renameSync(tmp, target);
}

function removeIfExists(target: string): boolean {
  if (!fs.existsSync(target)) return false;
  fs.rmSync(target);
  return true;
}

function removeManagedByotState(
  slug: string,
  dir: string,
  markerPath: string,
  filePath: (f: string) => string,
  preserveAuthProfileStore: boolean,
): boolean {
  if (!fs.existsSync(markerPath)) return false;
  let changed = false;
  for (const f of BYOT_FILES) changed = removeIfExists(filePath(f)) || changed;
  // On a shared (per-agent broker-token) pod the auth-profile store holds the
  // anthropic:default broker token (+ any byosub OAuth) that the materializer owns;
  // tearing down a customer's local BYOT files must NOT delete it.
  if (!preserveAuthProfileStore && readAuthProfileStore(dir) !== null) {
    deleteAuthProfileStore(dir);
    changed = true;
  }
  changed = removeIfExists(markerPath) || changed;
  if (changed) log(`[byot-sync] ${slug}: removed BYOT files (BYOT off)`);
  return changed;
}

function desiredByotFiles(input: ByotInput): Record<ByotFile, string | null> {
  const cfg = buildModelCredentialConfigForProvider(input);
  return {
    "models.json": cfg.models ? JSON.stringify(cfg.models, null, 2) : null,
  };
}

function writeDesiredByotFiles(
  desired: Record<ByotFile, string | null>,
  filePath: (f: string) => string,
): boolean {
  let changed = false;
  for (const f of BYOT_FILES) {
    const target = filePath(f);
    const want = desired[f];
    const existing = fs.existsSync(target) ? fs.readFileSync(target, "utf8") : null;

    if (want == null) {
      changed = removeIfExists(target) || changed;
    } else if (existing !== want) {
      writeAtomic(target, want);
      changed = true;
    }
  }
  return changed;
}

function syncAuthProfileStore(
  dir: string,
  input: ByotInput,
  preserveAuthProfileStore: boolean,
): boolean {
  if (isModelCredentialOauthProvider(input.provider)) return false;
  const cfg = buildModelCredentialConfigForProvider(input);
  if (cfg.authProfiles) {
    const before = readAuthProfileStore(dir);
    if (JSON.stringify(before) !== JSON.stringify(cfg.authProfiles)) {
      writeAuthProfileStore(dir, cfg.authProfiles);
      return true;
    }
    return false;
  }
  // Custom-provider BYOK (grok/openrouter/minimax) keeps its key in models.json,
  // not the profile store — so the store would normally be cleared here. On a
  // shared broker-token pod it instead holds the anthropic:default broker token,
  // so preserve it.
  if (preserveAuthProfileStore || readAuthProfileStore(dir) === null) return false;
  deleteAuthProfileStore(dir);
  return true;
}

export function applyByotState(
  slug: string,
  input: ByotInput | null,
  agentsDir: string = AGENTS_DIR,
  opts: { preserveAuthProfileStore?: boolean } = {},
): boolean {
  const dir = agentDirForSlug(slug, agentsDir);
  const filePath = (f: string) => path.join(dir, f);
  const markerPath = filePath(BYOT_MARKER);
  const preserve = opts.preserveAuthProfileStore ?? false;

  if (!input) {
    return removeManagedByotState(slug, dir, markerPath, filePath, preserve);
  }

  if (!fs.existsSync(dir)) {
    log(`⚠ [byot-sync] ${slug}: agent dir missing (provisioning incomplete?) — skipping BYOT write`);
    return false;
  }

  let changed = writeDesiredByotFiles(desiredByotFiles(input), filePath);
  changed = syncAuthProfileStore(dir, input, preserve) || changed;

  if (!fs.existsSync(markerPath)) {
    writeAtomic(markerPath, JSON.stringify({ managedSince: new Date().toISOString() }) + "\n");
  }

  if (changed) {
    const modelSuffix = input.model ? ` model=${input.model}` : "";
    log(`[byot-sync] ${slug}: BYOT config updated (provider=${input.provider}${modelSuffix})`);
  }
  return changed;
}
