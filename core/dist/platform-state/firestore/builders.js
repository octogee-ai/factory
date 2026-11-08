import { isDeepStrictEqual } from "node:util";
import { FieldPath, FieldValue, } from "firebase-admin/firestore";
import { SCHEDULE_TRANSFERS_SUBCOLLECTION } from "@octogee/shared/types/fleet-controller";
import { GATEWAY_PROFILES } from "@octogee/shared/types/glm";
import { PLACEMENT_RECEIPTS_SUBCOLLECTION, placementReceiptDocId, } from "@octogee/shared/types/placement-receipts";
import { DuplicateRecordError, FenceMismatchError, MalformedRecordError, MissingRecordError, UnsupportedOperationError, } from "../errors.js";
import { assertFenceEquals, assertFenceOneOf, assertRevisionFence } from "./fences.js";
import { decodeDocumentData, encodeDocument, encodeMergeDocument, encodePatch, formatTimestamp, isClearField, revisionOf, STORED_AS_NUMBERS, storedAsTimestamps, } from "./values.js";
export const USERS_COLLECTION = "users";
export const AGENT_STORES_SUBCOLLECTION = "agentStores";
const GATEWAY_STATE_STORE_KEY = "_gateway-state";
const GATEWAY_STATE_KIND = "gateway-state";
const AUXILIARY_STORE_KEY_PREFIX = "_gateway-";
const AUXILIARY_STORED_KIND = "gateway-auxiliary";
const BUILDER_ROLES = ["user", "admin"];
const MANAGERS = ["cowboy", "operator"];
const AUXILIARY_FAMILIES = ["workboard", "logbook", "team-reports"];
const LEASE_STATUSES = [
    "requested",
    "provisioning",
    "activating",
    "active",
    "returning",
    "parked",
    "failed",
];
const SLUG_PATH = "provisioning.openclaw.slug";
const MATTERMOST_USER_ID_PATH = "mattermost.userId";
export const BUILDER_ACTIVATION_LEASE_PATH = "provisioning.openclaw.activationLease";
const AGENT_IDS_PATH = "provisioning.openclaw.agentIds";
const ACTIVATED_AGENTS_PATH = "provisioning.openclaw.activatedAgents";
const COMPUTER_INSTANCE_ID_PATH = "provisioning.computer.instanceId";
const ADMITTED_STEP = "complete";
const PROVISIONING_PATHS = {
    status: "provisioning.status",
    startedAt: "provisioning.startedAt",
    gitRepoUrl: "provisioning.git.repoUrl",
    gitCreatedAt: "provisioning.git.createdAt",
};
export const BUILDER_MIRROR_PATHS = {
    gatewayId: "provisioning.openclaw.gatewayId",
    gatewayAssignedAt: "provisioning.openclaw.gatewayAssignedAt",
    gatewayProfile: "provisioning.openclaw.gatewayProfile",
    controlUiEnabled: "provisioning.openclaw.controlUiEnabled",
};
const OPENCLAW_PATHS = {
    status: "provisioning.openclaw.status",
    version: "provisioning.openclaw.version",
    agentId: "provisioning.openclaw.agentId",
    customerDir: "provisioning.openclaw.customerDir",
    provisionedAt: "provisioning.openclaw.provisionedAt",
    mounted: "provisioning.openclaw.mounted",
    managedBy: "provisioning.openclaw.managedBy",
    greeting: "provisioning.openclaw.greeting",
    toolchain: "provisioning.openclaw.toolchain",
};
export const BUILDER_FENCE_PATHS = {
    restoreFence: "provisioning.openclaw.restoreFence",
    sourceTransferFence: "provisioning.openclaw.sourceTransferFence",
    computerRecovery: "provisioning.computerRecovery",
    migration: "provisioning.openclaw.migration",
    pendingNativeSchedulerRetirement: "provisioning.pendingNativeSchedulerRetirement",
    runtimeReset: "provisioning.openclaw.runtimeReset",
};
const HOME_PATHS = {
    computer: "provisioning.computer",
    homeCheckpoint: "provisioning.homeCheckpoint",
    homeDisk: "provisioning.homeDisk",
    homeStorage: "provisioning.homeStorage",
    homeMigration: "provisioning.homeMigration",
    homeErasure: "provisioning.homeErasure",
    homeCapacity: "provisioning.homeCapacity",
    projectStorageNativeBoot: "provisioning.projectStorage.nativeBoot",
};
const TOP_LEVEL_PATHS = {
    slug: SLUG_PATH,
    mattermostUserId: MATTERMOST_USER_ID_PATH,
    workspaceId: "workspaceId",
    accountLifecycle: "accountLifecycle",
};
const PATCH_GROUPS = {
    provisioning: PROVISIONING_PATHS,
    openclaw: OPENCLAW_PATHS,
    home: HOME_PATHS,
};
const CREATED_AT_TIMESTAMP = storedAsTimestamps("createdAt");
const builderKey = (uid) => ({ aggregate: "builder", key: uid });
const receiptKey = (uid, receiptId) => ({ aggregate: "placement-receipt", key: `${uid}/${receiptId}` });
const transferKey = (uid, migrationId) => ({ aggregate: "schedule-transfer", key: `${uid}/${migrationId}` });
const agentStoreKey = (uid, storeKey) => ({ aggregate: "agent-store", key: `${uid}/${storeKey}` });
function isMap(value) {
    if (value === null || typeof value !== "object" || Array.isArray(value))
        return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}
