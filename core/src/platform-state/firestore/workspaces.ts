import {
  FieldPath,
  type CollectionReference,
  type DocumentData,
  type DocumentReference,
  type DocumentSnapshot,
  type Firestore,
  type Query,
} from "firebase-admin/firestore";
import {
  DuplicateRecordError,
  MalformedRecordError,
  MissingRecordError,
  UnsupportedOperationError,
  type RecordKey,
} from "../errors.js";
import type { OpaqueMap, Revision, Stored } from "../store.js";
import type {
  BuilderAgentIdentitiesRepository,
  BuilderAgentIdentity,
  WorkspaceChannel,
  WorkspaceChannelScope,
  WorkspaceChannelsRepository,
  WorkspaceMember,
  WorkspaceMemberRole,
  WorkspaceMembersRepository,
  WorkspaceProject,
  WorkspaceProjectMember,
  WorkspaceProjectMembersRepository,
  WorkspaceProjectsRepository,
  WorkspaceRecord,
  WorkspaceRecordsRepository,
  WorkspaceRepositories,
} from "../workspaces.js";
import { assertRevisionFence } from "./fences.js";
import type { FirestoreSession } from "./session.js";
import {
  decodeDocumentData,
  encodeMergeDocument,
  encodePatch,
  revisionOf,
  storedAsTimestamps,
  type FieldRepresentations,
} from "./values.js";
import type { FirestoreWatchSourceFactory, FirestoreWatchTarget } from "./watch.js";

export const WORKSPACES_COLLECTION = "workspaces";
export const AGENTS_COLLECTION = "agents";

const WORKSPACE_TIMES = storedAsTimestamps("createdAt", "updatedAt");
const MEMBER_TIMES = storedAsTimestamps("joinedAt");
const PROJECT_TIMES = storedAsTimestamps("archivedAt", "updatedAt", "agent.updatedAt", "agent.identity.avatar.updatedAt");
const CHANNEL_TIMES = storedAsTimestamps("archivedAt", "createdAt");
const AGENT_TIMES = storedAsTimestamps("createdAt", "updatedAt");
const MEMBER_ROLES: readonly WorkspaceMemberRole[] = ["owner", "member"];

type PlainObject = Record<string, unknown>;

function isPlainObject(value: unknown): value is PlainObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export class FirestoreFields {
  constructor(
    private readonly record: RecordKey,
    readonly data: PlainObject,
  ) {}

  private malformed(path: string, expected: string, value: unknown): MalformedRecordError {
    const found = value === undefined ? "absent" : JSON.stringify(value) ?? String(value);
    return new MalformedRecordError(this.record, `${path} must be ${expected}, found ${found}`);
  }

  value(path: string): unknown {
    let current: unknown = this.data;
    const segments = path.split(".");
    for (const [index, segment] of segments.entries()) {
      if (current === undefined || current === null) return undefined;
      if (!isPlainObject(current)) throw this.malformed(segments.slice(0, index).join("."), "a map", current);
      current = current[segment];
    }
    return current;
  }

  string(path: string): string {
    const value = this.value(path);
    if (typeof value !== "string") throw this.malformed(path, "a string", value);
    return value;
  }

  nullableString(path: string): string | null {
    const value = this.value(path);
    if (value === undefined || value === null) return null;
    if (typeof value !== "string") throw this.malformed(path, "a string or absent", value);
    return value;
  }

  number(path: string): number {
    const value = this.value(path);
    if (typeof value !== "number") throw this.malformed(path, "a number", value);
    return value;
  }

  nullableNumber(path: string): number | null {
    const value = this.value(path);
    if (value === undefined || value === null) return null;
    if (typeof value !== "number") throw this.malformed(path, "a number or absent", value);
    return value;
  }

  nullableBoolean(path: string): boolean | null {
    const value = this.value(path);
    if (value === undefined || value === null) return null;
    if (typeof value !== "boolean") throw this.malformed(path, "a boolean or absent", value);
    return value;
  }

  map(path: string): OpaqueMap {
    const value = this.value(path);
    if (!isPlainObject(value)) throw this.malformed(path, "a map", value);
    return value;
  }

  nullableMap(path: string): OpaqueMap | null {
    const value = this.value(path);
    if (value === undefined || value === null) return null;
    if (!isPlainObject(value)) throw this.malformed(path, "a map or absent", value);
    return value;
  }

  oneOf<T extends string>(path: string, allowed: readonly T[]): T {
    const value = this.value(path);
    if (!allowed.includes(value as T)) throw this.malformed(path, `one of ${allowed.join(", ")}`, value);
    return value as T;
  }
}

