import { FieldPath, } from "firebase-admin/firestore";
import { DuplicateRecordError, MalformedRecordError, MissingRecordError, UnsupportedOperationError, } from "../errors.js";
import { assertRevisionFence } from "./fences.js";
import { decodeDocumentData, encodeMergeDocument, encodePatch, revisionOf, storedAsTimestamps, } from "./values.js";
export const WORKSPACES_COLLECTION = "workspaces";
export const AGENTS_COLLECTION = "agents";
const WORKSPACE_TIMES = storedAsTimestamps("createdAt", "updatedAt");
const MEMBER_TIMES = storedAsTimestamps("joinedAt");
const PROJECT_TIMES = storedAsTimestamps("archivedAt", "updatedAt", "agent.updatedAt");
const CHANNEL_TIMES = storedAsTimestamps("archivedAt", "createdAt");
const AGENT_TIMES = storedAsTimestamps("createdAt", "updatedAt");
const MEMBER_ROLES = ["owner", "member"];
function isPlainObject(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}
export class FirestoreFields {
    record;
    data;
    constructor(record, data) {
        this.record = record;
        this.data = data;
    }
    malformed(path, expected, value) {
        const found = value === undefined ? "absent" : JSON.stringify(value) ?? String(value);
        return new MalformedRecordError(this.record, `${path} must be ${expected}, found ${found}`);
    }
    value(path) {
        let current = this.data;
        const segments = path.split(".");
        for (const [index, segment] of segments.entries()) {
            if (current === undefined || current === null)
                return undefined;
            if (!isPlainObject(current))
                throw this.malformed(segments.slice(0, index).join("."), "a map", current);
            current = current[segment];
        }
        return current;
    }
    string(path) {
        const value = this.value(path);
        if (typeof value !== "string")
            throw this.malformed(path, "a string", value);
        return value;
    }
    nullableString(path) {
        const value = this.value(path);
        if (value === undefined || value === null)
            return null;
        if (typeof value !== "string")
            throw this.malformed(path, "a string or absent", value);
        return value;
    }
    number(path) {
        const value = this.value(path);
        if (typeof value !== "number")
            throw this.malformed(path, "a number", value);
        return value;
    }
    nullableNumber(path) {
        const value = this.value(path);
        if (value === undefined || value === null)
            return null;
        if (typeof value !== "number")
            throw this.malformed(path, "a number or absent", value);
        return value;
    }
    nullableBoolean(path) {
        const value = this.value(path);
        if (value === undefined || value === null)
            return null;
        if (typeof value !== "boolean")
            throw this.malformed(path, "a boolean or absent", value);
        return value;
    }
    map(path) {
        const value = this.value(path);
        if (!isPlainObject(value))
            throw this.malformed(path, "a map", value);
        return value;
    }
    nullableMap(path) {
        const value = this.value(path);
        if (value === undefined || value === null)
            return null;
        if (!isPlainObject(value))
            throw this.malformed(path, "a map or absent", value);
        return value;
    }
    oneOf(path, allowed) {
        const value = this.value(path);
        if (!allowed.includes(value))
            throw this.malformed(path, `one of ${allowed.join(", ")}`, value);
        return value;
    }
}
export function withStoredRevision(snapshot, record) {
    return { ...record, revision: revisionOf(snapshot) };
}
function isPresent(value) {
    return value !== null;
}
function withoutNulls(map) {
    const kept = {};
    for (const [key, value] of Object.entries(map)) {
        if (value === null || value === undefined)
            continue;
        if (isPlainObject(value) && Object.keys(value).length === 0)
            continue;
        kept[key] = value;
    }
    return kept;
}
function encodeMergePut(fields, representations) {
    return encodeMergeDocument(withoutNulls(fields), representations);
}
const workspaceKey = (slug) => ({ aggregate: "workspace", key: slug });
const memberKey = (workspaceSlug, uid) => ({
    aggregate: "workspace-member",
    key: `${workspaceSlug}/${uid}`,
});
const projectKey = (workspaceSlug, projectSlug) => ({
    aggregate: "workspace-project",
    key: `${workspaceSlug}/${projectSlug}`,
});
const channelKey = (scope, channelId) => ({
    aggregate: "workspace-channel",
    key: scope.projectSlug === null ? `${scope.workspaceSlug}/${channelId}` : `${scope.workspaceSlug}/${scope.projectSlug}/${channelId}`,
});
const agentIdentityKey = (uid) => ({ aggregate: "builder-agent-identity", key: uid });
function workspaceRef(db, slug) {
    return db.collection(WORKSPACES_COLLECTION).doc(slug);
}
function membersCollection(db, workspaceSlug) {
    return workspaceRef(db, workspaceSlug).collection("members");
}
function projectsCollection(db, workspaceSlug) {
    return workspaceRef(db, workspaceSlug).collection("projects");
}
function channelsCollection(db, scope) {
    const workspace = workspaceRef(db, scope.workspaceSlug);
    const parent = scope.projectSlug === null ? workspace : workspace.collection("projects").doc(scope.projectSlug);
    return parent.collection("channels");
}
function memberPath(path) {
    const parts = path.split("/");
    if (parts.length !== 4 || parts[0] !== WORKSPACES_COLLECTION || parts[2] !== "members")
        return null;
    return { workspaceSlug: parts[1], uid: parts[3] };
}
function projectPath(path) {
    const parts = path.split("/");
    if (parts.length !== 4 || parts[0] !== WORKSPACES_COLLECTION || parts[2] !== "projects")
        return null;
    return { workspaceSlug: parts[1], projectSlug: parts[3] };
}
function channelPath(path) {
    const parts = path.split("/");
    if (parts[0] !== WORKSPACES_COLLECTION)
        return null;
    if (parts.length === 4 && parts[2] === "channels") {
        return { scope: { workspaceSlug: parts[1], projectSlug: null }, channelId: parts[3] };
    }
    if (parts.length === 6 && parts[2] === "projects" && parts[4] === "channels") {
        return { scope: { workspaceSlug: parts[1], projectSlug: parts[3] }, channelId: parts[5] };
    }
    return null;
}
export function decodeWorkspace(snapshot) {
    if (!snapshot.exists)
        return null;
    const fields = new FirestoreFields(workspaceKey(snapshot.id), decodeDocumentData(snapshot));
    return withStoredRevision(snapshot, {
        slug: snapshot.id,
        id: fields.string("id"),
        ownerUid: fields.string("ownerUid"),
        ownerActive: fields.nullableBoolean("ownerActive"),
        mattermostTeamId: fields.nullableString("mattermost.teamId"),
        giteaOrgName: fields.nullableString("gitea.orgName"),
        giteaRepoName: fields.nullableString("gitea.repoName"),
        createdAt: fields.nullableNumber("createdAt"),
        updatedAt: fields.nullableNumber("updatedAt"),
    });
}
export function decodeWorkspaceMember(snapshot) {
    const location = memberPath(snapshot.ref.path);
    if (!snapshot.exists || location === null)
        return null;
    const fields = new FirestoreFields(memberKey(location.workspaceSlug, location.uid), decodeDocumentData(snapshot));
    return withStoredRevision(snapshot, {
        workspaceSlug: location.workspaceSlug,
        uid: location.uid,
        role: fields.oneOf("role", MEMBER_ROLES),
        joinedAt: fields.nullableNumber("joinedAt"),
        mattermostUserId: fields.nullableString("mattermostUserId"),
    });
}
export function decodeWorkspaceProject(snapshot) {
    const location = projectPath(snapshot.ref.path);
    if (!snapshot.exists || location === null)
        return null;
    const fields = new FirestoreFields(projectKey(location.workspaceSlug, location.projectSlug), decodeDocumentData(snapshot));
    return withStoredRevision(snapshot, {
        workspaceSlug: location.workspaceSlug,
        projectSlug: location.projectSlug,
        ownerUid: fields.string("ownerUid"),
        ownerActive: fields.nullableBoolean("ownerActive"),
        giteaRepoName: fields.nullableString("giteaRepoName"),
        provisioningState: fields.nullableString("provisioningState"),
        provisioningError: fields.nullableString("provisioningError"),
        pendingVisibility: fields.nullableString("pendingVisibility"),
        visibility: fields.nullableString("visibility"),
        checkoutEnabled: fields.nullableBoolean("checkoutEnabled"),
        status: fields.nullableString("status"),
        archived: fields.nullableBoolean("archived"),
        archivedAt: fields.nullableNumber("archivedAt"),
        commercialLifecycleStatus: fields.nullableString("commercialLifecycle.status"),
        repoSource: fields.nullableMap("repoSource"),
        agent: fields.nullableMap("agent"),
        updatedAt: fields.nullableNumber("updatedAt"),
    });
}
export function decodeWorkspaceChannel(snapshot) {
    const location = channelPath(snapshot.ref.path);
    if (!snapshot.exists || location === null)
        return null;
    const fields = new FirestoreFields(channelKey(location.scope, location.channelId), decodeDocumentData(snapshot));
    return withStoredRevision(snapshot, {
        scope: location.scope,
        channelId: location.channelId,
        kind: fields.nullableString("kind"),
        mattermostChannelId: fields.nullableString("mattermost.channelId"),
        archivedAt: fields.nullableNumber("archivedAt"),
        createdBy: fields.nullableString("createdBy"),
        createdAt: fields.nullableNumber("createdAt"),
    });
}
export function decodeAgentIdentity(snapshot) {
    if (!snapshot.exists)
        return null;
    const fields = new FirestoreFields(agentIdentityKey(snapshot.id), decodeDocumentData(snapshot));
    return withStoredRevision(snapshot, {
        uid: snapshot.id,
        mattermostUserId: fields.nullableString("mattermost.userId"),
        createdAt: fields.nullableNumber("createdAt"),
        updatedAt: fields.nullableNumber("updatedAt"),
    });
}
function channelKeyString(snapshot) {
    const location = channelPath(snapshot.ref.path);
    return location === null ? snapshot.ref.path : channelKey(location.scope, location.channelId).key;
}
async function revisionFencedUpdate(session, target, data, revision) {
    const { name, key, ref } = target;
    if (revision === undefined) {
        await session.update(name, key, ref, data);
        return;
    }
    await session.atomically(name, async (fenced) => {
        const current = await fenced.readForFence(name, ref);
        if (!current.exists)
            throw new MissingRecordError(key);
        assertRevisionFence(key, revision, revisionOf(current));
        await fenced.update(name, key, ref, data);
    });
}
function decodeAll(docs, decode) {
    return docs.map(decode).filter(isPresent);
}
function createWorkspaceRecordsRepository(session) {
    const ref = (slug) => workspaceRef(session.db, slug);
    return {
        async get(slug) {
            return decodeWorkspace(await session.read("workspaces.records.get", ref(slug)));
        },
        async listByOwner(ownerUid) {
            const query = session.db.collection(WORKSPACES_COLLECTION).where("ownerUid", "==", ownerUid);
            return decodeAll((await session.query("workspaces.records.listByOwner", query)).docs, decodeWorkspace);
        },
        async put(record) {
            await session.merge("workspaces.records.put", workspaceKey(record.slug), ref(record.slug), encodeMergePut({
                id: record.id,
                slug: record.slug,
                ownerUid: record.ownerUid,
                ownerActive: record.ownerActive,
                mattermost: withoutNulls({ teamId: record.mattermostTeamId }),
                gitea: withoutNulls({ orgName: record.giteaOrgName, repoName: record.giteaRepoName }),
                createdAt: record.createdAt,
                updatedAt: record.updatedAt,
            }, WORKSPACE_TIMES));
        },
        async patch(slug, patch, fence) {
            const { mattermostTeamId, giteaOrgName, giteaRepoName, ...rest } = patch;
            const data = {
                ...encodePatch(rest, WORKSPACE_TIMES),
                ...encodePatch({ teamId: mattermostTeamId }, WORKSPACE_TIMES, "mattermost"),
                ...encodePatch({ orgName: giteaOrgName, repoName: giteaRepoName }, WORKSPACE_TIMES, "gitea"),
            };
            await revisionFencedUpdate(session, { name: "workspaces.records.patch", key: workspaceKey(slug), ref: ref(slug) }, data, fence?.revision);
        },
        async delete(slug) {
            if (session.transactional) {
                throw new UnsupportedOperationError("firestore", "workspaces.records.delete", "backend-capability");
            }
            await session.db.recursiveDelete(ref(slug));
        },
    };
}
function createWorkspaceMembersRepository(session) {
    const ref = (workspaceSlug, uid) => membersCollection(session.db, workspaceSlug).doc(uid);
    return {
        async get(workspaceSlug, uid) {
            return decodeWorkspaceMember(await session.read("workspaces.members.get", ref(workspaceSlug, uid)));
        },
        async list(workspaceSlug) {
            const snapshot = await session.query("workspaces.members.list", membersCollection(session.db, workspaceSlug));
            return decodeAll(snapshot.docs, decodeWorkspaceMember);
        },
        async listForUid(uid) {
            const query = session.db.collectionGroup("members").where("id", "==", uid);
            return decodeAll((await session.query("workspaces.members.listForUid", query)).docs, decodeWorkspaceMember);
        },
        async put(member) {
            await session.merge("workspaces.members.put", memberKey(member.workspaceSlug, member.uid), ref(member.workspaceSlug, member.uid), encodeMergePut({
                id: member.uid,
                role: member.role,
                joinedAt: member.joinedAt,
                mattermostUserId: member.mattermostUserId,
            }, MEMBER_TIMES));
        },
        async delete(workspaceSlug, uid) {
            await session.delete("workspaces.members.delete", memberKey(workspaceSlug, uid), ref(workspaceSlug, uid));
        },
    };
}
function createWorkspaceProjectsRepository(session) {
    const ref = (workspaceSlug, projectSlug) => projectsCollection(session.db, workspaceSlug).doc(projectSlug);
    const list = async (operation, query) => decodeAll((await session.query(operation, query)).docs, decodeWorkspaceProject);
    return {
        async get(workspaceSlug, projectSlug) {
            return decodeWorkspaceProject(await session.read("workspaces.projects.get", ref(workspaceSlug, projectSlug)));
        },
        list(workspaceSlug) {
            return list("workspaces.projects.list", projectsCollection(session.db, workspaceSlug));
        },
        listByOwner(ownerUid, workspaceSlug) {
            const scope = workspaceSlug === undefined ? session.db.collectionGroup("projects") : projectsCollection(session.db, workspaceSlug);
            return list("workspaces.projects.listByOwner", scope.where("ownerUid", "==", ownerUid));
        },
        listAll() {
            return list("workspaces.projects.listAll", session.db.collectionGroup("projects"));
        },
        async put(project) {
            await session.merge("workspaces.projects.put", projectKey(project.workspaceSlug, project.projectSlug), ref(project.workspaceSlug, project.projectSlug), encodeMergePut({
                id: project.projectSlug,
                slug: project.projectSlug,
                workspaceId: project.workspaceSlug,
                ownerUid: project.ownerUid,
                ownerActive: project.ownerActive,
                giteaRepoName: project.giteaRepoName,
                provisioningState: project.provisioningState,
                provisioningError: project.provisioningError,
                pendingVisibility: project.pendingVisibility,
                visibility: project.visibility,
                checkoutEnabled: project.checkoutEnabled,
                status: project.status,
                archived: project.archived,
                archivedAt: project.archivedAt,
                commercialLifecycle: withoutNulls({ status: project.commercialLifecycleStatus }),
                repoSource: project.repoSource,
                agent: project.agent,
                updatedAt: project.updatedAt,
            }, PROJECT_TIMES));
        },
        async patch(workspaceSlug, projectSlug, patch, fence) {
            const { commercialLifecycleStatus, ...rest } = patch;
            const data = {
                ...encodePatch(rest, PROJECT_TIMES),
                ...encodePatch({ status: commercialLifecycleStatus }, PROJECT_TIMES, "commercialLifecycle"),
            };
            await revisionFencedUpdate(session, { name: "workspaces.projects.patch", key: projectKey(workspaceSlug, projectSlug), ref: ref(workspaceSlug, projectSlug) }, data, fence?.revision);
        },
        async delete(workspaceSlug, projectSlug) {
            await session.delete("workspaces.projects.delete", projectKey(workspaceSlug, projectSlug), ref(workspaceSlug, projectSlug));
        },
    };
}
function createWorkspaceChannelsRepository(session) {
    const ref = (scope, channelId) => channelsCollection(session.db, scope).doc(channelId);
    return {
        async get(scope, channelId) {
            return decodeWorkspaceChannel(await session.read("workspaces.channels.get", ref(scope, channelId)));
        },
        async list(scope) {
            const snapshot = await session.query("workspaces.channels.list", channelsCollection(session.db, scope));
            return decodeAll(snapshot.docs, decodeWorkspaceChannel);
        },
        async findByMattermostChannelId(mattermostChannelId) {
            const query = session.db
                .collectionGroup("channels")
                .where("mattermost.channelId", "==", mattermostChannelId)
                .limit(2);
            const { docs } = await session.query("workspaces.channels.findByMattermostChannelId", query);
            if (docs.length > 1) {
                throw new DuplicateRecordError("workspace-channel", "mattermostChannelId", mattermostChannelId, docs.map(channelKeyString));
            }
            return docs.length === 0 ? null : decodeWorkspaceChannel(docs[0]);
        },
        async put(channel) {
            await session.merge("workspaces.channels.put", channelKey(channel.scope, channel.channelId), ref(channel.scope, channel.channelId), encodeMergePut({
                id: channel.channelId,
                kind: channel.kind,
                mattermost: withoutNulls({ channelId: channel.mattermostChannelId }),
                archivedAt: channel.archivedAt,
                createdBy: channel.createdBy,
                createdAt: channel.createdAt,
            }, CHANNEL_TIMES));
        },
        async patch(scope, channelId, patch) {
            const { mattermostChannelId, ...rest } = patch;
            await session.update("workspaces.channels.patch", channelKey(scope, channelId), ref(scope, channelId), {
                ...encodePatch(rest, CHANNEL_TIMES),
                ...encodePatch({ channelId: mattermostChannelId }, CHANNEL_TIMES, "mattermost"),
            });
        },
        async delete(scope, channelId) {
            await session.delete("workspaces.channels.delete", channelKey(scope, channelId), ref(scope, channelId));
        },
    };
}
function createAgentIdentitiesRepository(session) {
    const ref = (uid) => session.db.collection(AGENTS_COLLECTION).doc(uid);
    return {
        async get(uid) {
            return decodeAgentIdentity(await session.read("workspaces.agentIdentities.get", ref(uid)));
        },
        async listAll() {
            const snapshot = await session.query("workspaces.agentIdentities.listAll", session.db.collection(AGENTS_COLLECTION));
            return decodeAll(snapshot.docs, decodeAgentIdentity);
        },
        async put(identity) {
            await session.merge("workspaces.agentIdentities.put", agentIdentityKey(identity.uid), ref(identity.uid), encodeMergePut({
                id: identity.uid,
                mattermost: withoutNulls({ userId: identity.mattermostUserId }),
                createdAt: identity.at,
                updatedAt: identity.at,
            }, AGENT_TIMES));
        },
        async delete(uid) {
            await session.delete("workspaces.agentIdentities.delete", agentIdentityKey(uid), ref(uid));
        },
    };
}
export function createFirestoreWorkspaceRepositories(session) {
    return {
        records: createWorkspaceRecordsRepository(session),
        members: createWorkspaceMembersRepository(session),
        projects: createWorkspaceProjectsRepository(session),
        channels: createWorkspaceChannelsRepository(session),
        agentIdentities: createAgentIdentitiesRepository(session),
    };
}
function queryTarget(query, decode, key) {
    return { query, key: (snapshot) => key(snapshot)?.key ?? snapshot.ref.path, decode };
}
function descendantsOf(query, parent) {
    const firestore = parent.firestore;
    return query
        .where(FieldPath.documentId(), ">=", parent)
        .where(FieldPath.documentId(), "<", firestore.doc(`${parent.path}\u0001`));
}
function memberLocationKey(snapshot) {
    const location = memberPath(snapshot.ref.path);
    return location === null ? null : memberKey(location.workspaceSlug, location.uid);
}
function projectLocationKey(snapshot) {
    const location = projectPath(snapshot.ref.path);
    return location === null ? null : projectKey(location.workspaceSlug, location.projectSlug);
}
function channelLocationKey(snapshot) {
    const location = channelPath(snapshot.ref.path);
    return location === null ? null : channelKey(location.scope, location.channelId);
}
export const firestoreWorkspacesWatchSource = (db, filter) => {
    const collection = db.collection(WORKSPACES_COLLECTION);
    const query = filter.ownerUid === undefined ? collection : collection.where("ownerUid", "==", filter.ownerUid);
    return {
        operation: "watch workspaces",
        targets: [queryTarget(query, decodeWorkspace, (snapshot) => workspaceKey(snapshot.id))],
    };
};
export const firestoreWorkspaceMembersWatchSource = (db, filter) => {
    const { workspaceSlug, uid } = filter;
    if (workspaceSlug !== undefined && uid !== undefined) {
        return {
            operation: "watch workspaceMembers",
            targets: [
                {
                    document: membersCollection(db, workspaceSlug).doc(uid),
                    key: memberKey(workspaceSlug, uid).key,
                    decode: decodeWorkspaceMember,
                },
            ],
        };
    }
    const scope = workspaceSlug === undefined ? db.collectionGroup("members") : membersCollection(db, workspaceSlug);
    const query = uid === undefined ? scope : scope.where("id", "==", uid);
    return {
        operation: "watch workspaceMembers",
        targets: [queryTarget(query, decodeWorkspaceMember, memberLocationKey)],
    };
};
export const firestoreWorkspaceProjectsWatchSource = (db, filter) => {
    const query = filter.workspaceSlug === undefined ? db.collectionGroup("projects") : projectsCollection(db, filter.workspaceSlug);
    return {
        operation: "watch workspaceProjects",
        targets: [queryTarget(query, decodeWorkspaceProject, projectLocationKey)],
    };
};
export const firestoreWorkspaceChannelsWatchSource = (db, filter) => {
    const { workspaceSlug } = filter;
    const group = db.collectionGroup("channels");
    const query = workspaceSlug === undefined ? group : descendantsOf(group, workspaceRef(db, workspaceSlug));
    const decode = (snapshot) => {
        const channel = decodeWorkspaceChannel(snapshot);
        return workspaceSlug === undefined || channel?.scope.workspaceSlug === workspaceSlug ? channel : null;
    };
    return {
        operation: "watch workspaceChannels",
        targets: [queryTarget(query, decode, channelLocationKey)],
    };
};
export const firestoreAgentIdentitiesWatchSource = (db, filter) => {
    const collection = db.collection(AGENTS_COLLECTION);
    if (filter.uid !== undefined) {
        return {
            operation: "watch agentIdentities",
            targets: [{ document: collection.doc(filter.uid), key: agentIdentityKey(filter.uid).key, decode: decodeAgentIdentity }],
        };
    }
    return {
        operation: "watch agentIdentities",
        targets: [queryTarget(collection, decodeAgentIdentity, (snapshot) => agentIdentityKey(snapshot.id))],
    };
};
