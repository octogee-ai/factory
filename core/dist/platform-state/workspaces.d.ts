import type { ClearField, OpaqueMap, RecordPatch, Revision, Stored, TimeInput } from "./store.js";
export interface WorkspaceRecord {
    readonly slug: string;
    readonly id: string;
    readonly ownerUid: string;
    readonly ownerActive: boolean | null;
    readonly mattermostTeamId: string | null;
    readonly giteaOrgName: string | null;
    readonly giteaRepoName: string | null;
    readonly createdAt: number | null;
    readonly updatedAt: number | null;
}
export type WorkspaceInput = Omit<WorkspaceRecord, "createdAt" | "updatedAt"> & {
    readonly createdAt: TimeInput | null;
    readonly updatedAt: TimeInput | null;
};
export type WorkspacePatch = RecordPatch<Omit<WorkspaceRecord, "updatedAt">, "slug" | "id"> & {
    readonly updatedAt?: TimeInput;
};
export interface WorkspaceRecordsRepository {
    get(slug: string): Promise<Stored<WorkspaceRecord> | null>;
    listByOwner(ownerUid: string): Promise<readonly Stored<WorkspaceRecord>[]>;
    put(record: WorkspaceInput): Promise<void>;
    patch(slug: string, patch: WorkspacePatch, fence?: {
        readonly revision?: Revision;
    }): Promise<void>;
    delete(slug: string): Promise<void>;
}
export type WorkspaceMemberRole = "owner" | "member";
export interface WorkspaceMember {
    readonly workspaceSlug: string;
    readonly uid: string;
    readonly role: WorkspaceMemberRole;
    readonly joinedAt: number | null;
    readonly mattermostUserId: string | null;
}
export interface WorkspaceMembersRepository {
    get(workspaceSlug: string, uid: string): Promise<Stored<WorkspaceMember> | null>;
    list(workspaceSlug: string): Promise<readonly Stored<WorkspaceMember>[]>;
    listForUid(uid: string): Promise<readonly Stored<WorkspaceMember>[]>;
    put(member: Omit<WorkspaceMember, "joinedAt"> & {
        readonly joinedAt: TimeInput | null;
    }): Promise<void>;
    delete(workspaceSlug: string, uid: string): Promise<void>;
}
export interface WorkspaceProject {
    readonly workspaceSlug: string;
    readonly projectSlug: string;
    readonly ownerUid: string;
    readonly ownerActive: boolean | null;
    readonly giteaRepoName: string | null;
    readonly provisioningState: string | null;
    readonly provisioningError: string | null;
    readonly pendingVisibility: string | null;
    readonly visibility: string | null;
    readonly checkoutEnabled: boolean | null;
    readonly status: string | null;
    readonly archived: boolean | null;
    readonly archivedAt: number | null;
    readonly commercialLifecycleStatus: string | null;
    readonly repoSource: OpaqueMap | null;
    readonly agent: OpaqueMap | null;
    readonly updatedAt: number | null;
}
export type WorkspaceProjectInput = Omit<WorkspaceProject, "archivedAt" | "updatedAt"> & {
    readonly archivedAt: TimeInput | null;
    readonly updatedAt: TimeInput | null;
};
export type WorkspaceProjectPatch = RecordPatch<Omit<WorkspaceProject, "archivedAt" | "updatedAt">, "workspaceSlug" | "projectSlug"> & {
    readonly archivedAt?: TimeInput | ClearField | null;
    readonly updatedAt?: TimeInput;
};
export interface WorkspaceProjectsRepository {
    get(workspaceSlug: string, projectSlug: string): Promise<Stored<WorkspaceProject> | null>;
    list(workspaceSlug: string): Promise<readonly Stored<WorkspaceProject>[]>;
    listByOwner(ownerUid: string, workspaceSlug?: string): Promise<readonly Stored<WorkspaceProject>[]>;
    listAll(): Promise<readonly Stored<WorkspaceProject>[]>;
    put(project: WorkspaceProjectInput): Promise<void>;
    patch(workspaceSlug: string, projectSlug: string, patch: WorkspaceProjectPatch, fence?: {
        readonly revision?: Revision;
    }): Promise<void>;
    delete(workspaceSlug: string, projectSlug: string): Promise<void>;
}
export interface WorkspaceChannelScope {
    readonly workspaceSlug: string;
    readonly projectSlug: string | null;
}
export interface WorkspaceChannel {
    readonly scope: WorkspaceChannelScope;
    readonly channelId: string;
    readonly kind: string | null;
    readonly mattermostChannelId: string | null;
    readonly archivedAt: number | null;
    readonly createdBy: string | null;
    readonly createdAt: number | null;
}
export interface WorkspaceChannelsRepository {
    get(scope: WorkspaceChannelScope, channelId: string): Promise<Stored<WorkspaceChannel> | null>;
    list(scope: WorkspaceChannelScope): Promise<readonly Stored<WorkspaceChannel>[]>;
    findByMattermostChannelId(mattermostChannelId: string): Promise<Stored<WorkspaceChannel> | null>;
    put(channel: Omit<WorkspaceChannel, "createdAt"> & {
        readonly createdAt: TimeInput | null;
    }): Promise<void>;
    patch(scope: WorkspaceChannelScope, channelId: string, patch: RecordPatch<WorkspaceChannel, "scope" | "channelId" | "createdAt">): Promise<void>;
    delete(scope: WorkspaceChannelScope, channelId: string): Promise<void>;
}
export interface BuilderAgentIdentity {
    readonly uid: string;
    readonly mattermostUserId: string | null;
    readonly createdAt: number | null;
    readonly updatedAt: number | null;
}
export interface BuilderAgentIdentitiesRepository {
    get(uid: string): Promise<Stored<BuilderAgentIdentity> | null>;
    listAll(): Promise<readonly Stored<BuilderAgentIdentity>[]>;
    put(identity: Omit<BuilderAgentIdentity, "createdAt" | "updatedAt"> & {
        readonly at: TimeInput;
    }): Promise<void>;
    delete(uid: string): Promise<void>;
}
export interface WorkspaceRepositories {
    readonly records: WorkspaceRecordsRepository;
    readonly members: WorkspaceMembersRepository;
    readonly projects: WorkspaceProjectsRepository;
    readonly channels: WorkspaceChannelsRepository;
    readonly agentIdentities: BuilderAgentIdentitiesRepository;
}
