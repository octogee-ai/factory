import { createServiceLogger } from "@octogee/shared/server/service-logger";
import { GATEWAY_VM_PROVISIONING_MODELS, isGatewayVmBootDiskType, isGatewayVmDesktop, } from "@octogee/shared/types/glm";
import { DEFAULT_USER_AGENT_FALLBACK_MODEL_REF, DEFAULT_USER_AGENT_MODEL_REF, DEFAULT_FREE_TIER_MODEL_REF, DEFAULT_OPS_AGENT_MODEL_REF, parsePlatformConnectConfig, parsePlatformFreeConfig, parsePlatformModelConfig, PLATFORM_CONFIG_COLLECTION, } from "@octogee/shared/types/platform-config";
import { parseSharedGatewayAutoscalingConfig } from "@octogee/shared/types/shared-gateway-pool";
import { isSizingTier } from "@octogee/shared/types/sizing";
import { MalformedRecordError, MissingRecordError } from "../errors.js";
import { assertRevisionFence } from "./fences.js";
import { decodeDocumentData, encodeDocument, encodePatch, isClearField, revisionOf, STORED_AS_NUMBERS, storedAsTimestamps, } from "./values.js";
const ORCHESTRATOR_CONFIG_PATH = "config/orchestrator";
const WRITER_QUIESCENCE_PATH = "config/platformMigrationWriterQuiescence";
const MATTERMOST_ADMIN_PATH = "system/mattermostAdmin";
const PLATFORM_CONFIG_KEYS = ["models", "free", "connect"];
export function parseStoredPlatformModelConfig(value) {
    if (typeof value !== "object" || value === null || Array.isArray(value))
        return null;
    const { freeTierModelRef = DEFAULT_FREE_TIER_MODEL_REF, opsAgentModelRef = DEFAULT_OPS_AGENT_MODEL_REF, builderAgentModelRef = DEFAULT_USER_AGENT_MODEL_REF, builderAgentFallbackModelRef = DEFAULT_USER_AGENT_FALLBACK_MODEL_REF, } = value;
    if (typeof freeTierModelRef !== "string" || typeof opsAgentModelRef !== "string" || typeof builderAgentModelRef !== "string") {
        return null;
    }
    if (builderAgentFallbackModelRef !== null && typeof builderAgentFallbackModelRef !== "string")
        return null;
    return { freeTierModelRef, opsAgentModelRef, builderAgentModelRef, builderAgentFallbackModelRef };
}
const PLATFORM_CONFIG_READ_PARSERS = {
    models: parseStoredPlatformModelConfig,
    free: parsePlatformFreeConfig,
    connect: parsePlatformConnectConfig,
};
const PLATFORM_CONFIG_WRITE_PARSERS = {
    models: parsePlatformModelConfig,
    free: parsePlatformFreeConfig,
    connect: parsePlatformConnectConfig,
};
const UPDATED_AT_TIMESTAMP = storedAsTimestamps("updatedAt");
const ORCHESTRATOR_KEY = { aggregate: "orchestrator-config", key: "orchestrator" };
const WRITER_QUIESCENCE_KEY = { aggregate: "writer-quiescence", key: "platformMigrationWriterQuiescence" };
const MATTERMOST_ADMIN_KEY = { aggregate: "mattermost-admin", key: "mattermostAdmin" };
const platformKey = (key) => ({ aggregate: "platform-config", key });
const logger = createServiceLogger("platform-state");
function isPlainMap(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}
function isNonNegativeSafeInteger(value) {
    return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
function withoutClearedFields(patch) {
    return Object.fromEntries(Object.entries(patch).filter(([, value]) => !isClearField(value)));
}
function isVmProfile(value) {
    if (!isPlainMap(value))
        return false;
    const { runtime, desktop, machineType, provisioningModel, bootDisk, homeSizeGiB } = value;
    return (runtime === "gce-vm" &&
        isGatewayVmDesktop(desktop) &&
        (machineType === null || typeof machineType === "string") &&
        (provisioningModel === null || GATEWAY_VM_PROVISIONING_MODELS.includes(provisioningModel)) &&
        (bootDisk === null ||
            (isPlainMap(bootDisk) && typeof bootDisk.sizeGb === "number" && isGatewayVmBootDiskType(bootDisk.type))) &&
        typeof homeSizeGiB === "number");
}
export function isGatewaySizingProfile(value) {
    if (!isPlainMap(value))
        return false;
    if (value.isolation === "shared")
        return true;
    return (value.isolation === "isolated" &&
        isSizingTier(value.sizingTier) &&
        isVmProfile(value.computer) &&
        (value.fallbackStorageGb === null || typeof value.fallbackStorageGb === "number"));
}
export function seedSizingProfiles(tiers) {
    const profiles = {};
    for (const [sizingKey, tier] of Object.entries(tiers)) {
        if (tier.instance === null && tier.computer === null) {
            profiles[sizingKey] = { isolation: "shared" };
        }
        else if (tier.instance !== null && tier.computer !== null) {
            profiles[sizingKey] = {
                isolation: "isolated",
                sizingTier: tier.instance,
                computer: tier.computer,
                fallbackStorageGb: tier.fallbackStorageGb,
            };
        }
        else {
            throw new Error(`sizing key ${sizingKey} names an instance or a VM without the other`);
        }
    }
    return profiles;
}
function sizingProfilesOf(value) {
    if (value === undefined)
        return {};
    if (!isPlainMap(value))
        throw new MalformedRecordError(ORCHESTRATOR_KEY, "sizingProfiles is not a map");
    for (const [sizingKey, profile] of Object.entries(value)) {
        if (!isGatewaySizingProfile(profile)) {
            throw new MalformedRecordError(ORCHESTRATOR_KEY, `sizingProfiles.${sizingKey} is not a gateway sizing profile`);
        }
    }
    return value;
}
function nullableField(data, field, accepts) {
    const value = data[field];
    if (value === undefined || value === null)
        return null;
    if (!accepts(value))
        throw new MalformedRecordError(ORCHESTRATOR_KEY, `${field} is ${JSON.stringify(value)}`);
    return value;
}
const isString = (value) => typeof value === "string";
const isNumber = (value) => typeof value === "number" && Number.isFinite(value);
export function parseOrchestratorConfig(data) {
    const sharedGatewayAutoscaling = parseSharedGatewayAutoscalingConfig(data.sharedGatewayAutoscaling);
    if (sharedGatewayAutoscaling === null) {
        logger.error("config/orchestrator.sharedGatewayAutoscaling is invalid; reading it as null", {
            sharedGatewayAutoscaling: data.sharedGatewayAutoscaling,
        });
    }
    return {
        sharedGatewayAutoscaling,
        sizingProfiles: sizingProfilesOf(data.sizingProfiles),
        defaultGatewayId: nullableField(data, "defaultGatewayId", isString),
        disposableGatewayIdleMs: nullableField(data, "disposableGatewayIdleMs", isNonNegativeSafeInteger),
        placementUpdatedAt: nullableField(data, "placementUpdatedAt", isNumber),
        placementUpdatedBy: nullableField(data, "placementUpdatedBy", isString),
    };
}
function decodeOrchestratorConfig(snapshot) {
    if (!snapshot.exists)
        return null;
    return { ...parseOrchestratorConfig(decodeDocumentData(snapshot)), revision: revisionOf(snapshot) };
}
function assertValidOrchestratorPatch(patch) {
    const autoscaling = patch.sharedGatewayAutoscaling;
    if (autoscaling !== undefined) {
        const parsed = parseSharedGatewayAutoscalingConfig(autoscaling);
        if (parsed === null || parsed.enabled !== autoscaling.enabled || parsed.buildersPerGateway !== autoscaling.buildersPerGateway) {
            throw new MalformedRecordError(ORCHESTRATOR_KEY, `sharedGatewayAutoscaling ${JSON.stringify(autoscaling)} is invalid`);
        }
    }
    if (patch.sizingProfiles !== undefined)
        sizingProfilesOf(patch.sizingProfiles);
    const idleMs = patch.disposableGatewayIdleMs;
    if (idleMs !== undefined && idleMs !== null && !isClearField(idleMs) && !isNonNegativeSafeInteger(idleMs)) {
        throw new MalformedRecordError(ORCHESTRATOR_KEY, `disposableGatewayIdleMs ${idleMs} is not a nonnegative safe integer`);
    }
}
function decodePlatformConfig(key, snapshot) {
    if (!snapshot.exists)
        return null;
    return { ...platformConfigEntryFromData(key, decodeDocumentData(snapshot)), revision: revisionOf(snapshot) };
}
export function platformConfigEntryFromData(key, data) {
    const { updatedAt, updatedBy, ...rest } = data;
    const value = PLATFORM_CONFIG_READ_PARSERS[key](rest);
    if (value === null)
        throw new MalformedRecordError(platformKey(key), "does not parse");
    if (updatedAt !== undefined && updatedAt !== null && !isNumber(updatedAt)) {
        throw new MalformedRecordError(platformKey(key), "updatedAt is not a time");
    }
    if (updatedBy !== undefined && updatedBy !== null && !isString(updatedBy)) {
        throw new MalformedRecordError(platformKey(key), "updatedBy is not a string");
    }
    return {
        key,
        value: value,
        updatedAt: updatedAt ?? null,
        updatedBy: updatedBy ?? null,
    };
}
export function parsePlatformConfigValue(key, value) {
    const parsed = PLATFORM_CONFIG_WRITE_PARSERS[key](value);
    if (parsed === null)
        throw new MalformedRecordError(platformKey(key), "value does not parse");
    return parsed;
}
function decodeMattermostAdmin(snapshot) {
    if (!snapshot.exists)
        return null;
    const { userId, proxyUrl, updatedAt } = decodeDocumentData(snapshot);
    if (!isString(userId) || !(proxyUrl === undefined || proxyUrl === null || isString(proxyUrl)) || !isNumber(updatedAt)) {
        throw new MalformedRecordError(MATTERMOST_ADMIN_KEY, "is not a Mattermost admin identity");
    }
    return { userId, proxyUrl: proxyUrl ?? null, updatedAt, revision: revisionOf(snapshot) };
}
function decodeOpaque(snapshot) {
    if (!snapshot.exists)
        return null;
    return { ...decodeDocumentData(snapshot), revision: revisionOf(snapshot) };
}
export function createFirestoreConfigRepositories(session) {
    const orchestratorRef = () => session.db.doc(ORCHESTRATOR_CONFIG_PATH);
    const platformRef = (key) => session.db.collection(PLATFORM_CONFIG_COLLECTION).doc(key);
    const quiescenceRef = () => session.db.doc(WRITER_QUIESCENCE_PATH);
    const mattermostAdminRef = () => session.db.doc(MATTERMOST_ADMIN_PATH);
    return {
        orchestrator: {
            async get() {
                return decodeOrchestratorConfig(await session.read("config.orchestrator.get", orchestratorRef()));
            },
            async getSizingProfile(sizingKey) {
                const config = decodeOrchestratorConfig(await session.read("config.orchestrator.getSizingProfile", orchestratorRef()));
                const profile = config?.sizingProfiles[sizingKey];
                if (profile === undefined) {
                    throw new MissingRecordError({ aggregate: "orchestrator-config", key: `orchestrator/sizingProfiles/${sizingKey}` });
                }
                return profile;
            },
            async patch(patch, fence) {
                const name = "config.orchestrator.patch";
                assertValidOrchestratorPatch(patch);
                await session.atomically(name, async (fenced) => {
                    const snapshot = await fenced.readForFence(name, orchestratorRef());
                    if (!snapshot.exists) {
                        if (fence?.revision !== undefined)
                            throw new MissingRecordError(ORCHESTRATOR_KEY);
                        await fenced.create(name, ORCHESTRATOR_KEY, orchestratorRef(), encodeDocument(withoutClearedFields(patch), STORED_AS_NUMBERS));
                        return;
                    }
                    assertRevisionFence(ORCHESTRATOR_KEY, fence?.revision, revisionOf(snapshot));
                    await fenced.update(name, ORCHESTRATOR_KEY, orchestratorRef(), encodePatch(patch, STORED_AS_NUMBERS));
                });
            },
        },
        platform: {
            async get(key) {
                return decodePlatformConfig(key, await session.read("config.platform.get", platformRef(key)));
            },
            async put(key, value, updatedBy, updatedAt) {
                const parsed = parsePlatformConfigValue(key, value);
                await session.set("config.platform.put", platformKey(key), platformRef(key), encodeDocument({ ...parsed, updatedAt, updatedBy }, UPDATED_AT_TIMESTAMP));
            },
            async delete(key) {
                await session.delete("config.platform.delete", platformKey(key), platformRef(key));
            },
        },
        writerQuiescence: {
            async get() {
                return decodeOpaque(await session.read("config.writerQuiescence.get", quiescenceRef()));
            },
            async put(record) {
                await session.set("config.writerQuiescence.put", WRITER_QUIESCENCE_KEY, quiescenceRef(), encodeDocument(record, STORED_AS_NUMBERS, ["revision"]));
            },
            async delete() {
                await session.delete("config.writerQuiescence.delete", WRITER_QUIESCENCE_KEY, quiescenceRef());
            },
        },
        mattermostAdmin: {
            async get() {
                return decodeMattermostAdmin(await session.read("config.mattermostAdmin.get", mattermostAdminRef()));
            },
            async put(identity) {
                await session.set("config.mattermostAdmin.put", MATTERMOST_ADMIN_KEY, mattermostAdminRef(), encodeDocument({ userId: identity.userId, proxyUrl: identity.proxyUrl, updatedAt: identity.updatedAt }, UPDATED_AT_TIMESTAMP));
            },
        },
    };
}
function orchestratorRecord(snapshot) {
    const config = decodeOrchestratorConfig(snapshot);
    if (config === null)
        return null;
    const { revision, ...value } = config;
    return { kind: "orchestrator", value, revision };
}
function platformRecord(key) {
    return (snapshot) => {
        const entry = decodePlatformConfig(key, snapshot);
        if (entry === null)
            return null;
        const { revision, ...rest } = entry;
        return { kind: "platform", entry: rest, revision };
    };
}
export const firestoreConfigWatchSource = (db) => ({
    operation: "watch config",
    targets: [
        { document: db.doc(ORCHESTRATOR_CONFIG_PATH), key: "orchestrator", decode: orchestratorRecord },
        ...PLATFORM_CONFIG_KEYS.map((key) => ({
            document: db.collection(PLATFORM_CONFIG_COLLECTION).doc(key),
            key: `platform/${key}`,
            decode: platformRecord(key),
        })),
    ],
});