export function withStoredRevision<T>(snapshot: DocumentSnapshot, record: T): Stored<T> {
  return { ...record, revision: revisionOf(snapshot) };
}

function isPresent<T>(value: T | null): value is T {
  return value !== null;
}

function withoutNulls(map: PlainObject): PlainObject {
  const kept: PlainObject = {};
  for (const [key, value] of Object.entries(map)) {
    if (value === null || value === undefined) continue;
    if (isPlainObject(value) && Object.keys(value).length === 0) continue;
    kept[key] = value;
  }
  return kept;
}

function encodeMergePut(fields: PlainObject, representations: FieldRepresentations): DocumentData {
  return encodeMergeDocument(withoutNulls(fields), representations);
}

const workspaceKey = (slug: string): RecordKey => ({ aggregate: "workspace", key: slug });
const memberKey = (workspaceSlug: string, uid: string): RecordKey => ({
  aggregate: "workspace-member",
  key: `${workspaceSlug}/${uid}`,
});
const projectKey = (workspaceSlug: string, projectSlug: string): RecordKey => ({
  aggregate: "workspace-project",
  key: `${workspaceSlug}/${projectSlug}`,
});
const projectMemberKey = (workspaceSlug: string, projectSlug: string, uid: string): RecordKey => ({
  aggregate: "workspace-project-member",
  key: `${workspaceSlug}/${projectSlug}/${uid}`,
});
const channelKey = (scope: WorkspaceChannelScope, channelId: string): RecordKey => ({
  aggregate: "workspace-channel",
  key: scope.projectSlug === null ? `${scope.workspaceSlug}/${channelId}` : `${scope.workspaceSlug}/${scope.projectSlug}/${channelId}`,
});
const agentIdentityKey = (uid: string): RecordKey => ({ aggregate: "builder-agent-identity", key: uid });

function workspaceRef(db: Firestore, slug: string): DocumentReference {
  return db.collection(WORKSPACES_COLLECTION).doc(slug);
}

function membersCollection(db: Firestore, workspaceSlug: string): CollectionReference {
  return workspaceRef(db, workspaceSlug).collection("members");
}

function projectsCollection(db: Firestore, workspaceSlug: string): CollectionReference {
  return workspaceRef(db, workspaceSlug).collection("projects");
}

function channelsCollection(db: Firestore, scope: WorkspaceChannelScope): CollectionReference {
  const workspace = workspaceRef(db, scope.workspaceSlug);
  const parent = scope.projectSlug === null ? workspace : workspace.collection("projects").doc(scope.projectSlug);
  return parent.collection("channels");
}

function memberPath(path: string): { workspaceSlug: string; uid: string } | null {
  const parts = path.split("/");
  if (parts.length !== 4 || parts[0] !== WORKSPACES_COLLECTION || parts[2] !== "members") return null;
  return { workspaceSlug: parts[1], uid: parts[3] };
}

function projectPath(path: string): { workspaceSlug: string; projectSlug: string } | null {
  const parts = path.split("/");
  if (parts.length !== 4 || parts[0] !== WORKSPACES_COLLECTION || parts[2] !== "projects") return null;
  return { workspaceSlug: parts[1], projectSlug: parts[3] };
}

function channelPath(path: string): { scope: WorkspaceChannelScope; channelId: string } | null {
  const parts = path.split("/");
  if (parts[0] !== WORKSPACES_COLLECTION) return null;
  if (parts.length === 4 && parts[2] === "channels") {
    return { scope: { workspaceSlug: parts[1], projectSlug: null }, channelId: parts[3] };
  }
  if (parts.length === 6 && parts[2] === "projects" && parts[4] === "channels") {
    return { scope: { workspaceSlug: parts[1], projectSlug: parts[3] }, channelId: parts[5] };
  }
  return null;
}

export function decodeWorkspace(snapshot: DocumentSnapshot): Stored<WorkspaceRecord> | null {
  if (!snapshot.exists) return null;
  return withStoredRevision(snapshot, workspaceRecordFromData(snapshot.id, decodeDocumentData(snapshot)));
}

