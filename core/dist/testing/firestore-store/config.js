import { PLATFORM_CONFIG_COLLECTION } from "@octogee/shared/types/platform-config";
import { parseSharedGatewayAutoscalingConfig } from "@octogee/shared/types/shared-gateway-pool";
import { MalformedRecordError, MissingRecordError } from "../../platform-state/errors.js";
import { assertRevisionFence } from "./fences.js";
import { STORED_AS_NUMBERS, decodeDocumentData, encodeDocument, encodePatch, isClearField, revisionOf, storedAsTimestamps } from "./values.js";
import { ORCHESTRATOR_KEY, isNonNegativeSafeInteger, isNumber, isString, parseOrchestratorConfig, parsePlatformConfigValue, platformConfigEntryFromData, platformKey, sizingProfilesOf } from "../../platform-state/documents/config.js";
const ORCHESTRATOR_CONFIG_PATH = "config/orchestrator";
const WRITER_QUIESCENCE_PATH = "config/platformMigrationWriterQuiescence";
const MATTERMOST_ADMIN_PATH = "system/mattermostAdmin";
const PLATFORM_CONFIG_KEYS = ["models", "free", "connect"];
const UPDATED_AT_TIMESTAMP = storedAsTimestamps("updatedAt");
const WRITER_QUIESCENCE_KEY = { aggregate: "writer-quiescence", key: "platformMigrationWriterQuiescence" };
const MATTERMOST_ADMIN_KEY = { aggregate: "mattermost-admin", key: "mattermostAdmin" };
function withoutClearedFields(patch) {
    return Object.fromEntries(Object.entries(patch).filter(([, value]) => !isClearField(value)));
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
