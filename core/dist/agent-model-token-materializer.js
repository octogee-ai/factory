import * as path from "node:path";
import * as fs from "node:fs";
import { readAuthProfileStore } from "./auth-profile-sqlite.js";
import { AGENTS_DIR } from "./config.js";
import { OpenClawSecretsApplyError, applyOpenClawSecretsPlan, authProfileApiKeyTarget, buildOpenClawSecretsPlan, } from "./openclaw-secrets-apply.js";
import { modelCatalogForProvider } from "@octogee/shared/types/model-catalog";
// The per-agent broker-token anthropic profile for shared (multi-tenant) pods.
// Each customer-agent's anthropic:default resolves to its OWN owner-scoped broker
// token (the secret-resolver fetches it via POST /internal/byok/agent-model-token);
// the broker then resolves platform-or-BYOK per owner. The id is the static
// `agent-model-token-<agentId>` the resolver grammar pins (AGENT_MODEL_TOKEN_ID_RE).
const SECRET_RESOLVER_PROVIDER = "gcp-secret-manager";
const ANTHROPIC_DEFAULT_PROFILE_ID = "anthropic:default";
export const OPENROUTER_BROKER_PROVIDER_ID = "platform-openrouter";
export const OPENROUTER_BROKER_PROFILE_ID = `${OPENROUTER_BROKER_PROVIDER_ID}:default`;
const OPENROUTER_PLATFORM_MARKER = ".platform-openrouter-managed";
export const OPENAI_BROKER_PROVIDER_ID = "platform-openai";
export const OPENAI_BROKER_PROFILE_ID = `${OPENAI_BROKER_PROVIDER_ID}:default`;
const OPENAI_PLATFORM_MARKER = ".platform-openai-managed";
// Only octogee-<slug>-coach agents have a broker-token resolver grammar
// (AGENT_MODEL_TOKEN_ID_RE in secret-resolver.mjs). The boot sweep must skip any
// other agent id rather than write a profile whose keyRef the resolver will refuse
// — fail closed (the agent surfaces a missing-key error) instead of stranding it
// with an unresolvable credential.
const COACH_AGENT_RE = /^octogee-[a-z0-9][a-z0-9-]{0,62}-coach$/;
export function agentModelTokenSecretId(agentId, provider = "anthropic") {
    if (provider === "anthropic")
        return `agent-model-token-${agentId}`;
    return `agent-model-token-${provider}-${agentId}`;
}
export function openRouterBrokerProviderConfig(input) {
    return {
        api: "openai-completions",
        baseUrl: input.baseUrl,
        apiKey: input.apiKey,
        models: [
            openRouterBrokerModelConfig(input),
        ],
    };
}
function openRouterBrokerModelConfig(input) {
    return {
        id: input.model,
        name: input.model,
        ...(typeof input.contextTokens === "number"
            ? { contextTokens: input.contextTokens, contextWindow: input.contextTokens }
            : {}),
    };
}
export function agentModelTokenProfileEntry(agentId) {
    return {
        type: "api_key",
        provider: "anthropic",
        keyRef: {
            source: "exec",
            provider: SECRET_RESOLVER_PROVIDER,
            id: agentModelTokenSecretId(agentId, "anthropic"),
        },
    };
}
export function openRouterBrokerProfileEntry(agentId) {
    return {
        type: "api_key",
        provider: OPENROUTER_BROKER_PROVIDER_ID,
        keyRef: {
            source: "exec",
            provider: SECRET_RESOLVER_PROVIDER,
            id: agentModelTokenSecretId(agentId, "openrouter"),
        },
    };
}
export function openAiBrokerProfileEntry(agentId) {
    return {
        type: "api_key",
        provider: OPENAI_BROKER_PROVIDER_ID,
        keyRef: {
            source: "exec",
            provider: SECRET_RESOLVER_PROVIDER,
            id: agentModelTokenSecretId(agentId, "openai"),
        },
    };
}
export function openRouterBrokerModelsJson(agentId, input) {
    return openRouterBrokerCatalogJson(agentId, {
        baseUrl: input.baseUrl,
        models: [input],
    });
}
export function openRouterCatalogInputForBaseUrl(baseUrl) {
    return {
        baseUrl,
        models: modelCatalogForProvider("openrouter").map((entry) => ({
            model: entry.id,
            ...(typeof entry.contextTokens === "number" ? { contextTokens: entry.contextTokens } : {}),
        })),
    };
}
export function openAiCatalogInputForBaseUrl(baseUrl) {
    return {
        baseUrl,
        models: modelCatalogForProvider("openai").map((entry) => ({
            model: entry.id,
            ...(typeof entry.contextTokens === "number" ? { contextTokens: entry.contextTokens } : {}),
        })),
    };
}
// Model-readiness: every catalog OpenRouter model rides ONE provider entry
// backed by the agent's own broker token — "/models switch" needs no further
// provider surgery, and the broker's plan policy gates what actually serves.
export function openRouterBrokerCatalogJson(_agentId, input) {
    return {
        providers: {
            [OPENROUTER_BROKER_PROVIDER_ID]: {
                api: "openai-completions",
                baseUrl: input.baseUrl,
                apiKey: OPENROUTER_BROKER_PROFILE_ID,
                models: input.models.map((model) => openRouterBrokerModelConfig({ ...model, baseUrl: input.baseUrl })),
            },
        },
    };
}
function asRecord(value) {
    return value && typeof value === "object" && !Array.isArray(value)
        ? value
        : {};
}
/**
 * The per-agent platform profiles, each pinned to its own owner-scoped broker
 * token. `anthropic:default` is always the broker token: the platform /
 * anthropic-BYOK primary for plain customers and the Haiku-fallback credential
 * for BYOS or non-anthropic-BYOK ones.
 */
