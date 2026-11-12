import { MalformedRecordError, type RecordKey } from "../errors.js";
import type { OpaqueMap } from "../store.js";
import type { UserAgentIdentity, WorkspaceChannel, WorkspaceChannelScope, WorkspaceMember, WorkspaceMemberRole, WorkspaceProject, WorkspaceProjectMember, WorkspaceRecord } from "../workspaces.js";

export const MEMBER_ROLES: readonly WorkspaceMemberRole[] = ["owner", "member"];

export type PlainObject = Record<string, unknown>;

export function isPlainObject(value: unknown): value is PlainObject {
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

export const workspaceKey = (slug: string): RecordKey => ({ aggregate: "workspace", key: slug });
export const memberKey = (workspaceSlug: string, uid: string): RecordKey => ({
  aggregate: "workspace-member",
  key: `${workspaceSlug}/${uid}`,
});
export const projectKey = (workspaceSlug: string, projectSlug: string): RecordKey => ({
  aggregate: "workspace-project",
  key: `${workspaceSlug}/${projectSlug}`,
});
export const projectMemberKey = (workspaceSlug: string, projectSlug: string, uid: string): RecordKey => ({
  aggregate: "workspace-project-member",
  key: `${workspaceSlug}/${projectSlug}/${uid}`,
});
export const channelKey = (scope: WorkspaceChannelScope, channelId: string): RecordKey => ({
  aggregate: "workspace-channel",
  key: scope.projectSlug === null ? `${scope.workspaceSlug}/${channelId}` : `${scope.workspaceSlug}/${scope.projectSlug}/${channelId}`,
});
export const agentIdentityKey = (uid: string): RecordKey => ({ aggregate: "builder-agent-identity", key: uid });

export function isWorkspaceReservation(data: PlainObject): boolean {
  return data.id === undefined && data.ownerUid === undefined;
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
    provisioningCleanup: fields.nullableMap("provisioningCleanup"),
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
  const key = projectMemberKey(workspaceSlug, projectSlug, uid);
  const fields = new FirestoreFields(key, data);
  const storedId = fields.value("id");
  if (storedId !== undefined && storedId !== uid) throw new MalformedRecordError(key, `id must be ${uid}, found ${String(storedId)}`);
  return { workspaceSlug, projectSlug, uid, role: fields.oneOf("role", MEMBER_ROLES), joinedAt: fields.nullableNumber("joinedAt") };
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

export function agentIdentityFromData(uid: string, data: PlainObject): UserAgentIdentity {
  const fields = new FirestoreFields(agentIdentityKey(uid), data);
  return {
    uid,
    mattermostUserId: fields.nullableString("mattermost.userId"),
    createdAt: fields.nullableNumber("createdAt"),
    updatedAt: fields.nullableNumber("updatedAt"),
  };
}