export function workspaceRecordFromData(slug: string, data: PlainObject): WorkspaceRecord {
  const fields = new FirestoreFields(workspaceKey(slug), data);
  return {
    slug,
    id: fields.string("id"),
    ownerUid: fields.string("ownerUid"),
    ownerActive: fields.nullableBoolean("ownerActive"),
    mattermostTeamId: fields.nullableString("mattermost.teamId"),
    giteaOrgName: fields.nullableString("gitea.orgName"),
    giteaRepoName: fields.nullableString("gitea.repoName"),
    createdAt: fields.nullableNumber("createdAt"),
    updatedAt: fields.nullableNumber("updatedAt"),
  };
}

export function decodeWorkspaceMember(snapshot: DocumentSnapshot): Stored<WorkspaceMember> | null {
  const location = memberPath(snapshot.ref.path);
  if (!snapshot.exists || location === null) return null;
  return withStoredRevision(snapshot, workspaceMemberFromData(location.workspaceSlug, location.uid, decodeDocumentData(snapshot)));
}

export function workspaceMemberFromData(workspaceSlug: string, uid: string, data: PlainObject): WorkspaceMember {
  const fields = new FirestoreFields(memberKey(workspaceSlug, uid), data);
  return {
    workspaceSlug,
    uid,
    role: fields.oneOf("role", MEMBER_ROLES),
    joinedAt: fields.nullableNumber("joinedAt"),
    mattermostUserId: fields.nullableString("mattermostUserId"),
    mattermostChannelId: fields.nullableString("mattermostChannelId"),
    canonicalSource: fields.nullableString("canonicalSource"),
    canonicalState: fields.nullableString("canonicalState"),
  };
}

export function decodeWorkspaceProject(snapshot: DocumentSnapshot): Stored<WorkspaceProject> | null {
  const location = projectPath(snapshot.ref.path);
  if (!snapshot.exists || location === null) return null;
  return withStoredRevision(snapshot, workspaceProjectFromData(location.workspaceSlug, location.projectSlug, decodeDocumentData(snapshot)));
}

export function workspaceProjectFromData(workspaceSlug: string, projectSlug: string, data: PlainObject): WorkspaceProject {
  const fields = new FirestoreFields(projectKey(workspaceSlug, projectSlug), data);
  return {
    workspaceSlug,
    projectSlug,
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
  };
}

export function workspaceProjectMemberFromData(
  workspaceSlug: string,
  projectSlug: string,
  uid: string,
  data: PlainObject,
): WorkspaceProjectMember {
  const fields = new FirestoreFields(projectMemberKey(workspaceSlug, projectSlug, uid), data);
  return { workspaceSlug, projectSlug, uid, role: fields.oneOf("role", MEMBER_ROLES) };
}

export function decodeWorkspaceChannel(snapshot: DocumentSnapshot): Stored<WorkspaceChannel> | null {
  const location = channelPath(snapshot.ref.path);
  if (!snapshot.exists || location === null) return null;
  return withStoredRevision(snapshot, workspaceChannelFromData(location.scope, location.channelId, decodeDocumentData(snapshot)));
}

export function workspaceChannelFromData(scope: WorkspaceChannelScope, channelId: string, data: PlainObject): WorkspaceChannel {
  const fields = new FirestoreFields(channelKey(scope, channelId), data);
  return {
    scope,
    channelId,
    kind: fields.nullableString("kind"),
    mattermostChannelId: fields.nullableString("mattermost.channelId"),
    archivedAt: fields.nullableNumber("archivedAt"),
    createdBy: fields.nullableString("createdBy"),
    createdAt: fields.nullableNumber("createdAt"),
  };
}

export function decodeAgentIdentity(snapshot: DocumentSnapshot): Stored<BuilderAgentIdentity> | null {
  if (!snapshot.exists) return null;
  return withStoredRevision(snapshot, agentIdentityFromData(snapshot.id, decodeDocumentData(snapshot)));
}

export function agentIdentityFromData(uid: string, data: PlainObject): BuilderAgentIdentity {
  const fields = new FirestoreFields(agentIdentityKey(uid), data);
  return {
    uid,
    mattermostUserId: fields.nullableString("mattermost.userId"),
    createdAt: fields.nullableNumber("createdAt"),
    updatedAt: fields.nullableNumber("updatedAt"),
  };
}

