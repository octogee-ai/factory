import * as path from "node:path";
import * as fs from "node:fs";
import { readAuthProfileStore } from "./auth-profile-store.js";
import { AGENTS_DIR } from "./config.js";
import { createGatewayRpc } from "./gateway-rpc.js";
import { OpenClawSecretsApplyError, applyOpenClawSecretsPlan, authProfileApiKeyTarget, buildOpenClawSecretsPlan, } from "./openclaw-secrets-apply.js";
import { modelCatalogForProvider } from "@octogee/shared/types/model-catalog";
import { parseAgentId } from "@octogee/shared/types/identity";
export { OpenClawSecretsApplyError, applyOpenClawSecretsPlan } from "./openclaw-secrets-apply.js";
// The per-agent broker-token anthropic profile for shared (multi-tenant) pods.
// Each agent's anthropic:default resolves to its OWN owner-scoped broker
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
export const VERTEX_BROKER_PROVIDER_ID = "platform-vertex";
export const VERTEX_BROKER_PROFILE_ID = `${VERTEX_BROKER_PROVIDER_ID}:default`;
const VERTEX_PLATFORM_MARKER = ".platform-vertex-managed";
export const META_BROKER_PROVIDER_ID = "platform-meta";
export const META_BROKER_PROFILE_ID = "platform-meta:default";
const META_PLATFORM_MARKER = ".platform-meta-managed";
const QUIET_NON_BROKER_AGENT_IDS = new Set(["octogee-unmatched-route"]);
function isBrokerResolvableAgentId(agentId) {
    return parseAgentId(agentId).kind !== "unknown";
}
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
export function openRouterBrokerModelConfig(input) {
    return {
        id: input.model,
        name: input.model,
        ...(typeof input.contextTokens === "number"
            ? { contextTokens: input.contextTokens, contextWindow: input.contextTokens }
            : {}),
        ...(input.input ? { input: [...input.input] } : {}),
        ...(input.maxOutputTokens !== undefined ? { maxTokens: input.maxOutputTokens } : {}),
        ...(input.reasoning !== undefined ? { reasoning: input.reasoning } : {}),
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
export function metaBrokerProfileEntry(agentId) {
    return {
        type: "api_key",
        provider: META_BROKER_PROVIDER_ID,
        keyRef: {
            source: "exec",
            provider: SECRET_RESOLVER_PROVIDER,
            id: agentModelTokenSecretId(agentId, "meta"),
        },
    };
}
export function vertexBrokerProfileEntry(agentId) {
    return {
        type: "api_key",
        provider: VERTEX_BROKER_PROVIDER_ID,
        keyRef: {
            source: "exec",
            provider: SECRET_RESOLVER_PROVIDER,
            id: agentModelTokenSecretId(agentId, "vertex"),
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
            ...(entry.input ? { input: entry.input } : {}),
            ...(entry.maxOutputTokens !== undefined ? { maxOutputTokens: entry.maxOutputTokens } : {}),
            ...(entry.reasoning !== undefined ? { reasoning: entry.reasoning } : {}),
        })),
    };
}
export function openAiCatalogInputForBaseUrl(baseUrl) {
    return {
        baseUrl,
        models: modelCatalogForProvider("openai").map((entry) => ({
            model: entry.id,
            ...(typeof entry.contextTokens === "number" ? { contextTokens: entry.contextTokens } : {}),
            ...(entry.input ? { input: entry.input } : {}),
            ...(entry.maxOutputTokens !== undefined ? { maxOutputTokens: entry.maxOutputTokens } : {}),
            ...(entry.reasoning !== undefined ? { reasoning: entry.reasoning } : {}),
        })),
    };
}
export function metaCatalogInputForBaseUrl(baseUrl) {
    return {
        baseUrl,
        models: modelCatalogForProvider("meta").map((entry) => ({
            model: entry.id,
            ...(typeof entry.contextTokens === "number" ? { contextTokens: entry.contextTokens } : {}),
            ...(entry.input ? { input: entry.input } : {}),
            ...(entry.maxOutputTokens !== undefined ? { maxOutputTokens: entry.maxOutputTokens } : {}),
            ...(entry.reasoning !== undefined ? { reasoning: entry.reasoning } : {}),
        })),
    };
}
export function vertexCatalogInputForBaseUrl(baseUrl) {
    return {
        baseUrl,
        models: modelCatalogForProvider("vertex").map((entry) => ({
            model: entry.id.replace(/^vertex\//, ""),
            ...(typeof entry.contextTokens === "number" ? { contextTokens: entry.contextTokens } : {}),
            ...(entry.input ? { input: entry.input } : {}),
            ...(entry.maxOutputTokens !== undefined ? { maxOutputTokens: entry.maxOutputTokens } : {}),
            ...(entry.reasoning !== undefined ? { reasoning: entry.reasoning } : {}),
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
                models: input.models.map(openRouterBrokerModelConfig),
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
 * anthropic-BYOK primary for plain users and the Haiku-fallback credential
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
        ...(surfaces.meta
            ? [{
                    profileId: META_BROKER_PROFILE_ID,
                    provider: META_BROKER_PROVIDER_ID,
                    entry: metaBrokerProfileEntry(agentId),
                }]
            : []),
        ...(surfaces.vertex
            ? [{
                    profileId: VERTEX_BROKER_PROFILE_ID,
                    provider: VERTEX_BROKER_PROVIDER_ID,
                    entry: vertexBrokerProfileEntry(agentId),
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
export async function missingPlatformBrokerProfileTargets(agentDir, agentId, surfaces) {
    const profiles = asRecord(asRecord(await readAuthProfileStore(agentDir)).profiles);
    return desiredPlatformBrokerProfiles(agentId, surfaces)
        .filter((desire) => !profileRefMatches(profiles[desire.profileId], desire))
        .map((desire) => profileTarget(agentId, desire));
}
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
        marker: OPENROUTER_PLATFORM_MARKER,
        api: "openai-completions",
    });
}
export function upsertOpenAiBrokerCatalog(agentDir, input) {
    return upsertPlatformBrokerCatalog(agentDir, input, {
        providerId: OPENAI_BROKER_PROVIDER_ID,
        marker: OPENAI_PLATFORM_MARKER,
        api: "openai-responses",
    });
}
export function upsertMetaBrokerCatalog(agentDir, input) {
    return upsertPlatformBrokerCatalog(agentDir, input, {
        providerId: META_BROKER_PROVIDER_ID,
        marker: META_PLATFORM_MARKER,
        api: "openai-responses",
    });
}
export function upsertVertexBrokerCatalog(agentDir, input) {
    return upsertPlatformBrokerCatalog(agentDir, input, {
        providerId: VERTEX_BROKER_PROVIDER_ID,
        marker: VERTEX_PLATFORM_MARKER,
        api: "anthropic-messages",
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
        api: ids.api,
        baseUrl: input.baseUrl,
        models: input.models.map((model) => openRouterBrokerModelConfig(model)),
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
async function prepareAgentMaterialization(agentId, agentsDir, opts) {
    const agentHome = path.join(agentsDir, agentId, "agent");
    const catalogWrote = opts.openRouter
        ? upsertOpenRouterBrokerCatalog(agentHome, opts.openRouter)
        : false;
    const openAiWrote = opts.openAi
        ? upsertOpenAiBrokerCatalog(agentHome, opts.openAi)
        : false;
    const vertexWrote = opts.vertex
        ? upsertVertexBrokerCatalog(agentHome, opts.vertex)
        : false;
    return {
        agentId,
        catalogWrote,
        openAiWrote,
        vertexWrote,
        metaWrote: opts.meta ? upsertMetaBrokerCatalog(agentHome, opts.meta) : false,
        missingProfiles: await missingPlatformBrokerProfileTargets(agentHome, agentId, {
            openRouter: opts.openRouter !== undefined,
            openAi: opts.openAi !== undefined,
            vertex: opts.vertex !== undefined,
            meta: opts.meta !== undefined,
        }),
    };
}
async function prepareAgentMaterializations(agentIds, agentsDir, opts) {
    const agents = [];
    const deferred = [];
    let deferralReason;
    for (const agentId of new Set(agentIds)) {
        if (!isBrokerResolvableAgentId(agentId)) {
            if (!QUIET_NON_BROKER_AGENT_IDS.has(agentId)) {
                opts.logFn?.(`[agent-model-token] skipping ${agentId} — not a canonical workspace or project agent id`);
            }
            continue;
        }
        try {
            agents.push(await prepareAgentMaterialization(agentId, agentsDir, { ...opts, agentsDir }));
        }
        catch (error) {
            const reason = error instanceof Error ? error.message : String(error);
            opts.logFn?.(`⚠ [agent-model-token] model-ready materialize failed for ${agentId}: ${reason}`);
            deferred.push(agentId);
            deferralReason ??= reason;
        }
    }
    return { agents, deferred, ...(deferralReason ? { deferralReason } : {}) };
}
async function applySecretsTargets(targets, opts) {
    await applyOpenClawSecretsPlan(buildOpenClawSecretsPlan(targets), {
        ...opts.secretsApply,
        apply: opts.secretsApply?.apply ?? (async (plan) => {
            const rpc = createGatewayRpc({ allowLegacyGatewayTokenFallback: true });
            try {
                await rpc.brokerProfilesMaterialize({ agentIds: [...new Set(plan.targets.map((target) => target.agentId))] });
            }
            catch (error) {
                throw new OpenClawSecretsApplyError(error instanceof Error ? error.message : String(error), null);
            }
            finally {
                await rpc.close();
            }
        }),
        log: opts.secretsApply?.log ?? opts.logFn,
    });
}
function errorReason(error) {
    return error instanceof Error ? error.message : String(error);
}
async function applyAgentMaterializationsIndividually(agents, opts) {
    const appliedAgentIds = new Set();
    const deferred = [];
    let deferralReason;
    for (const agent of agents) {
        try {
            await applySecretsTargets(agent.missingProfiles, opts);
            appliedAgentIds.add(agent.agentId);
        }
        catch (error) {
            const reason = errorReason(error);
            opts.logFn?.(`⚠ [agent-model-token] broker profile deferred for ${agent.agentId} — openclaw refused its secrets apply: ${reason}`);
            deferred.push(agent.agentId);
            deferralReason ??= reason;
        }
    }
    return {
        appliedAgentIds,
        deferred,
        ...(deferralReason ? { deferralReason } : {}),
    };
}
async function applyAgentMaterializations(agents, opts) {
    const pending = agents.filter((agent) => agent.missingProfiles.length > 0);
    if (pending.length === 0)
        return { appliedAgentIds: new Set(), deferred: [] };
    try {
        await applySecretsTargets(pending.flatMap((agent) => agent.missingProfiles), opts);
        return { appliedAgentIds: new Set(pending.map((agent) => agent.agentId)), deferred: [] };
    }
    catch (error) {
        if (error instanceof OpenClawSecretsApplyError && pending.length > 1) {
            return applyAgentMaterializationsIndividually(pending, opts);
        }
        const reason = errorReason(error);
        if (!(error instanceof OpenClawSecretsApplyError)) {
            opts.logFn?.(`⚠ [agent-model-token] model-ready secrets apply failed: ${reason}`);
        }
        return {
            appliedAgentIds: new Set(),
            deferred: pending.map((agent) => agent.agentId),
            deferralReason: reason,
        };
    }
}
function profileMaterializationState(agent, profilesApplied) {
    if (agent.missingProfiles.length === 0)
        return "ok";
    return profilesApplied ? "applied" : "deferred";
}
function reportAgentMaterializations(agents, appliedAgentIds, opts) {
    let materialized = 0;
    for (const agent of agents) {
        const profilesApplied = appliedAgentIds.has(agent.agentId);
        const profileWrote = profilesApplied && agent.missingProfiles.length > 0;
        if (!profileWrote && !agent.catalogWrote && !agent.openAiWrote && !agent.vertexWrote && !agent.metaWrote)
            continue;
        materialized++;
        opts.logFn?.(`[agent-model-token] model-ready: ${agent.agentId}` +
            ` (profiles ${profileMaterializationState(agent, profilesApplied)},` +
            ` openrouter ${catalogState(opts.openRouter, agent.catalogWrote)},` +
            ` openai ${catalogState(opts.openAi, agent.openAiWrote)},` +
            ` vertex ${catalogState(opts.vertex, agent.vertexWrote)},` +
            ` meta ${catalogState(opts.meta, agent.metaWrote)})`);
    }
    return materialized;
}
/**
 * Model-ready sweep: assert every broker provider surface per agent — the
 * platform auth profiles AND the OpenRouter/OpenAI catalogs (when the broker's
 * base URLs are configured). After this, switching any agent to any catalog
 * model is a pure roster flip. Tolerant — a failure on one agent never aborts
 * the sweep.
 */
export async function materializeBrokerProfilesForAgents(agentIds, opts = {}) {
    const agentsDir = opts.agentsDir ?? AGENTS_DIR;
    const prepared = await prepareAgentMaterializations(agentIds, agentsDir, opts);
    const applied = await applyAgentMaterializations(prepared.agents, opts);
    const materialized = reportAgentMaterializations(prepared.agents, applied.appliedAgentIds, opts);
    const deferralReason = prepared.deferralReason ?? applied.deferralReason;
    return {
        materialized,
        deferred: [...prepared.deferred, ...applied.deferred],
        ...(deferralReason ? { deferralReason } : {}),
    };
}