function present(fields) {
    return Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined));
}
function productValue(data, path) {
    let value = data;
    for (const segment of path.split(".")) {
        if (!isMap(value))
            return undefined;
        value = value[segment];
    }
    return value;
}
class StoredFields {
    record;
    data;
    constructor(record, data) {
        this.record = record;
        this.data = data;
    }
    malformed(path, expected) {
        return new MalformedRecordError(this.record, `${path} is not ${expected}`);
    }
    value(path) {
        const segments = path.split(".");
        let value = this.data;
        for (let index = 0; index < segments.length; index += 1) {
            if (value === undefined)
                return undefined;
            if (!isMap(value))
                throw this.malformed(segments.slice(0, index).join("."), "a map");
            value = value[segments[index]];
        }
        return value;
    }
    typed(path, expected, accepts) {
        const value = this.value(path);
        if (value === undefined)
            return undefined;
        if (!accepts(value))
            throw this.malformed(path, expected);
        return value;
    }
    string(path) {
        return this.typed(path, "a string", (value) => typeof value === "string");
    }
    number(path) {
        return this.typed(path, "a number", (value) => typeof value === "number");
    }
    boolean(path) {
        return this.typed(path, "a boolean", (value) => typeof value === "boolean");
    }
    oneOf(path, allowed) {
        return this.typed(path, `one of ${allowed.join(", ")}`, (value) => allowed.includes(value));
    }
    map(path) {
        return this.typed(path, "a map", (value) => isMap(value));
    }
    maps(path) {
        return this.typed(path, "a list of maps", (value) => Array.isArray(value) && value.every(isMap));
    }
    strings(path) {
        return this.typed(path, "a list of strings", (value) => Array.isArray(value) && value.every((item) => typeof item === "string")) ?? [];
    }
    requiredString(path) {
        const value = this.string(path);
        if (value === undefined)
            throw this.malformed(path, "a string");
        return value;
    }
    requiredNumber(path) {
        const value = this.number(path);
        if (value === undefined)
            throw this.malformed(path, "a number");
        return value;
    }
    requiredOneOf(path, allowed) {
        const value = this.oneOf(path, allowed);
        if (value === undefined)
            throw this.malformed(path, `one of ${allowed.join(", ")}`);
        return value;
    }
}
function usersCollection(db) {
    return db.collection(USERS_COLLECTION);
}
function systemConfigRef(userRef) {
    return userRef.collection("system").doc("config");
}
export function builderRoleFromData(uid, config) {
    if (config === undefined)
        return null;
    return new StoredFields(builderKey(uid), config).oneOf("role", BUILDER_ROLES) ?? null;
}
function decodeRole(uid, config) {
    if (config === undefined || !config.exists)
        return null;
    return builderRoleFromData(uid, decodeDocumentData(config));
}
function decodePersona(data) {
    const vibe = productValue(data, "onboarding.vibe");
    const timeZone = productValue(data, "preferences.timeZone");
    if (vibe === undefined && timeZone === undefined)
        return null;
    return present({ vibe, timeZone });
}
function decodeSlug(fields, data) {
    const username = productValue(data, "username");
    return fields.string(SLUG_PATH) ?? (typeof username === "string" ? username : null);
}
function decodeActivationLease(fields) {
    const lease = fields.map(BUILDER_ACTIVATION_LEASE_PATH);
    if (lease === undefined)
        return null;
    fields.requiredString(`${BUILDER_ACTIVATION_LEASE_PATH}.leaseId`);
    fields.requiredNumber(`${BUILDER_ACTIVATION_LEASE_PATH}.generation`);
    fields.requiredOneOf(`${BUILDER_ACTIVATION_LEASE_PATH}.status`, LEASE_STATUSES);
    return lease;
}
function decodeGatewayMirror(fields) {
    const gatewayId = fields.string(BUILDER_MIRROR_PATHS.gatewayId);
    if (gatewayId === undefined)
        return null;
    return present({
        gatewayId,
        gatewayAssignedAt: fields.number(BUILDER_MIRROR_PATHS.gatewayAssignedAt),
        gatewayProfile: fields.oneOf(BUILDER_MIRROR_PATHS.gatewayProfile, GATEWAY_PROFILES),
        controlUiEnabled: fields.boolean(BUILDER_MIRROR_PATHS.controlUiEnabled),
    });
}
function builderRevision(user, config) {
    const configTime = config?.exists === true ? config.updateTime : undefined;
    const userTime = user.updateTime;
    if (configTime === undefined || userTime === undefined || configTime.valueOf() <= userTime.valueOf())
        return revisionOf(user);
    return formatTimestamp(configTime);
}
export function decodeBuilder(snapshot, config) {
    if (!snapshot.exists)
        return null;
    const record = builderRecordFromData(snapshot.id, decodeDocumentData(snapshot), snapshot.updateTime.toMillis(), decodeRole(snapshot.id, config));
    return { ...record, revision: builderRevision(snapshot, config) };
}
export function builderRecordFromData(uid, data, updatedAt, role) {
    const fields = new StoredFields(builderKey(uid), data);
    return {
        uid,
        slug: decodeSlug(fields, data),
        mattermostUserId: fields.string(MATTERMOST_USER_ID_PATH) ?? null,
        admitted: data.onboardingStep === ADMITTED_STEP,
        persona: decodePersona(data),
        workspaceId: fields.string(TOP_LEVEL_PATHS.workspaceId) ?? null,
        role,
        createdAt: fields.number("createdAt") ?? null,
        updatedAt,
        provisioning: present({
            status: fields.string(PROVISIONING_PATHS.status),
            startedAt: fields.number(PROVISIONING_PATHS.startedAt),
            gitRepoUrl: fields.string(PROVISIONING_PATHS.gitRepoUrl),
            gitCreatedAt: fields.number(PROVISIONING_PATHS.gitCreatedAt),
        }),
        gateway: decodeGatewayMirror(fields),
        openclaw: present({
            status: fields.string(OPENCLAW_PATHS.status),
            version: fields.string(OPENCLAW_PATHS.version),
            agentId: fields.string(OPENCLAW_PATHS.agentId),
            customerDir: fields.string(OPENCLAW_PATHS.customerDir),
            provisionedAt: fields.number(OPENCLAW_PATHS.provisionedAt),
            mounted: fields.boolean(OPENCLAW_PATHS.mounted),
            managedBy: fields.oneOf(OPENCLAW_PATHS.managedBy, MANAGERS),
            greeting: fields.map(OPENCLAW_PATHS.greeting),
            toolchain: fields.map(OPENCLAW_PATHS.toolchain),
        }),
        agents: {
            agentIds: fields.strings(AGENT_IDS_PATH),
            activatedAgents: fields.strings(ACTIVATED_AGENTS_PATH),
        },
        accountLifecycle: fields.map(TOP_LEVEL_PATHS.accountLifecycle) ?? null,
        activationLease: decodeActivationLease(fields),
        fences: present({
            restoreFence: fields.map(BUILDER_FENCE_PATHS.restoreFence),
            sourceTransferFence: fields.map(BUILDER_FENCE_PATHS.sourceTransferFence),
            computerRecovery: fields.map(BUILDER_FENCE_PATHS.computerRecovery),
            migration: fields.map(BUILDER_FENCE_PATHS.migration),
            pendingNativeSchedulerRetirement: fields.map(BUILDER_FENCE_PATHS.pendingNativeSchedulerRetirement),
            runtimeReset: fields.map(BUILDER_FENCE_PATHS.runtimeReset),
        }),
        home: present({
            computer: fields.map(HOME_PATHS.computer),
            homeCheckpoint: fields.map(HOME_PATHS.homeCheckpoint),
            homeDisk: fields.map(HOME_PATHS.homeDisk),
            homeStorage: fields.map(HOME_PATHS.homeStorage),
            homeMigration: fields.map(HOME_PATHS.homeMigration),
            homeErasure: fields.maps(HOME_PATHS.homeErasure),
            homeCapacity: fields.map(HOME_PATHS.homeCapacity),
            projectStorageNativeBoot: fields.boolean(HOME_PATHS.projectStorageNativeBoot),
        }),
    };
}
function mappedGroup(group, paths, groupName) {
    const fields = {};
    for (const [key, value] of Object.entries(group)) {
        if (!Object.hasOwn(paths, key))
            throw new TypeError(`builder patch ${groupName}.${key} has no stored field`);
        fields[paths[key]] = value;
    }
    return fields;
}
export function builderPatchPaths(patch) {
    const fields = {};
    for (const [key, value] of Object.entries(patch)) {
        if (value === undefined || key === "role")
            continue;
        if (Object.hasOwn(TOP_LEVEL_PATHS, key)) {
            fields[TOP_LEVEL_PATHS[key]] = value;
        }
        else if (Object.hasOwn(PATCH_GROUPS, key)) {
            Object.assign(fields, mappedGroup(value, PATCH_GROUPS[key], key));
        }
        else {
            throw new TypeError(`builder patch ${key} has no stored field`);
        }
    }
    return fields;
}
function builderPatchFields(patch) {
    return encodePatch(builderPatchPaths(patch), STORED_AS_NUMBERS);
}
function builderFenceMismatch(record, field, expected, actual) {
    return new FenceMismatchError(record, expected === null || expected === undefined ? "absent" : "present", { [field]: expected }, { [field]: actual });
}
function assertBuilderFence(record, fence, current) {
    if (fence === undefined)
        return;
    assertRevisionFence(record, fence.revision, current.revision);
    if (fence.gatewayId !== undefined && fence.gatewayId !== (current.gateway?.gatewayId ?? null)) {
        throw builderFenceMismatch(record, "gatewayId", fence.gatewayId, current.gateway?.gatewayId ?? null);
    }
    if (fence.provisioningStatus === "absent") {
        if (current.provisioning.status !== undefined) {
            throw builderFenceMismatch(record, "provisioningStatus", null, current.provisioning.status);
        }
    }
    else {
        assertFenceEquals(record, "status", fence.provisioningStatus, current.provisioning.status);
    }
}
function assertActivationLeaseFence(record, fence, lease) {
    assertFenceEquals(record, "leaseId", fence.leaseId, lease?.leaseId ?? null);
    assertFenceEquals(record, "generation", fence.generation, lease?.generation ?? null);
    assertFenceOneOf(record, "status", fence.status, lease?.status);
}
async function readSystemConfigs(session, operation, userSnapshots) {
    const configs = await session.readAll(operation, userSnapshots.map((snapshot) => systemConfigRef(snapshot.ref)));
    return new Map(userSnapshots.map((snapshot, index) => [snapshot.id, configs[index]]));
}
function storedBuilders(userSnapshots, configs) {
    const records = [];
    for (const snapshot of userSnapshots) {
        const record = decodeBuilder(snapshot, configs.get(snapshot.id));
        if (record !== null)
            records.push(record);
    }
    return records;
}
function uniqueByUid(snapshots) {
    return [...new Map(snapshots.map((snapshot) => [snapshot.id, snapshot])).values()];
}
function builderRecordAccess(session) {
    const collection = () => usersCollection(session.db);
    const ref = (uid) => collection().doc(uid);
    const queryRecords = async (operation, queries) => {
        const results = await Promise.all(queries.map((query) => session.query(operation, query)));
        const docs = uniqueByUid(results.flatMap((result) => result.docs));
        return storedBuilders(docs, await readSystemConfigs(session, operation, docs));
    };
    const findUnique = async (operation, lookup, value, queries, matches = () => true) => {
        const found = (await queryRecords(operation, queries)).filter(matches);
        if (found.length > 1) {
            throw new DuplicateRecordError("builder", lookup, value, found.map((record) => record.uid));
        }
        return found[0] ?? null;
    };
    const readCurrent = async (fenced, operation, uid) => {
        const user = await fenced.readForFence(operation, ref(uid));
        const config = await fenced.readForFence(operation, systemConfigRef(ref(uid)));
        const current = decodeBuilder(user, config);
        if (current === null)
            throw new MissingRecordError(builderKey(uid));
        return current;
    };
    const update = async (operation, uid, data, fence) => {
        if (fence === undefined) {
            await session.update(operation, builderKey(uid), ref(uid), data);
            return;
        }
        await session.atomically(operation, async (fenced) => {
            assertBuilderFence(builderKey(uid), fence, await readCurrent(fenced, operation, uid));
            await fenced.update(operation, builderKey(uid), ref(uid), data);
        });
    };
    const updateActivationLease = async (operation, uid, fence, data) => {
        await session.atomically(operation, async (fenced) => {
            const current = await readCurrent(fenced, operation, uid);
            assertActivationLeaseFence(builderKey(uid), fence, current.activationLease);
            await fenced.update(operation, builderKey(uid), ref(uid), data(current.activationLease));
        });
    };
    return { session, collection, ref, queryRecords, findUnique, readCurrent, update, updateActivationLease };
}
function builderRecordReads(access) {
    const { session, collection, ref, queryRecords, findUnique } = access;
    return {
        async get(uid) {
            const name = "builders.records.get";
            const [user, config] = await session.readAll(name, [ref(uid), systemConfigRef(ref(uid))]);
            return decodeBuilder(user, config);
        },
        async getMany(uids) {
            const name = "builders.records.getMany";
            const unique = [...new Set(uids)];
            const snapshots = await session.readAll(name, unique.flatMap((uid) => [ref(uid), systemConfigRef(ref(uid))]));
            const found = new Map();
            unique.forEach((uid, index) => {
                const record = decodeBuilder(snapshots[index * 2], snapshots[index * 2 + 1]);
                if (record !== null)
                    found.set(uid, record);
            });
            return found;
        },
        findBySlug(slug) {
            return findUnique("builders.records.findBySlug", "slug", slug, [collection().where(SLUG_PATH, "==", slug).limit(2), collection().where("username", "==", slug).limit(2)], (record) => record.slug === slug);
        },
        findByMattermostUserId(mattermostUserId) {
            return findUnique("builders.records.findByMattermostUserId", "mattermostUserId", mattermostUserId, [
                collection().where(MATTERMOST_USER_ID_PATH, "==", mattermostUserId).limit(2),
            ]);
        },
        findByComputerInstanceId(instanceId) {
            return findUnique("builders.records.findByComputerInstanceId", "computerInstanceId", instanceId, [
                collection().where(COMPUTER_INSTANCE_ID_PATH, "==", instanceId).limit(2),
            ]);
        },
        listByAgentId(agentId, limit) {
            return queryRecords("builders.records.listByAgentId", [
                collection().where(OPENCLAW_PATHS.agentId, "==", agentId).limit(limit),
                collection().where(AGENT_IDS_PATH, "array-contains", agentId).limit(limit),
            ]);
        },
        listByGateway(gatewayId, filter = {}) {
            let query = collection().where(BUILDER_MIRROR_PATHS.gatewayId, "==", gatewayId);
            if (filter.openclawStatus !== undefined)
                query = query.where(OPENCLAW_PATHS.status, "==", filter.openclawStatus);
            if (filter.limit !== undefined)
                query = query.limit(filter.limit);
            return queryRecords("builders.records.listByGateway", [query]);
        },
        async listGatewayFenceHolders(gatewayId) {
            const name = "builders.records.listGatewayFenceHolders";
            const results = await Promise.all([
                BUILDER_MIRROR_PATHS.gatewayId,
                `${BUILDER_FENCE_PATHS.sourceTransferFence}.sourceGatewayId`,
                `${BUILDER_FENCE_PATHS.sourceTransferFence}.targetGatewayId`,
                `${BUILDER_FENCE_PATHS.computerRecovery}.gatewayId`,
            ].map((path) => session.query(name, collection().where(path, "==", gatewayId))));
            const configs = await readSystemConfigs(session, name, uniqueByUid(results.flatMap((result) => result.docs)));
            const [assigned, sourceTransferSource, sourceTransferTarget, computerRecovery] = results.map((result) => storedBuilders(result.docs, configs));
            return { assigned, sourceTransferSource, sourceTransferTarget, computerRecovery };
        },
        listAdmitted() {
            return queryRecords("builders.records.listAdmitted", [collection().where("onboardingStep", "==", ADMITTED_STEP)]);
        },
        listAll() {
            return queryRecords("builders.records.listAll", [collection()]);
        },
        listByOpenClawStatus(openclawStatus) {
            return queryRecords("builders.records.listByOpenClawStatus", [collection().where(OPENCLAW_PATHS.status, "==", openclawStatus)]);
        },
        async list(page) {
            const name = "builders.records.list";
            let query = collection().orderBy("createdAt", "desc");
            if (page.after !== undefined) {
                const cursor = await session.read(name, ref(page.after));
                if (!cursor.exists)
                    throw new MissingRecordError(builderKey(page.after));
                query = query.startAfter(cursor);
            }
            const docs = (await session.query(name, query.limit(page.limit + 1))).docs;
            const pageDocs = docs.slice(0, page.limit);
            return {
                items: storedBuilders(pageDocs, await readSystemConfigs(session, name, pageDocs)),
                next: docs.length > page.limit ? pageDocs[pageDocs.length - 1].id : null,
            };
        },
    };
}
function builderRecordWrites(access) {
    const { session, ref, readCurrent, update, updateActivationLease } = access;
    return {
        async create(record) {
            await session.merge("builders.records.create", builderKey(record.uid), ref(record.uid), encodeMergeDocument({ createdAt: record.createdAt }, CREATED_AT_TIMESTAMP));
        },
        async patch(uid, patch, fence) {
            const name = "builders.records.patch";
            const key = builderKey(uid);
            const fields = builderPatchFields(patch);
            const hasFields = Object.keys(fields).length > 0;
            if (patch.role === undefined) {
                await update(name, uid, fields, fence);
                return;
            }
            const role = encodeMergeDocument({ role: patch.role }, STORED_AS_NUMBERS);
            await session.atomically(name, async (fenced) => {
                if (fence !== undefined || !hasFields)
                    assertBuilderFence(key, fence, await readCurrent(fenced, name, uid));
                if (hasFields)
                    await fenced.update(name, key, ref(uid), fields);
                await fenced.merge(name, key, systemConfigRef(ref(uid)), role);
            });
        },
        async admit(uid, input) {
            const name = "builders.records.admit";
            const key = builderKey(uid);
            await session.atomically(name, async (fenced) => {
                const current = decodeBuilder(await fenced.readForFence(name, ref(uid)), undefined);
                if (current === null) {
                    await fenced.merge(name, key, ref(uid), encodeMergeDocument({ onboardingStep: ADMITTED_STEP, provisioning: { status: "in_progress", startedAt: input.provisioningStartedAt } }, STORED_AS_NUMBERS));
                    return;
                }
                if (current.provisioning.status !== undefined) {
                    throw builderFenceMismatch(key, "provisioningStatus", null, current.provisioning.status);
                }
                if (current.slug !== null && current.slug !== input.slug) {
                    throw builderFenceMismatch(key, "slug", input.slug, current.slug);
                }
                await fenced.update(name, key, ref(uid), encodePatch({
                    onboardingStep: ADMITTED_STEP,
                    [PROVISIONING_PATHS.status]: "in_progress",
                    [PROVISIONING_PATHS.startedAt]: input.provisioningStartedAt,
                }, STORED_AS_NUMBERS));
            });
        },
        async setGatewayMirror(uid, mirror, fence) {
            const fields = isClearField(mirror)
                ? Object.fromEntries(Object.values(BUILDER_MIRROR_PATHS).map((path) => [path, mirror]))
                : mappedGroup(mirror, BUILDER_MIRROR_PATHS, "gateway");
            await update("builders.records.setGatewayMirror", uid, encodePatch(fields, STORED_AS_NUMBERS), fence);
        },
        async addAgents(uid, agentIds) {
            if (agentIds.length === 0)
                return;
            await update("builders.records.addAgents", uid, { [AGENT_IDS_PATH]: FieldValue.arrayUnion(...agentIds) });
        },
        async removeAgents(uid, agentIds) {
            if (agentIds.length === 0)
                return;
            await update("builders.records.removeAgents", uid, { [AGENT_IDS_PATH]: FieldValue.arrayRemove(...agentIds) });
        },
        async setActivatedAgents(uid, activatedAgents) {
            await update("builders.records.setActivatedAgents", uid, { [ACTIVATED_AGENTS_PATH]: [...activatedAgents] });
        },
        async setActivationLease(uid, lease, fence) {
            const data = encodePatch({ [BUILDER_ACTIVATION_LEASE_PATH]: lease }, STORED_AS_NUMBERS);
            await updateActivationLease("builders.records.setActivationLease", uid, fence, () => data);
        },
        async patchActivationLease(uid, patch, fence) {
            const name = "builders.records.patchActivationLease";
            if (Object.hasOwn(patch, "leaseId") || Object.hasOwn(patch, "generation")) {
                throw new TypeError("an activation lease patch cannot change its leaseId or generation");
            }
            const data = encodePatch(patch, STORED_AS_NUMBERS, BUILDER_ACTIVATION_LEASE_PATH);
            await updateActivationLease(name, uid, fence, (lease) => {
                if (lease === null)
                    throw builderFenceMismatch(builderKey(uid), "activationLease", "present", null);
                return data;
            });
        },
        async setFence(uid, fenceName, value, expected) {
            const name = "builders.records.setFence";
            const key = builderKey(uid);
            const data = encodePatch({ [BUILDER_FENCE_PATHS[fenceName]]: value }, STORED_AS_NUMBERS);
            if (expected === undefined) {
                await session.update(name, key, ref(uid), data);
                return;
            }
            await session.atomically(name, async (fenced) => {
                const actual = (await readCurrent(fenced, name, uid)).fences[fenceName];
                const wanted = expected === "absent" ? undefined : expected;
                if (!isDeepStrictEqual(actual, wanted))
                    throw builderFenceMismatch(key, fenceName, wanted ?? null, actual ?? null);
                await fenced.update(name, key, ref(uid), data);
            });
        },
        async delete(uid) {
            if (session.transactional) {
                throw new UnsupportedOperationError("firestore", "builders.records.delete", "backend-capability");
            }
            await session.db.recursiveDelete(ref(uid));
        },
    };
}
function createBuilderRecordsRepository(session) {
    const access = builderRecordAccess(session);
    return { ...builderRecordReads(access), ...builderRecordWrites(access) };
}
function createPlacementReceiptsRepository(session) {
    const collection = (uid) => usersCollection(session.db).doc(uid).collection(PLACEMENT_RECEIPTS_SUBCOLLECTION);
    const decode = (snapshot) => decodeDocumentData(snapshot);
    return {
        async get(uid, leaseId, generation, kind) {
            const snapshot = await session.read("builders.placementReceipts.get", collection(uid).doc(placementReceiptDocId(leaseId, generation, kind)));
            return snapshot.exists ? decode(snapshot) : null;
        },
        async list(uid, page) {
            const name = "builders.placementReceipts.list";
            let query = collection(uid).orderBy("at", "desc");
            if (page.after !== undefined) {
                const cursor = await session.read(name, collection(uid).doc(page.after));
                if (!cursor.exists)
                    throw new MissingRecordError(receiptKey(uid, page.after));
                query = query.startAfter(cursor);
            }
            const docs = (await session.query(name, query.limit(page.limit + 1))).docs;
            const pageDocs = docs.slice(0, page.limit);
            return {
                items: pageDocs.map(decode),
                next: docs.length > page.limit ? pageDocs[pageDocs.length - 1].id : null,
            };
        },
        async create(uid, receipt) {
            const receiptId = placementReceiptDocId(receipt.leaseId, receipt.generation, receipt.kind);
            await session.create("builders.placementReceipts.create", receiptKey(uid, receiptId), collection(uid).doc(receiptId), encodeDocument(receipt, STORED_AS_NUMBERS));
        },
    };
}
function createScheduleTransfersRepository(session) {
    const ref = (uid, migrationId) => usersCollection(session.db).doc(uid).collection(SCHEDULE_TRANSFERS_SUBCOLLECTION).doc(migrationId);
    return {
        async get(uid, migrationId) {
            const snapshot = await session.read("builders.scheduleTransfers.get", ref(uid, migrationId));
            if (!snapshot.exists)
                return null;
            return { ...decodeDocumentData(snapshot), revision: revisionOf(snapshot) };
        },
        async put(uid, transfer) {
            await session.set("builders.scheduleTransfers.put", transferKey(uid, transfer.migrationId), ref(uid, transfer.migrationId), encodeDocument(transfer, STORED_AS_NUMBERS, ["revision"]));
        },
        async patch(uid, migrationId, patch) {
            await session.update("builders.scheduleTransfers.patch", transferKey(uid, migrationId), ref(uid, migrationId), encodePatch(patch, STORED_AS_NUMBERS));
        },
    };
}
function auxiliaryFamilyOf(storeKey) {
    return AUXILIARY_FAMILIES.find((family) => storeKey === `${AUXILIARY_STORE_KEY_PREFIX}${family}`) ?? null;
}
export function agentStoreKeyOf(record) {
    if (record.kind === GATEWAY_STATE_KIND)
        return GATEWAY_STATE_STORE_KEY;
    if (record.kind === "auxiliary")
        return `${AUXILIARY_STORE_KEY_PREFIX}${record.family}`;
    if (record.agentId.startsWith(AUXILIARY_STORE_KEY_PREFIX)) {
        throw new TypeError(`agent store id ${record.agentId} collides with the gateway store keys`);
    }
    return record.agentId;
}
function decodeAgentStore(uid, snapshot) {
    return { ...agentStoreFromData(uid, snapshot.id, decodeDocumentData(snapshot)), revision: revisionOf(snapshot) };
}
export function agentStoreFromData(uid, storeKey, data) {
    const key = agentStoreKey(uid, storeKey);
    const fields = new StoredFields(key, data);
    const common = {
        storeId: fields.requiredString("storeId"),
        schema: fields.requiredString("schema"),
        gatewayId: fields.string("gatewayId") ?? null,
        generation: fields.number("generation") ?? null,
        assignmentEpoch: fields.number("assignmentEpoch") ?? null,
        recordedAt: fields.requiredNumber("recordedAt"),
    };
    if (storeKey === GATEWAY_STATE_STORE_KEY) {
        if (fields.string("kind") !== GATEWAY_STATE_KIND)
            throw new MalformedRecordError(key, "kind is not gateway-state");
        return { kind: GATEWAY_STATE_KIND, ...common };
    }
    const family = auxiliaryFamilyOf(storeKey);
    if (family !== null) {
        if (fields.string("kind") !== AUXILIARY_STORED_KIND || fields.string("family") !== family) {
            throw new MalformedRecordError(key, `kind and family do not name the ${family} auxiliary store`);
        }
        return { kind: "auxiliary", family, ...common };
    }
    if (storeKey.startsWith(AUXILIARY_STORE_KEY_PREFIX))
        throw new MalformedRecordError(key, "names no known gateway store");
    if (fields.string("agentId") !== storeKey)
        throw new MalformedRecordError(key, "agentId does not match the store key");
    return { kind: "agent", agentId: storeKey, ...common };
}
function encodeAgentStore(record) {
    const common = {
        storeId: record.storeId,
        schema: record.schema,
        gatewayId: record.gatewayId ?? undefined,
        generation: record.generation ?? undefined,
        assignmentEpoch: record.assignmentEpoch ?? undefined,
        recordedAt: record.recordedAt,
    };
    if (record.kind === GATEWAY_STATE_KIND)
        return encodeDocument({ kind: GATEWAY_STATE_KIND, ...common }, STORED_AS_NUMBERS);
    if (record.kind === "auxiliary") {
        return encodeDocument({ kind: AUXILIARY_STORED_KIND, family: record.family, ...common }, STORED_AS_NUMBERS);
    }
    return encodeDocument({ agentId: record.agentId, ...common }, STORED_AS_NUMBERS);
}
function createAgentStoresRepository(session) {
    const collection = (uid) => usersCollection(session.db).doc(uid).collection(AGENT_STORES_SUBCOLLECTION);
    return {
        async list(uid) {
            const snapshot = await session.query("builders.agentStores.list", collection(uid));
            return snapshot.docs.map((doc) => decodeAgentStore(uid, doc));
        },
        async put(uid, record) {
            const storeKey = agentStoreKeyOf(record);
            await session.set("builders.agentStores.put", agentStoreKey(uid, storeKey), collection(uid).doc(storeKey), encodeAgentStore(record));
        },
        async delete(uid, storeKey) {
            await session.delete("builders.agentStores.delete", agentStoreKey(uid, storeKey), collection(uid).doc(storeKey));
        },
    };
}
export const createFirestoreBuilderRepositories = (session) => ({
    records: createBuilderRecordsRepository(session),
    placementReceipts: createPlacementReceiptsRepository(session),
    scheduleTransfers: createScheduleTransfersRepository(session),
    agentStores: createAgentStoresRepository(session),
});
function storedRole(config) {
    return config?.exists === true ? config.get("role") : undefined;
}
function laterOf(a, b) {
    return a !== undefined && a.valueOf() > b.valueOf() ? a : b;
}
function withRoles(query, configs) {
    return {
        onSnapshot(onNext, onError) {
            let active = true;
            let delivery = Promise.resolve();
            let deliveredAt;
            const users = new Map();
            const roles = new Map();
            configs.clear();
            const fail = (error) => {
                if (active)
                    onError(error instanceof Error ? error : new Error(String(error)));
            };
            const enqueue = (step) => {
                delivery = delivery
                    .then(async () => {
                    if (active)
                        await step();
                })
                    .catch(fail);
            };
            const deliver = (snapshot, uids) => {
                for (const uid of uids)
                    roles.get(uid).delivered = storedRole(configs.get(uid));
                deliveredAt = snapshot.readTime;
                onNext(snapshot);
            };
            const deliverRole = (uid, readTime) => {
                const user = users.get(uid);
                const role = roles.get(uid);
                if (user === undefined || role === undefined || isDeepStrictEqual(storedRole(configs.get(uid)), role.delivered))
                    return;
                deliver({ readTime: laterOf(deliveredAt, readTime), docs: [...users.values()], docChanges: () => [{ type: "modified", doc: user }] }, [uid]);
            };
            const follow = (uid, userRef) => {
                let markReady;
                let first = true;
                const ready = new Promise((resolve) => {
                    markReady = resolve;
                });
                const role = {
                    ready,
                    delivered: undefined,
                    release: () => {
                        unsubscribe();
                        markReady();
                    },
                };
                const unsubscribe = systemConfigRef(userRef).onSnapshot((config) => {
                    if (!active || roles.get(uid) !== role)
                        return;
                    configs.set(uid, config);
                    if (!first) {
                        enqueue(() => deliverRole(uid, config.readTime));
                        return;
                    }
                    first = false;
                    markReady();
                }, fail);
                roles.set(uid, role);
                return role;
            };
            const unfollow = (uid) => {
                roles.get(uid)?.release();
                roles.delete(uid);
                configs.delete(uid);
                users.delete(uid);
            };
            const unsubscribeUsers = query.onSnapshot((snapshot) => {
                enqueue(async () => {
                    const present = [];
                    const entering = [];
                    for (const change of snapshot.docChanges()) {
                        const uid = change.doc.id;
                        if (change.type === "removed") {
                            unfollow(uid);
                            continue;
                        }
                        users.set(uid, change.doc);
                        present.push(uid);
                        if (!roles.has(uid))
                            entering.push(follow(uid, change.doc.ref).ready);
                    }
                    await Promise.all(entering);
                    if (active)
                        deliver(snapshot, present);
                });
            }, fail);
            return () => {
                active = false;
                unsubscribeUsers();
                for (const role of roles.values())
                    role.release();
                roles.clear();
            };
        },
    };
}
export const firestoreBuildersWatchSource = (db, filter) => {
    let query = usersCollection(db);
    if (filter.uid !== undefined)
        query = query.where(FieldPath.documentId(), "==", filter.uid);
    if (filter.gatewayId !== undefined)
        query = query.where(BUILDER_MIRROR_PATHS.gatewayId, "==", filter.gatewayId);
    const configs = new Map();
    const target = {
        query: withRoles(query, configs),
        key: (snapshot) => snapshot.id,
        decode: (snapshot) => decodeBuilder(snapshot, configs.get(snapshot.id)),
    };
    return { operation: "watch builders", targets: [target] };
};