function channelKeyString(snapshot: DocumentSnapshot): string {
  const location = channelPath(snapshot.ref.path);
  return location === null ? snapshot.ref.path : channelKey(location.scope, location.channelId).key;
}

interface FencedUpdateTarget {
  readonly name: string;
  readonly key: RecordKey;
  readonly ref: DocumentReference;
}

async function revisionFencedUpdate(
  session: FirestoreSession,
  target: FencedUpdateTarget,
  data: DocumentData,
  revision: Revision | undefined,
): Promise<void> {
  const { name, key, ref } = target;
  if (revision === undefined) {
    await session.update(name, key, ref, data);
    return;
  }
  await session.atomically(name, async (fenced) => {
    const current = await fenced.readForFence(name, ref);
    if (!current.exists) throw new MissingRecordError(key);
    assertRevisionFence(key, revision, revisionOf(current));
    await fenced.update(name, key, ref, data);
  });
}

function decodeAll<T>(
  docs: readonly DocumentSnapshot[],
  decode: (snapshot: DocumentSnapshot) => Stored<T> | null,
): Stored<T>[] {
  return docs.map(decode).filter(isPresent);
}

function createWorkspaceRecordsRepository(session: FirestoreSession): WorkspaceRecordsRepository {
  const ref = (slug: string) => workspaceRef(session.db, slug);

  return {
    async get(slug) {
      return decodeWorkspace(await session.read("workspaces.records.get", ref(slug)));
    },

    async listByOwner(ownerUid) {
      const query = session.db.collection(WORKSPACES_COLLECTION).where("ownerUid", "==", ownerUid);
      return decodeAll((await session.query("workspaces.records.listByOwner", query)).docs, decodeWorkspace);
    },

    async findByMattermostTeamId(mattermostTeamId) {
      const query = session.db
        .collection(WORKSPACES_COLLECTION)
        .where("mattermost.teamId", "==", mattermostTeamId)
        .limit(2);
      const { docs } = await session.query("workspaces.records.findByMattermostTeamId", query);
      if (docs.length > 1) {
        throw new DuplicateRecordError("workspace", "mattermostTeamId", mattermostTeamId, docs.map((doc) => doc.id));
      }
      return docs.length === 0 ? null : decodeWorkspace(docs[0]);
    },

    async put(record) {
      await session.merge(
        "workspaces.records.put",
        workspaceKey(record.slug),
        ref(record.slug),
        encodeMergePut(
          {
            id: record.id,
            slug: record.slug,
            ownerUid: record.ownerUid,
            ownerActive: record.ownerActive,
            mattermost: withoutNulls({ teamId: record.mattermostTeamId }),
            gitea: withoutNulls({ orgName: record.giteaOrgName, repoName: record.giteaRepoName }),
            createdAt: record.createdAt,
            updatedAt: record.updatedAt,
          },
          WORKSPACE_TIMES,
        ),
      );
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

function createWorkspaceMembersRepository(session: FirestoreSession): WorkspaceMembersRepository {
  const ref = (workspaceSlug: string, uid: string) => membersCollection(session.db, workspaceSlug).doc(uid);

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
      await session.merge(
        "workspaces.members.put",
        memberKey(member.workspaceSlug, member.uid),
        ref(member.workspaceSlug, member.uid),
        encodeMergePut(
          {
            id: member.uid,
            role: member.role,
            joinedAt: member.joinedAt,
            mattermostUserId: member.mattermostUserId,
            mattermostChannelId: member.mattermostChannelId,
            canonicalSource: member.canonicalSource,
            canonicalState: member.canonicalState,
          },
          MEMBER_TIMES,
        ),
      );
    },

    async delete(workspaceSlug, uid) {
      await session.delete("workspaces.members.delete", memberKey(workspaceSlug, uid), ref(workspaceSlug, uid));
    },
  };
}

function createWorkspaceProjectsRepository(session: FirestoreSession): WorkspaceProjectsRepository {
  const ref = (workspaceSlug: string, projectSlug: string) => projectsCollection(session.db, workspaceSlug).doc(projectSlug);
  const list = async (operation: string, query: Query) =>
    decodeAll((await session.query(operation, query)).docs, decodeWorkspaceProject);

  return {
    async get(workspaceSlug, projectSlug) {
      return decodeWorkspaceProject(await session.read("workspaces.projects.get", ref(workspaceSlug, projectSlug)));
    },

    list(workspaceSlug) {
      return list("workspaces.projects.list", projectsCollection(session.db, workspaceSlug));
    },

    listByOwner(ownerUid, workspaceSlug) {
      const scope: Query =
        workspaceSlug === undefined ? session.db.collectionGroup("projects") : projectsCollection(session.db, workspaceSlug);
      return list("workspaces.projects.listByOwner", scope.where("ownerUid", "==", ownerUid));
    },

    listAll() {
      return list("workspaces.projects.listAll", session.db.collectionGroup("projects"));
    },

    async put(project) {
      await session.merge(
        "workspaces.projects.put",
        projectKey(project.workspaceSlug, project.projectSlug),
        ref(project.workspaceSlug, project.projectSlug),
        encodeMergePut(
          {
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
          },
          PROJECT_TIMES,
        ),
      );
    },

    async patch(workspaceSlug, projectSlug, patch, fence) {
      const { commercialLifecycleStatus, ...rest } = patch;
      const data = {
        ...encodePatch(rest, PROJECT_TIMES),
        ...encodePatch({ status: commercialLifecycleStatus }, PROJECT_TIMES, "commercialLifecycle"),
      };
      await revisionFencedUpdate(
        session,
        { name: "workspaces.projects.patch", key: projectKey(workspaceSlug, projectSlug), ref: ref(workspaceSlug, projectSlug) },
        data,
        fence?.revision,
      );
    },

    async delete(workspaceSlug, projectSlug) {
      await session.delete(
        "workspaces.projects.delete",
        projectKey(workspaceSlug, projectSlug),
        ref(workspaceSlug, projectSlug),
      );
    },
  };
}

function createWorkspaceProjectMembersRepository(session: FirestoreSession): WorkspaceProjectMembersRepository {
  return {
    async get(workspaceSlug, projectSlug, uid) {
      const snapshot = await session.read(
        "workspaces.projectMembers.get",
        projectsCollection(session.db, workspaceSlug).doc(projectSlug).collection("members").doc(uid),
      );
      if (!snapshot.exists) return null;
      return withStoredRevision(snapshot, workspaceProjectMemberFromData(workspaceSlug, projectSlug, uid, decodeDocumentData(snapshot)));
    },
  };
}

function createWorkspaceChannelsRepository(session: FirestoreSession): WorkspaceChannelsRepository {
  const ref = (scope: WorkspaceChannelScope, channelId: string) => channelsCollection(session.db, scope).doc(channelId);

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
        throw new DuplicateRecordError(
          "workspace-channel",
          "mattermostChannelId",
          mattermostChannelId,
          docs.map(channelKeyString),
        );
      }
      return docs.length === 0 ? null : decodeWorkspaceChannel(docs[0]);
    },

    async put(channel) {
      await session.merge(
        "workspaces.channels.put",
        channelKey(channel.scope, channel.channelId),
        ref(channel.scope, channel.channelId),
        encodeMergePut(
          {
            id: channel.channelId,
            kind: channel.kind,
            mattermost: withoutNulls({ channelId: channel.mattermostChannelId }),
            archivedAt: channel.archivedAt,
            createdBy: channel.createdBy,
            createdAt: channel.createdAt,
          },
          CHANNEL_TIMES,
        ),
      );
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

function createAgentIdentitiesRepository(session: FirestoreSession): BuilderAgentIdentitiesRepository {
  const ref = (uid: string) => session.db.collection(AGENTS_COLLECTION).doc(uid);

  return {
    async get(uid) {
      return decodeAgentIdentity(await session.read("workspaces.agentIdentities.get", ref(uid)));
    },

    async listAll() {
      const snapshot = await session.query("workspaces.agentIdentities.listAll", session.db.collection(AGENTS_COLLECTION));
      return decodeAll(snapshot.docs, decodeAgentIdentity);
    },

    async put(identity) {
      await session.merge(
        "workspaces.agentIdentities.put",
        agentIdentityKey(identity.uid),
        ref(identity.uid),
        encodeMergePut(
          {
            id: identity.uid,
            mattermost: withoutNulls({ userId: identity.mattermostUserId }),
            createdAt: identity.at,
            updatedAt: identity.at,
          },
          AGENT_TIMES,
        ),
      );
    },

    async delete(uid) {
      await session.delete("workspaces.agentIdentities.delete", agentIdentityKey(uid), ref(uid));
    },
  };
}

export function createFirestoreWorkspaceRepositories(session: FirestoreSession): WorkspaceRepositories {
  return {
    records: createWorkspaceRecordsRepository(session),
    members: createWorkspaceMembersRepository(session),
    projects: createWorkspaceProjectsRepository(session),
    projectMembers: createWorkspaceProjectMembersRepository(session),
    channels: createWorkspaceChannelsRepository(session),
    agentIdentities: createAgentIdentitiesRepository(session),
  };
}

function queryTarget<R>(
  query: Query,
  decode: (snapshot: DocumentSnapshot) => Stored<R> | null,
  key: (snapshot: DocumentSnapshot) => RecordKey | null,
): FirestoreWatchTarget<R> {
  return { query, key: (snapshot) => key(snapshot)?.key ?? snapshot.ref.path, decode };
}

function descendantsOf(query: Query, parent: DocumentReference): Query {
  const firestore = parent.firestore;
  return query
    .where(FieldPath.documentId(), ">=", parent)
    .where(FieldPath.documentId(), "<", firestore.doc(`${parent.path}\u0001`));
}

function memberLocationKey(snapshot: DocumentSnapshot): RecordKey | null {
  const location = memberPath(snapshot.ref.path);
  return location === null ? null : memberKey(location.workspaceSlug, location.uid);
}

function projectLocationKey(snapshot: DocumentSnapshot): RecordKey | null {
  const location = projectPath(snapshot.ref.path);
  return location === null ? null : projectKey(location.workspaceSlug, location.projectSlug);
}

function channelLocationKey(snapshot: DocumentSnapshot): RecordKey | null {
  const location = channelPath(snapshot.ref.path);
  return location === null ? null : channelKey(location.scope, location.channelId);
}

export const firestoreWorkspacesWatchSource: FirestoreWatchSourceFactory<"workspaces"> = (db, filter) => {
  const collection = db.collection(WORKSPACES_COLLECTION);
  const query = filter.ownerUid === undefined ? collection : collection.where("ownerUid", "==", filter.ownerUid);
  return {
    operation: "watch workspaces",
    targets: [queryTarget(query, decodeWorkspace, (snapshot) => workspaceKey(snapshot.id))],
  };
};

export const firestoreWorkspaceMembersWatchSource: FirestoreWatchSourceFactory<"workspaceMembers"> = (db, filter) => {
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
  const scope: Query = workspaceSlug === undefined ? db.collectionGroup("members") : membersCollection(db, workspaceSlug);
  const query = uid === undefined ? scope : scope.where("id", "==", uid);
  return {
    operation: "watch workspaceMembers",
    targets: [queryTarget(query, decodeWorkspaceMember, memberLocationKey)],
  };
};

export const firestoreWorkspaceProjectsWatchSource: FirestoreWatchSourceFactory<"workspaceProjects"> = (db, filter) => {
  const query: Query =
    filter.workspaceSlug === undefined ? db.collectionGroup("projects") : projectsCollection(db, filter.workspaceSlug);
  return {
    operation: "watch workspaceProjects",
    targets: [queryTarget(query, decodeWorkspaceProject, projectLocationKey)],
  };
};

export const firestoreWorkspaceChannelsWatchSource: FirestoreWatchSourceFactory<"workspaceChannels"> = (db, filter) => {
  const { workspaceSlug } = filter;
  const group = db.collectionGroup("channels");
  const query = workspaceSlug === undefined ? group : descendantsOf(group, workspaceRef(db, workspaceSlug));
  const decode = (snapshot: DocumentSnapshot) => {
    const channel = decodeWorkspaceChannel(snapshot);
    return workspaceSlug === undefined || channel?.scope.workspaceSlug === workspaceSlug ? channel : null;
  };
  return {
    operation: "watch workspaceChannels",
    targets: [queryTarget(query, decode, channelLocationKey)],
  };
};

export const firestoreAgentIdentitiesWatchSource: FirestoreWatchSourceFactory<"agentIdentities"> = (db, filter) => {
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