function desiredPlatformBrokerProfiles(agentId, surfaces) {
    return [
        {
            profileId: ANTHROPIC_DEFAULT_PROFILE_ID,
            provider: "anthropic",
            entry: agentModelTokenProfileEntry(agentId),
        },
        ...(surfaces.openRouter
            ? [{
                    profileId: OPENROUTER_BROKER_PROFILE_ID,
                    provider: OPENROUTER_BROKER_PROVIDER_ID,
                    entry: openRouterBrokerProfileEntry(agentId),
                }]
            : []),
        ...(surfaces.openAi
            ? [{
                    profileId: OPENAI_BROKER_PROFILE_ID,
                    provider: OPENAI_BROKER_PROVIDER_ID,
                    entry: openAiBrokerProfileEntry(agentId),
                }]
            : []),
    ];
}
function profileTarget(agentId, desire) {
    return authProfileApiKeyTarget({
        agentId,
        profileId: desire.profileId,
        provider: desire.provider,
        refId: desire.entry.keyRef.id,
    });
}
export function platformBrokerProfileTargets(agentId, surfaces) {
    return desiredPlatformBrokerProfiles(agentId, surfaces).map((desire) => profileTarget(agentId, desire));
}
/** The store is read-only to us — openclaw's `secrets apply` is the only writer.
 *  Reading it keeps the sweep from spawning the CLI once everything has settled. */
export function missingPlatformBrokerProfileTargets(agentDir, agentId, surfaces) {
    const profiles = asRecord(asRecord(readAuthProfileStore(agentDir)).profiles);
    return desiredPlatformBrokerProfiles(agentId, surfaces)
        .filter((desire) => !profileRefMatches(profiles[desire.profileId], desire))
        .map((desire) => profileTarget(agentId, desire));
}
/** openclaw stores the resolved key alongside the ref, so an applied profile is
 *  never byte-equal to the desired entry — the ref identity is what settles it. */
