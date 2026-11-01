import * as fs from "fs";
import * as path from "path";
import { resolveBillingProfile } from "@octogee/shared/types/billing";
import {
  catalogEntryForModelRef,
  OPENAI_PLATFORM_PROVIDER_ID,
  VERTEX_PLATFORM_PROVIDER_ID,
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
} from "./auth-profile-store.js";

function agentIdForSlug(slug: string): string {
  return `octogee-${slug}-coach`;
}

function agentDirForSlug(slug: string, agentsDir: string = AGENTS_DIR): string {
  return path.join(agentsDir, agentIdForSlug(slug), "agent");
}

// auth-profiles moved to SQLite in openclaw v2026.6.1+ (PR #89102) — we
// write that row directly via auth-profile-store. models.json stayed as a
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
export interface CodexAppServerPatch {
  sandbox: string;
  approvalPolicy: string;
}
// House-only coaches carry a per-agent tools override (openclaw
// agents.list[].tools, resolved by resolveEffectiveToolPolicy: an agent-level
// profile/alsoAllow replaces the global one). "minimal" keeps only
// session_status; alsoAllow re-adds exactly what a free coach conversation
// needs — the fs group, web, memory recall, and the Octogee platform skills
// free users are entitled to. Everything else in the fleet's coding profile
// (cron, sessions_*, goals/plan/skill_workshop, media generation,
// code_execution, x_search) is schema weight the $1/week plan can't afford on
// first load. Catalog plans carry NO override and inherit the gateway default.
export interface FreeTierCoachToolsBlock {
  profile: "minimal";
  alsoAllow: string[];
}

export const FREE_TIER_COACH_TOOLS: FreeTierCoachToolsBlock = {
  profile: "minimal",
  alsoAllow: [
    "read",
    "write",
    "edit",
    "apply_patch",
    "web_search",
    "web_fetch",
    "brave_search",
    "tavily_search",
    "tavily_extract",
    "memory_search",
    "memory_get",
    "octogee_chat_search",
    "octogee_chat_history",
    "octogee_chat_set_identity",
    "octogee_connection_request",
    "octogee_ask_ops",
    "octogee_google_calendar_events",
    "octogee_google_calendar_create",
    "octogee_google_calendar_create_approved",
    "octogee_google_calendar_update",
    "octogee_google_calendar_update_approved",
    "octogee_google_calendar_delete",
    "octogee_google_calendar_delete_approved",
    "octogee_google_gmail_search",
    "octogee_google_gmail_get",
    "octogee_google_gmail_triage",
    "octogee_google_gmail_triage_approved",
    "octogee_google_gmail_draft_create",
    "octogee_google_gmail_draft_create_approved",
    "octogee_google_gmail_draft_send",
    "octogee_google_gmail_draft_send_approved",
    "octogee_google_drive_read",
    "octogee_google_docs_read",
    "octogee_google_docs_write",
    "octogee_google_contacts_read",
    "octogee_google_tasks_lists",
    "octogee_google_tasks_list",
    "octogee_google_tasks_add",
    "octogee_google_tasks_add_approved",
    "octogee_google_tasks_update",
    "octogee_google_tasks_update_approved",
    "octogee_google_sheets_read",
    "octogee_google_sheets_write",
    "octogee_obsidian_read",
    "octogee_obsidian_write",
    "octogee_owner_automations",
    "octogee_project_create",
    "octogee_project_list",
    "workspace_commit",
    "octogee_project_commit",
    "octogee_project_capability",
    "octogee_project_build",
    "octogee_project_test",
    "octogee_project_preview",
    "octogee_project_run_status",
    "octogee_project_publish",
    "octogee_project_set_recipe",
    "octogee_board_list",
    "octogee_board_card_read",
    "octogee_board_card_create",
    "octogee_board_card_update",
    "octogee_board_card_move",
    "octogee_board_card_comment",
  ],
};

export interface CoachModelPatch {
  agents: {
    // Primary+fallback chain: the Builder's BYOK model, with the platform model
    // as the fallback so an unavailable/exhausted BYOK provider degrades to the
    // platform key instead of leaving a credential-less coach (B6).
    list: Array<{ id: string; model: CoachModelRef; tools?: FreeTierCoachToolsBlock }>;
    defaults?: { models: RuntimeModelsDef };
  };
}

export const STANDARD_CODEX_APP_SERVER: CodexAppServerPatch = {
  sandbox: "workspace-write",
  approvalPolicy: "never",
};

