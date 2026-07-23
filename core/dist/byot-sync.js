import * as fs from "fs";
import * as path from "path";
import { resolveBillingProfile } from "@octogee/shared/types/billing";
import { catalogEntryForModelRef, OPENAI_PLATFORM_PROVIDER_ID, OPENROUTER_PLATFORM_PROVIDER_ID, } from "@octogee/shared/types/agent-models";
import { DEFAULT_FREE_TIER_MODEL_REF } from "@octogee/shared/types/platform-config";
import { buildModelCredentialConfigForProvider, claudeCliRuntimeConfig, codexRuntimeConfig, isModelCredentialOauthProvider, MODEL_CREDENTIAL_MATERIALIZER_PROVIDERS, } from "./model-credential-materializer.js";
import { AGENTS_DIR, log } from "./config.js";
import { deleteAuthProfileStore, readAuthProfileStore, writeAuthProfileStore, } from "./auth-profile-sqlite.js";
function agentIdForSlug(slug) {
    return `octogee-${slug}-coach`;
}
function agentDirForSlug(slug, agentsDir = AGENTS_DIR) {
    return path.join(agentsDir, agentIdForSlug(slug), "agent");
}
// auth-profiles moved to SQLite in openclaw v2026.6.1+ (PR #89102) — we
// write that row directly via auth-profile-sqlite. models.json stayed as a
// file, so it's the only entry in this list.
const BYOT_FILES = ["models.json"];
const BYOT_MARKER = ".byot-managed";
export const FREE_TIER_COACH_TOOLS = {
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
        "octogee_ask_ops",
        "workspace_commit",
        "preview_start",
        "preview_stop",
        "preview_list",
        "octogee_publish",
        "octogee_project_create",
        "octogee_project_commit",
        "octogee_project_list",
    ],
};
// Shared gateways run the codex app-server sandboxed. Builder/operator runtime
// gateways get their broader app-server policy from the gateway class boot
// policy and this fallback must not downgrade an existing runtime policy.
export const STANDARD_CODEX_APP_SERVER = {
    sandbox: "workspace-write",
    approvalPolicy: "never",
};
// The always-available platform house model: the operator's free-tier dial
// (snapshot freeTierModelRef), compiled default DEFAULT_FREE_TIER_MODEL_REF.
// A failed/exhausted BYOK provider degrades here rather than leaving the
// coach credential-less, and house-only plans pin the coach here so config,
// status, and broker routing agree. Refs are revalidated against the catalog
// at this trust boundary.
function houseModelRefFrom(ref) {
    return typeof ref === "string" && catalogEntryForModelRef(ref)
        ? ref
        : DEFAULT_FREE_TIER_MODEL_REF;
}
// A platform-provider ref (openrouter/openai) may sit outside the boot
// template's model set — declare it in agents.defaults.models (the picker
// path's pattern) so the pin resolves on every pod. Anthropic refs are
// declared by the boot materializer.
export function isPlatformProviderRef(ref) {
    return (ref.startsWith(`${OPENROUTER_PLATFORM_PROVIDER_ID}/`) ||
        ref.startsWith(`${OPENAI_PLATFORM_PROVIDER_ID}/`));
}
function platformModelsDef(refs) {
    const platformRefs = refs.filter(isPlatformProviderRef);
    if (platformRefs.length === 0)
        return null;
    return { models: Object.fromEntries(platformRefs.map((ref) => [ref, {}])) };
}
function runtimeModelsForProvider(provider) {
    if (provider === "openai-codex")
        return codexRuntimeConfig().modelsDef;
    if (provider === "claude-cli")
        return claudeCliRuntimeConfig().modelsDef;
    return null;
}
export function byosCoachConfigPatch(input) {
    if (!input)
        return null;
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
    if (cfg.agentModelOverride == null)
        return null;
    const houseModelRef = houseModelRefFrom(input.houseModelRef);
    const patch = {
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
function isAgentRecord(a) {
    return a !== null && typeof a === "object" && !Array.isArray(a);
}
// The strip may only remove what the platform itself wrote: an exact
// fingerprint of FREE_TIER_COACH_TOOLS. A customer-authored or legacy
// profile/alsoAllow never matches and survives the catalog convergence.
function isPlatformFreeTierToolsBlock(existing) {
    const alsoAllow = existing.alsoAllow;
    return (existing.profile === FREE_TIER_COACH_TOOLS.profile &&
        Array.isArray(alsoAllow) &&
        alsoAllow.length === FREE_TIER_COACH_TOOLS.alsoAllow.length &&
        FREE_TIER_COACH_TOOLS.alsoAllow.every((tool, i) => alsoAllow[i] === tool));
}
// Tools convergence for the coach entry, applied alongside the model update:
// a FreeTierCoachToolsBlock merges over the entry's existing tools (fs guards
// and any other keys preserved — the free plan is platform-tuned, so the block
// wins over prior profile/alsoAllow values); null strips ONLY the platform's
// own free-tier block (fingerprint-gated) so an upgraded customer returns to
// the inherited gateway-wide surface without losing fs.workspaceOnly or any
// customer-authored tools keys.
function convergedCoachToolsValue(existing, tools) {
    const base = isAgentRecord(existing)
        ? { ...existing }
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
export function coachFullAgentList(current, agentId, model, tools) {
    const list = current?.agents?.list;
    const agents = Array.isArray(list) ? list : [];
    return agents.map((a) => {
        if (!(isAgentRecord(a) && a.id === agentId))
            return a;
        const next = { ...a };
        if (model !== null)
            next.model = model;
        if (tools !== undefined) {
            const converged = convergedCoachToolsValue(next.tools, tools);
            if (converged === undefined) {
                delete next.tools;
            }
            else {
                next.tools = converged;
            }
        }
        return next;
    });
}
export function deriveDesiredByotState(userData) {
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
export function platformCoachModelInputForUser(slug, userData) {
    return freeTierCoachModelInput(slug, userData);
}
// House-only (Personal Free with no live Signup Offer) pins the coach to the
// house model. The broker would degrade anyway; pinning keeps the config
// honest so /status and the agent's self-report agree with the wire.
function freeTierCoachModelInput(slug, userData) {
    const plan = resolveBillingProfile(userData);
    return plan.modelAccess === "house_only"
        ? { slug, model: houseModelRefFrom(userData.freeTierModelRef), source: "free-tier" }
        : null;
}
function byotInputForSlug(slug, cfg) {
    const provider = cfg?.provider && Object.prototype.hasOwnProperty.call(MODEL_CREDENTIAL_MATERIALIZER_PROVIDERS, cfg.provider)
        ? cfg.provider
        : "anthropic";
    return { slug, provider, baseUrl: cfg?.baseUrl, model: cfg?.model };
}
function writeAtomic(target, content) {
    const tmp = `${target}.tmp`;
    fs.writeFileSync(tmp, content, { mode: 0o600 });
    fs.renameSync(tmp, target);
}
function removeIfExists(target) {
    if (!fs.existsSync(target))
        return false;
    fs.rmSync(target);
    return true;
}
function removeManagedByotState(slug, dir, markerPath, filePath, preserveAuthProfileStore) {
    if (!fs.existsSync(markerPath))
        return false;
    let changed = false;
    for (const f of BYOT_FILES)
        changed = removeIfExists(filePath(f)) || changed;
    // On a shared (per-agent broker-token) pod the auth-profile store holds the
    // anthropic:default broker token (+ any byosub OAuth) that the materializer owns;
    // tearing down a customer's local BYOT files must NOT delete it.
    if (!preserveAuthProfileStore && readAuthProfileStore(dir) !== null) {
        deleteAuthProfileStore(dir);
        changed = true;
    }
    changed = removeIfExists(markerPath) || changed;
    if (changed)
        log(`[byot-sync] ${slug}: removed BYOT files (BYOT off)`);
    return changed;
}
function desiredByotFiles(input) {
    const cfg = buildModelCredentialConfigForProvider(input);
    return {
        "models.json": cfg.models ? JSON.stringify(cfg.models, null, 2) : null,
    };
}
function writeDesiredByotFiles(desired, filePath) {
    let changed = false;
    for (const f of BYOT_FILES) {
        const target = filePath(f);
        const want = desired[f];
        const existing = fs.existsSync(target) ? fs.readFileSync(target, "utf8") : null;
        if (want == null) {
            changed = removeIfExists(target) || changed;
        }
        else if (existing !== want) {
            writeAtomic(target, want);
            changed = true;
        }
    }
    return changed;
}
function syncAuthProfileStore(dir, input, preserveAuthProfileStore) {
    if (isModelCredentialOauthProvider(input.provider))
        return false;
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
    if (preserveAuthProfileStore || readAuthProfileStore(dir) === null)
        return false;
    deleteAuthProfileStore(dir);
    return true;
}
export function applyByotState(slug, input, agentsDir = AGENTS_DIR, opts = {}) {
    const dir = agentDirForSlug(slug, agentsDir);
    const filePath = (f) => path.join(dir, f);
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
