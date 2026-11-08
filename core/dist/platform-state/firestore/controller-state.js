import { parsePlatformReleaseRecord, PLATFORM_RELEASE_RECORD_DOC_PATH } from "@octogee/shared/types/gateway-releases";
import { parseSharedPoolReplacements } from "@octogee/shared/types/shared-gateway-pool";
import { MalformedRecordError, MissingRecordError } from "../errors.js";
import { assertAbsentFence, assertFenceEquals, assertRevisionFence } from "./fences.js";
import { applyRecordPatch } from "./fleet-registry.js";
import { decodeDocumentData, encodeDocument, encodePatch, revisionOf, STORED_AS_NUMBERS } from "./values.js";
const SHARED_POOL_SCALER_STATE_PATH = "glmControllerState/sharedPoolScaler";
const SCALER_KEY = { aggregate: "shared-pool-scaler", key: "sharedPoolScaler" };
const PLATFORM_RELEASE_KEY = { aggregate: "platform-release", key: "platformRelease" };
function isNonNegativeInteger(value) {
    return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
function isPlainMap(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}
function parseReplacements(value) {
    try {
        return parseSharedPoolReplacements(value);
    }
    catch (error) {
        throw new MalformedRecordError(SCALER_KEY, error instanceof Error ? error.message : String(error));
    }
}
export function parseSharedPoolScalerState(data) {
    const { schemaVersion, actionSequence, lastActionAt, lastAction, updatedAt } = data;
    if (schemaVersion !== 1)
        throw new MalformedRecordError(SCALER_KEY, `schemaVersion is ${JSON.stringify(schemaVersion)}`);
    if (!isNonNegativeInteger(actionSequence))
        throw new MalformedRecordError(SCALER_KEY, "actionSequence is not a nonnegative integer");
    if (lastActionAt !== null && !isNonNegativeInteger(lastActionAt)) {
        throw new MalformedRecordError(SCALER_KEY, "lastActionAt is neither null nor a nonnegative integer");
    }
    if (lastAction !== undefined && lastAction !== null && !isPlainMap(lastAction)) {
        throw new MalformedRecordError(SCALER_KEY, "lastAction is not a map");
    }
    if (updatedAt !== undefined && !isNonNegativeInteger(updatedAt)) {
        throw new MalformedRecordError(SCALER_KEY, "updatedAt is not a nonnegative integer");
    }
    return {
        schemaVersion,
        actionSequence,
        lastActionAt,
        replacements: parseReplacements(data.replacements),
        ...(lastAction === undefined ? {} : { lastAction }),
        ...(updatedAt === undefined ? {} : { updatedAt }),
    };
}
function decodeScalerState(snapshot) {
    if (!snapshot.exists)
        return null;
    return { ...parseSharedPoolScalerState(decodeDocumentData(snapshot)), revision: revisionOf(snapshot) };
}
function assertScalerFence(fence, current) {
    assertRevisionFence(SCALER_KEY, fence.revision, current.revision);
    assertFenceEquals(SCALER_KEY, "actionSequence", fence.actionSequence, current.actionSequence);
}
function encodeScalerState(state) {
    return encodeDocument(parseSharedPoolScalerState({ ...state }), STORED_AS_NUMBERS, ["revision"]);
}
function decodePlatformRelease(snapshot) {
    if (!snapshot.exists)
        return null;
    const record = parsePlatformReleaseRecord(decodeDocumentData(snapshot));
    if (record === null)
        throw new MalformedRecordError(PLATFORM_RELEASE_KEY, "is not a platform release record");
    return { ...record, revision: revisionOf(snapshot) };
}
export function createFirestoreControllerStateRepositories(session) {
    const scalerRef = () => session.db.doc(SHARED_POOL_SCALER_STATE_PATH);
    const platformReleaseRef = () => session.db.doc(PLATFORM_RELEASE_RECORD_DOC_PATH);
    return {
        sharedPoolScaler: {
            async get() {
                return decodeScalerState(await session.read("controllerState.sharedPoolScaler.get", scalerRef()));
            },
            async put(state, fence) {
                const name = "controllerState.sharedPoolScaler.put";
                const document = encodeScalerState(state);
                await session.atomically(name, async (fenced) => {
                    const snapshot = await fenced.readForFence(name, scalerRef());
                    if (fence === "absent") {
                        assertAbsentFence(SCALER_KEY, snapshot.exists ? revisionOf(snapshot) : null);
                    }
                    else {
                        const current = decodeScalerState(snapshot);
                        if (current === null)
                            throw new MissingRecordError(SCALER_KEY);
                        assertScalerFence(fence, current);
                    }
                    await fenced.set(name, SCALER_KEY, scalerRef(), document);
                });
            },
            async patch(patch, fence) {
                const name = "controllerState.sharedPoolScaler.patch";
                await session.atomically(name, async (fenced) => {
                    const current = decodeScalerState(await fenced.readForFence(name, scalerRef()));
                    if (current === null)
                        throw new MissingRecordError(SCALER_KEY);
                    if (fence !== undefined)
                        assertScalerFence(fence, current);
                    parseSharedPoolScalerState(applyRecordPatch({ ...current }, patch));
                    await fenced.update(name, SCALER_KEY, scalerRef(), encodePatch(patch, STORED_AS_NUMBERS));
                });
            },
        },
        platformRelease: {
            async get() {
                return decodePlatformRelease(await session.read("controllerState.platformRelease.get", platformReleaseRef()));
            },
            async put(record) {
                const parsed = parsePlatformReleaseRecord({ ...record });
                if (parsed === null)
                    throw new MalformedRecordError(PLATFORM_RELEASE_KEY, "is not a platform release record");
                await session.set("controllerState.platformRelease.put", PLATFORM_RELEASE_KEY, platformReleaseRef(), encodeDocument(parsed, STORED_AS_NUMBERS));
            },
        },
    };
}