function profileRefMatches(stored, desire) {
    const profile = asRecord(stored);
    return (profile.type === "api_key" &&
        profile.provider === desire.provider &&
        asRecord(profile.keyRef).id === desire.entry.keyRef.id);
}
function readJsonFile(pathname) {
    if (!fs.existsSync(pathname))
        return {};
    try {
        const parsed = JSON.parse(fs.readFileSync(pathname, "utf8"));
        return asRecord(parsed);
    }
    catch {
        return {};
    }
}
function writeJsonFile(pathname, value) {
    fs.mkdirSync(path.dirname(pathname), { recursive: true, mode: 0o700 });
    fs.writeFileSync(pathname, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}
export function upsertOpenRouterBrokerModel(agentDir, input) {
    return upsertOpenRouterBrokerCatalog(agentDir, {
        baseUrl: input.baseUrl,
        models: [input],
    });
}
export function upsertOpenRouterBrokerCatalog(agentDir, input) {
    return upsertPlatformBrokerCatalog(agentDir, input, {
        providerId: OPENROUTER_BROKER_PROVIDER_ID,
        profileId: OPENROUTER_BROKER_PROFILE_ID,
        marker: OPENROUTER_PLATFORM_MARKER,
    });
}
export function upsertOpenAiBrokerCatalog(agentDir, input) {
    return upsertPlatformBrokerCatalog(agentDir, input, {
        providerId: OPENAI_BROKER_PROVIDER_ID,
        profileId: OPENAI_BROKER_PROFILE_ID,
        marker: OPENAI_PLATFORM_MARKER,
    });
}
/** The catalog is plain filesystem state and must land whatever the profile
 *  write does: models.json is what makes the model KNOWN to openclaw, and an
 *  unknown model fails the turn outright. */
function upsertPlatformBrokerCatalog(agentDir, input, ids) {
    const modelsPath = path.join(agentDir, "models.json");
    const markerPath = path.join(agentDir, ids.marker);
    const current = readJsonFile(modelsPath);
    const currentProviders = asRecord(current.providers);
    const desired = {
        api: "openai-completions",
        baseUrl: input.baseUrl,
        apiKey: ids.profileId,
        models: input.models.map((model) => openRouterBrokerModelConfig({ ...model, baseUrl: input.baseUrl })),
    };
    const next = {
        ...current,
        providers: {
            ...currentProviders,
            [ids.providerId]: desired,
        },
    };
    const changed = JSON.stringify(current) !== JSON.stringify(next) || !fs.existsSync(markerPath);
    if (!changed)
        return false;
    writeJsonFile(modelsPath, next);
    fs.writeFileSync(markerPath, `${new Date().toISOString()}\n`, { mode: 0o600 });
    return true;
}
export function removeOpenRouterBrokerModel(agentDir) {
    const markerPath = path.join(agentDir, OPENROUTER_PLATFORM_MARKER);
    if (!fs.existsSync(markerPath))
        return false;
    const modelsPath = path.join(agentDir, "models.json");
    if (fs.existsSync(modelsPath)) {
        const current = readJsonFile(modelsPath);
        const providers = asRecord(current.providers);
        if (Object.prototype.hasOwnProperty.call(providers, OPENROUTER_BROKER_PROVIDER_ID)) {
            Reflect.deleteProperty(providers, OPENROUTER_BROKER_PROVIDER_ID);
            const next = Object.keys(providers).length === 0
                ? Object.fromEntries(Object.entries(current).filter(([key]) => key !== "providers"))
                : { ...current, providers };
            if (Object.keys(next).length === 0) {
                fs.rmSync(modelsPath);
            }
            else {
                writeJsonFile(modelsPath, next);
            }
        }
    }
    fs.rmSync(markerPath);
    return true;
}
function catalogState(configured, wrote) {
    if (!configured)
        return "unconfigured";
    return wrote ? "written" : "ok";
}
function applyMissingPlatformBrokerProfiles(agentHome, agentId, opts) {
    const missing = missingPlatformBrokerProfileTargets(agentHome, agentId, {
        openRouter: opts.openRouter !== undefined,
        openAi: opts.openAi !== undefined,
    });
    if (missing.length === 0)
        return { wrote: false };
    try {
        applyOpenClawSecretsPlan(buildOpenClawSecretsPlan(missing), opts.secretsApply ?? {});
        return { wrote: true };
    }
    catch (error) {
        if (!(error instanceof OpenClawSecretsApplyError))
            throw error;
        return { wrote: false, deferralReason: error.message };
    }
}
function materializeOneAgent(agentId, agentsDir, opts) {
    const agentHome = path.join(agentsDir, agentId, "agent");
    const catalog = opts.openRouter
        ? upsertOpenRouterBrokerCatalog(agentHome, opts.openRouter)
        : false;
    const openAi = opts.openAi
        ? upsertOpenAiBrokerCatalog(agentHome, opts.openAi)
        : false;
    const profiles = applyMissingPlatformBrokerProfiles(agentHome, agentId, opts);
    const wrote = profiles.wrote || catalog || openAi;
    if (wrote) {
        opts.logFn?.(`[agent-model-token] model-ready: ${agentId}` +
            ` (profiles ${profiles.wrote ? "applied" : "ok"},` +
            ` openrouter ${catalogState(opts.openRouter, catalog)},` +
            ` openai ${catalogState(opts.openAi, openAi)})`);
    }
    return { wrote, ...(profiles.deferralReason ? { deferralReason: profiles.deferralReason } : {}) };
}
/**
 * Model-ready sweep: assert every broker provider surface per agent — the
 * platform auth profiles AND the OpenRouter/OpenAI catalogs (when the broker's
 * base URLs are configured). After this, switching any agent to any catalog
 * model is a pure roster flip. Tolerant — a failure on one agent never aborts
 * the sweep.
 */
export function materializeBrokerProfilesForAgents(agentIds, opts = {}) {
    const agentsDir = opts.agentsDir ?? AGENTS_DIR;
    let materialized = 0;
    let deferralReason;
    const deferred = [];
    for (const agentId of agentIds) {
        if (!COACH_AGENT_RE.test(agentId)) {
            opts.logFn?.(`[agent-model-token] skipping ${agentId} — only octogee-<slug>-coach agents are broker-token resolvable`);
            continue;
        }
        try {
            const result = materializeOneAgent(agentId, agentsDir, { ...opts, agentsDir });
            if (result.wrote)
                materialized++;
            if (result.deferralReason) {
                deferred.push(agentId);
                deferralReason ??= result.deferralReason;
            }
        }
        catch (e) {
            opts.logFn?.(`⚠ [agent-model-token] model-ready materialize failed for ${agentId}: ${e.message}`);
        }
    }
    return { materialized, deferred, ...(deferralReason ? { deferralReason } : {}) };
}
