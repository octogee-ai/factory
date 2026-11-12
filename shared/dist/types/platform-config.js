import { SIMPLE_MODEL_TIERS, catalogEntryForModelRef } from "./agent-models.js";
export const DEFAULT_DISPOSABLE_GATEWAY_IDLE_MS = 15 * 60_000;
// Operator dials for platform-wide model policy, stored at platformConfig/models
// (server-only collection; admin reads/writes go through the API). Absent or
// invalid doc → the compiled default below, so the free tier always has a
// resolvable house pin.
export const PLATFORM_CONFIG_COLLECTION = "platformConfig";
export const PLATFORM_MODEL_CONFIG_DOC = "models";
export const PLATFORM_CONNECT_CONFIG_DOC = "connect";
export const PLATFORM_FREE_CONFIG_DOC = "free";
export const DEFAULT_PLATFORM_FREE_CONFIG = {
    schemaVersion: 1,
    workspaceStorageGb: 10,
};
export function parsePlatformFreeConfig(value) {
    if (!value || typeof value !== "object" || Array.isArray(value))
        return null;
    const raw = value;
    if (raw.schemaVersion !== 1 ||
        typeof raw.workspaceStorageGb !== "number" ||
        !Number.isFinite(raw.workspaceStorageGb) ||
        raw.workspaceStorageGb <= 0 ||
        raw.workspaceStorageGb > 1000 ||
        (raw.updatedBy !== undefined && typeof raw.updatedBy !== "string")) {
        return null;
    }
    return {
        schemaVersion: 1,
        workspaceStorageGb: raw.workspaceStorageGb,
        ...(raw.updatedAt !== undefined ? { updatedAt: raw.updatedAt } : {}),
        ...(raw.updatedBy !== undefined ? { updatedBy: raw.updatedBy } : {}),
    };
}
export const GOOGLE_CONNECT_STAGES = ["off", "allowlist", "on"];
export const GOOGLE_CONNECT_CAPABILITY_KEYS = [
    "calendar",
    "gmail",
    "drive",
    "drive-full",
    "tasks",
    "contacts",
];
export const DEFAULT_PLATFORM_CONNECT_CONFIG = {
    googleStages: {
        calendar: "off",
        gmail: "off",
        drive: "off",
        "drive-full": "off",
        tasks: "off",
        contacts: "off",
    },
    googleAllowlistUids: [],
};
export function isGoogleConnectCapabilityKey(value) {
    return GOOGLE_CONNECT_CAPABILITY_KEYS.includes(value);
}
function isGoogleConnectStage(value) {
    return GOOGLE_CONNECT_STAGES.includes(value);
}
export function parseGoogleConnectStages(value) {
    if (!value || typeof value !== "object" || Array.isArray(value))
        return null;
    const raw = value;
    if (!Object.keys(raw).every(isGoogleConnectCapabilityKey))
        return null;
    const stages = {};
    for (const key of GOOGLE_CONNECT_CAPABILITY_KEYS) {
        const stage = raw[key];
        if (!isGoogleConnectStage(stage))
            return null;
        stages[key] = stage;
    }
    return stages;
}
export function parsePlatformConnectConfig(value) {
    if (!value || typeof value !== "object" || Array.isArray(value))
        return null;
    const { googleStages, googleAllowlistUids } = value;
    const stages = parseGoogleConnectStages(googleStages);
    if (!stages)
        return null;
    if (googleAllowlistUids !== undefined) {
        if (!Array.isArray(googleAllowlistUids))
            return null;
        if (googleAllowlistUids.some((uid) => typeof uid !== "string"))
            return null;
    }
    const uids = (googleAllowlistUids ?? [])
        .map((uid) => uid.trim())
        .filter((uid) => uid.length > 0);
    return { googleStages: stages, googleAllowlistUids: uids };
}
export function googleCapabilityConnectAllowed(config, uid, capability) {
    if (!config || uid.length === 0)
        return false;
    const stage = config.googleStages[capability];
    if (stage === "on")
        return true;
    if (stage === "allowlist")
        return config.googleAllowlistUids.includes(uid);
    return false;
}
export function googleConnectAllowed(config, uid) {
    return GOOGLE_CONNECT_CAPABILITY_KEYS.some((capability) => googleCapabilityConnectAllowed(config, uid, capability));
}
export function googleConsentPermission(config, uid, requested) {
    const permitted = [];
    const excluded = [];
    for (const capability of requested) {
        (googleCapabilityConnectAllowed(config, uid, capability) ? permitted : excluded).push(capability);
    }
    return { permitted, excluded };
}
// The house model compiles to the Errands tier on the OpenAI platform
// key; the dial can point anywhere in the catalog.
export const DEFAULT_HOUSE_MODEL_REF = SIMPLE_MODEL_TIERS.errands.ref;
export const DEFAULT_OPS_AGENT_MODEL_REF = "platform-openrouter/openai/gpt-6-luna";
// The platform default every user's Agent starts on until they pick their
// own model in Account → Models: the Everyday tier. Fallback ref null = no fallback.
export const DEFAULT_USER_AGENT_MODEL_REF = SIMPLE_MODEL_TIERS.everyday.ref;
export const DEFAULT_USER_AGENT_FALLBACK_MODEL_REF = "platform-openrouter/z-ai/glm-5.2";
function catalogRefOrNull(value) {
    return typeof value === "string" && resolveHouseModel(value) !== null ? value : null;
}
export function parsePlatformModelConfig(value) {
    if (!value || typeof value !== "object" || Array.isArray(value))
        return null;
    const config = value;
    const freeTierModelRef = catalogRefOrNull(config.freeTierModelRef);
    if (freeTierModelRef === null)
        return null;
    const opsAgentModelRef = config.opsAgentModelRef ?? DEFAULT_OPS_AGENT_MODEL_REF;
    if (typeof opsAgentModelRef !== "string" || resolveOpsAgentModel(opsAgentModelRef) === null) {
        return null;
    }
    const builderAgentModelRef = catalogRefOrNull(config.builderAgentModelRef ?? DEFAULT_USER_AGENT_MODEL_REF);
    if (builderAgentModelRef === null)
        return null;
    const fallbackInput = config.builderAgentFallbackModelRef === undefined
        ? DEFAULT_USER_AGENT_FALLBACK_MODEL_REF
        : config.builderAgentFallbackModelRef;
    const builderAgentFallbackModelRef = fallbackInput === null ? null : catalogRefOrNull(fallbackInput);
    if (fallbackInput !== null && builderAgentFallbackModelRef === null)
        return null;
    return {
        freeTierModelRef,
        opsAgentModelRef,
        builderAgentModelRef,
        builderAgentFallbackModelRef,
    };
}
// The {primary, fallbacks} selection every user agent inherits, from the
// stored platformConfig/models doc. Field-tolerant: an absent or invalid ref
// falls back to the compiled default so a bad doc can never blank the fleet.
export function userAgentModelDefaultFromDoc(data) {
    const raw = (data ?? {});
    const primary = catalogRefOrNull(raw.builderAgentModelRef) ?? DEFAULT_USER_AGENT_MODEL_REF;
    const fallbackRef = raw.builderAgentFallbackModelRef === null
        ? null
        : catalogRefOrNull(raw.builderAgentFallbackModelRef) ?? DEFAULT_USER_AGENT_FALLBACK_MODEL_REF;
    return {
        primary,
        fallbacks: fallbackRef !== null && fallbackRef !== primary ? [fallbackRef] : [],
    };
}
// Strict payload validation for the untrusted side of the sync wire: the pod
// applies the default only when the trusted stamp arrives whole and every ref
// resolves in the catalog; anything else means "leave the config default".
export function parseUserAgentModelDefault(value) {
    if (!value || typeof value !== "object" || Array.isArray(value))
        return null;
    const raw = value;
    if (typeof raw.primary !== "string" || resolveHouseModel(raw.primary) === null)
        return null;
    if (!Array.isArray(raw.fallbacks))
        return null;
    const fallbacks = [];
    for (const ref of raw.fallbacks) {
        if (typeof ref !== "string" || resolveHouseModel(ref) === null)
            return null;
        fallbacks.push(ref);
    }
    return { primary: raw.primary, fallbacks };
}
// Split a catalog model ref into what each dial consumer needs: the broker
// provider profile the traffic rides, and the model id the upstream API
// accepts (anthropic entries are catalog-prefixed; the wire wants the bare id).
export function resolveHouseModel(ref) {
    const entry = catalogEntryForModelRef(ref);
    if (!entry)
        return null;
    return {
        ref,
        provider: entry.provider,
        upstreamModelId: entry.provider === "anthropic" || entry.provider === "vertex"
            ? entry.id.replace(`${entry.provider}/`, "")
            : entry.id,
    };
}
export function resolveOpsAgentModel(ref) {
    const resolved = resolveHouseModel(ref);
    if (!resolved || resolved.provider !== "openrouter")
        return null;
    return {
        ...resolved,
        runtimeModelRef: `openrouter/${resolved.upstreamModelId}`,
    };
}
