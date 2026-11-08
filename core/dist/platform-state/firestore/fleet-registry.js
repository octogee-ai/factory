import { isGatewayRuntimeDoc } from "@octogee/shared/types/gateway-releases";
import { GLM_GATEWAYS_COLLECTION } from "@octogee/shared/types/glm";
import { DuplicateRecordError, MalformedRecordError, MissingRecordError } from "../errors.js";
import { assertFenceEquals, assertFenceOneOf, assertRevisionFence } from "./fences.js";
import { decodeDocumentData, encodeDocument, encodeMergeDocument, encodePatch, isClearField, revisionOf, storedAsTimestamps, } from "./values.js";
const REGISTRY_TIMES = storedAsTimestamps("heartbeat.lastHeartbeatAt", "heartbeat.configStatus.observedAt");
const RUNTIME_DOC_KIND = "runtime";
const registryKey = (gatewayId) => ({ aggregate: "fleet-registry", key: gatewayId });
export function decodeFleetRegistryRecord(snapshot) {
    if (!snapshot.exists)
        return null;
    const data = decodeDocumentData(snapshot);
    if (data.docKind !== RUNTIME_DOC_KIND)
        return null;
    if (!isGatewayRuntimeDoc(data) || data.gatewayId !== snapshot.id) {
        throw new MalformedRecordError(registryKey(snapshot.id), "is not this gateway's runtime record");
    }
    if (!isHeartbeatMap(data.heartbeat)) {
        throw new MalformedRecordError(registryKey(snapshot.id), "has no heartbeat map");
    }
    const { docKind: _docKind, ...record } = data;
    return { ...record, revision: revisionOf(snapshot) };
}
function isHeartbeatMap(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}
export function applyRecordPatch(record, patch) {
    const patched = { ...record };
    for (const [key, value] of Object.entries(patch)) {
        if (value === undefined)
            continue;
        if (isClearField(value))
            delete patched[key];
        else
            patched[key] = value;
    }
    return patched;
}
function assertRegistryFence(key, fence, current) {
    assertRevisionFence(key, fence.revision, current.revision);
    assertFenceOneOf(key, "status", fence.lifecycle, current.lifecycle);
    assertFenceEquals(key, "present", fence.vmInstanceId, current.vm?.instanceId ?? null);
}
function isPresent(value) {
    return value !== null;
}
export function createFirestoreFleetRegistryRepository(session) {
    const collection = () => session.db.collection(GLM_GATEWAYS_COLLECTION);
    const ref = (gatewayId) => collection().doc(gatewayId);
    return {
        async get(gatewayId) {
            return decodeFleetRegistryRecord(await session.read("fleetRegistry.get", ref(gatewayId)));
        },
        async getMany(gatewayIds) {
            const snapshots = await session.readAll("fleetRegistry.getMany", gatewayIds.map(ref));
            const found = new Map();
            for (const record of snapshots.map(decodeFleetRegistryRecord))
                if (record !== null)
                    found.set(record.gatewayId, record);
            return found;
        },
        async list(filter = {}) {
            const query = filter.runtime === undefined ? collection() : collection().where("runtime", "==", filter.runtime);
            return (await session.query("fleetRegistry.list", query)).docs.map(decodeFleetRegistryRecord).filter(isPresent);
        },
        async findByVmInstanceId(instanceId) {
            const docs = (await session.query("fleetRegistry.findByVmInstanceId", collection().where("vm.instanceId", "==", instanceId).limit(2))).docs;
            if (docs.length > 1) {
                throw new DuplicateRecordError("fleet-registry", "vm.instanceId", instanceId, docs.map((doc) => doc.id));
            }
            return docs.length === 0 ? null : decodeFleetRegistryRecord(docs[0]);
        },
        async create(record) {
            await session.create("fleetRegistry.create", registryKey(record.gatewayId), ref(record.gatewayId), encodeDocument({ docKind: RUNTIME_DOC_KIND, ...record }, REGISTRY_TIMES, ["revision"]));
        },
        async upsert(gatewayId, initial, patch) {
            const name = "fleetRegistry.upsert";
            const key = registryKey(gatewayId);
            if (initial.gatewayId !== gatewayId) {
                throw new MalformedRecordError(key, `initial record names gateway ${JSON.stringify(initial.gatewayId)}`);
            }
            await session.atomically(name, async (fenced) => {
                const current = decodeFleetRegistryRecord(await fenced.readForFence(name, ref(gatewayId)));
                if (current === null) {
                    const record = applyRecordPatch(initial, patch);
                    await fenced.merge(name, key, ref(gatewayId), encodeMergeDocument({ docKind: RUNTIME_DOC_KIND, ...record }, REGISTRY_TIMES));
                    return;
                }
                const update = encodePatch(patch, REGISTRY_TIMES);
                if (Object.keys(update).length > 0)
                    await fenced.update(name, key, ref(gatewayId), update);
            });
        },
        async patch(gatewayId, patch, fence) {
            const name = "fleetRegistry.patch";
            const key = registryKey(gatewayId);
            await session.atomically(name, async (fenced) => {
                const current = decodeFleetRegistryRecord(await fenced.readForFence(name, ref(gatewayId)));
                if (current === null)
                    throw new MissingRecordError(key);
                if (fence !== undefined)
                    assertRegistryFence(key, fence, current);
                await fenced.update(name, key, ref(gatewayId), encodePatch(patch, REGISTRY_TIMES));
            });
        },
        async recordHeartbeat(gatewayId, heartbeat) {
            await session.merge("fleetRegistry.recordHeartbeat", registryKey(gatewayId), ref(gatewayId), encodeMergeDocument({ heartbeat: { ...heartbeat, lastHeartbeatAt: { serverNow: true } } }, REGISTRY_TIMES));
        },
        async delete(gatewayId) {
            await session.delete("fleetRegistry.delete", registryKey(gatewayId), ref(gatewayId));
        },
    };
}
export const firestoreFleetRegistryWatchSource = (db, filter) => {
    const collection = db.collection(GLM_GATEWAYS_COLLECTION);
    return {
        operation: "watch fleetRegistry",
        targets: [
            filter.gatewayId === undefined
                ? { query: collection, key: (snapshot) => snapshot.id, decode: decodeFleetRegistryRecord }
                : { document: collection.doc(filter.gatewayId), key: filter.gatewayId, decode: decodeFleetRegistryRecord },
        ],
    };
};