export const BUILDER_CODEX_APP_SERVER: CodexAppServerPatch = {
  sandbox: "danger-full-access",
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
    ref.startsWith(`${OPENAI_PLATFORM_PROVIDER_ID}/`) ||
    ref.startsWith(`${VERTEX_PLATFORM_PROVIDER_ID}/`)
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
            tools: FREE_TIER_COACH_TOOLS,
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

// The strip may only remove what the platform itself wrote: an exact
// fingerprint of FREE_TIER_COACH_TOOLS. A customer-authored or legacy
// profile/alsoAllow never matches and survives the catalog convergence.
function isPlatformFreeTierToolsBlock(existing: Record<string, unknown>): boolean {
  const alsoAllow = existing.alsoAllow;
  return (
    existing.profile === FREE_TIER_COACH_TOOLS.profile &&
    Array.isArray(alsoAllow) &&
    alsoAllow.length === FREE_TIER_COACH_TOOLS.alsoAllow.length &&
    FREE_TIER_COACH_TOOLS.alsoAllow.every((tool, i) => alsoAllow[i] === tool)
  );
}

// Tools convergence for the coach entry, applied alongside the model update:
// a FreeTierCoachToolsBlock merges over the entry's existing tools (fs guards
// and any other keys preserved — the free plan is platform-tuned, so the block
// wins over prior profile/alsoAllow values); null strips ONLY the platform's
// own free-tier block (fingerprint-gated) so an upgraded customer returns to
// the inherited gateway-wide surface without losing fs.workspaceOnly or any
// customer-authored tools keys.
export function convergedCoachToolsValue(
  existing: unknown,
  tools: FreeTierCoachToolsBlock | null,
): Record<string, unknown> | undefined {
  const base: Record<string, unknown> = isAgentRecord(existing)
    ? { ...(existing as Record<string, unknown>) }
    : {};
  if (tools) {
    delete base.profile;
    delete base.alsoAllow;
    return { ...base, profile: tools.profile, alsoAllow: [...tools.alsoAllow] };
  }
  if (isPlatformFreeTierToolsBlock(base)) {
    delete base.profile;
    delete base.alsoAllow;
  }
  return Object.keys(base).length > 0 ? base : undefined;
}

// The coach-model config.patch must ship the FULL agents.list — the coach's
// model updated, every sibling agent preserved verbatim — not a single-entry
// list. openclaw's id-keyed array merge (config/merge-patch.ts) upserts by id
// ONLY when every base entry carries a string id; a single id-less agent flips
// the whole array to wholesale replacement, so a one-entry patch drops the rest
// and trips the destructive-array guard (observed live 2026-06-23). A full list
// is safe under both the id-keyed merge and the wholesale fallback — no entries
// are removed either way.
//
// model:null leaves the entry's model untouched (plan-only tools reassert);
// tools:undefined leaves its tools untouched (pure model update).
export function coachFullAgentList(
  current: unknown,
  agentId: string,
  model: CoachModelPatch["agents"]["list"][number]["model"] | null,
  tools?: FreeTierCoachToolsBlock | null,
): unknown[] {
  const list = (current as { agents?: { list?: unknown } } | undefined)?.agents?.list;
  const agents = Array.isArray(list) ? list : [];
  return agents.map((a) => {
    if (!(isAgentRecord(a) && a.id === agentId)) return a;
    const next: Record<string, unknown> = { ...(a as Record<string, unknown>) };
    if (model !== null) next.model = model;
    if (tools !== undefined) {
      const converged = convergedCoachToolsValue(next.tools, tools);
      if (converged === undefined) {
        delete next.tools;
      } else {
        next.tools = converged;
      }
    }
    return next;
  });
}

export type CoachAgentPatch =
  | { list: unknown[] }
  | { entries: Record<string, Record<string, unknown>> };

function keyedAgentEntries(current: unknown): Record<string, unknown> | null {
  const entries = (current as { agents?: { entries?: unknown } } | undefined)?.agents?.entries;
  return isAgentRecord(entries) ? entries as Record<string, unknown> : null;
}

export function coachAgentPatch(
  current: unknown,
  agentId: string,
  model: CoachModelPatch["agents"]["list"][number]["model"] | null,
  tools?: FreeTierCoachToolsBlock | null,
): CoachAgentPatch {
  const entries = keyedAgentEntries(current);
  if (!entries) return { list: coachFullAgentList(current, agentId, model, tools) };

  const currentEntry = entries[agentId];
  if (!isAgentRecord(currentEntry)) return { entries: {} };
  const [next] = coachFullAgentList(
    { agents: { list: [{ ...(currentEntry as Record<string, unknown>), id: agentId }] } },
    agentId,
    model,
    tools,
  );
  if (!isAgentRecord(next)) throw new Error(`coach patch: invalid agent entry for ${agentId}`);
  const { id: _id, ...entry } = next as Record<string, unknown>;
  return { entries: { [agentId]: entry } };
}

export function coachAgentExists(current: unknown, agentId: string): boolean {
  const entries = keyedAgentEntries(current);
  if (entries) return isAgentRecord(entries[agentId]);
  const list = (current as { agents?: { list?: unknown } } | undefined)?.agents?.list;
  return Array.isArray(list) && list.some((agent) => isAgentRecord(agent) && agent.id === agentId);
}

export function coachAgentPatchReplacePaths(current: unknown, agentId: string): string[] {
  return keyedAgentEntries(current)
    ? [
        `agents.entries.${agentId}.model.fallbacks`,
        `agents.entries.${agentId}.tools.alsoAllow`,
      ]
    : [
        "agents.list",
        "agents.list[].model.fallbacks",
        "agents.list[].tools.alsoAllow",
      ];
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
  trialGrant?: unknown;
  signupOfferConvertedAt?: unknown;
  // The operator's free-tier model dial, stamped on the snapshot by the
  // trusted side; revalidated here against the catalog.
  freeTierModelRef?: unknown;
  // The operator's Builder Agent default dial, stamped like freeTierModelRef;
  // revalidated pod-side before it fills in for a missing coach pick.
  builderAgentDefault?: unknown;
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


// House-only (Personal Free with no live Signup Offer) pins the coach to the
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

async function removeManagedByotState(
  slug: string,
  dir: string,
  markerPath: string,
  filePath: (f: string) => string,
  preserveAuthProfileStore: boolean,
): Promise<boolean> {
  if (!fs.existsSync(markerPath)) return false;
  let changed = false;
  for (const f of BYOT_FILES) changed = removeIfExists(filePath(f)) || changed;
  // On a shared (per-agent broker-token) pod the auth-profile store holds the
  // anthropic:default broker token (+ any byosub OAuth) that the materializer owns;
  // tearing down a customer's local BYOT files must NOT delete it.
  if (!preserveAuthProfileStore && await readAuthProfileStore(dir) !== null) {
    await deleteAuthProfileStore(dir);
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

async function syncAuthProfileStore(
  dir: string,
  input: ByotInput,
  preserveAuthProfileStore: boolean,
): Promise<boolean> {
  if (isModelCredentialOauthProvider(input.provider)) return false;
  const cfg = buildModelCredentialConfigForProvider(input);
  if (cfg.authProfiles) {
    const before = await readAuthProfileStore(dir);
    if (JSON.stringify(before) !== JSON.stringify(cfg.authProfiles)) {
      await writeAuthProfileStore(dir, cfg.authProfiles);
      return true;
    }
    return false;
  }
  // Custom-provider BYOK (grok/openrouter/minimax) keeps its key in models.json,
  // not the profile store — so the store would normally be cleared here. On a
  // shared broker-token pod it instead holds the anthropic:default broker token,
  // so preserve it.
  if (preserveAuthProfileStore || await readAuthProfileStore(dir) === null) return false;
  await deleteAuthProfileStore(dir);
  return true;
}

export async function applyByotState(
  slug: string,
  input: ByotInput | null,
  agentsDir: string = AGENTS_DIR,
  opts: { preserveAuthProfileStore?: boolean } = {},
): Promise<boolean> {
  const dir = agentDirForSlug(slug, agentsDir);
  const filePath = (f: string) => path.join(dir, f);
  const markerPath = filePath(BYOT_MARKER);
  const preserve = opts.preserveAuthProfileStore ?? false;

  if (!input) {
    return await removeManagedByotState(slug, dir, markerPath, filePath, preserve);
  }

  if (!fs.existsSync(dir)) {
    log(`⚠ [byot-sync] ${slug}: agent dir missing (provisioning incomplete?) — skipping BYOT write`);
    return false;
  }

  let changed = writeDesiredByotFiles(desiredByotFiles(input), filePath);
  changed = await syncAuthProfileStore(dir, input, preserve) || changed;

  if (!fs.existsSync(markerPath)) {
    writeAtomic(markerPath, JSON.stringify({ managedSince: new Date().toISOString() }) + "\n");
  }

  if (changed) {
    const modelSuffix = input.model ? ` model=${input.model}` : "";
    log(`[byot-sync] ${slug}: BYOT config updated (provider=${input.provider}${modelSuffix})`);
  }
  return changed;
}
