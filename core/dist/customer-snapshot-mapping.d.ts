import type { UserSnapshot } from "./customer-lifecycle.js";
type ChannelBinding = UserSnapshot["channels"][number];
export declare function mapWorkspaceChannelDoc(data: Record<string, unknown>): ChannelBinding | null;
export declare function mapProjectChannelDoc(projectId: string, data: Record<string, unknown>): ChannelBinding | null;
export declare function mapProjectAgentState(projectId: string, projectData: Record<string, unknown>, secretData: Record<string, unknown> | undefined): {
    projectId: string;
    enabled: boolean;
    mmUserId: string | null;
    token: string | null;
} | null;
interface SnapshotDocSnap {
    id: string;
    data(): Record<string, unknown> | undefined;
}
interface SnapshotDocRef {
    get(): Promise<{
        data(): Record<string, unknown> | undefined;
    }>;
    collection(name: string): SnapshotCollectionRef;
}
interface SnapshotCollectionRef {
    doc(id: string): SnapshotDocRef;
    get(): Promise<{
        docs: SnapshotDocSnap[];
    }>;
}
export interface ProjectAgentSnapshotDb {
    collection(name: string): SnapshotCollectionRef;
}
export declare function collectProjectAgentStates(db: ProjectAgentSnapshotDb, uid: string, slug: string): Promise<Array<NonNullable<ReturnType<typeof mapProjectAgentState>>>>;
export declare function deriveSlug(uid: string, data: Record<string, unknown>): string;
type SnapshotSystemConfig = NonNullable<UserSnapshot["systemConfig"]>;
export interface ByotSnapshotProjection {
    byotActive: boolean | null;
    systemConfig?: SnapshotSystemConfig;
}
export declare function byotSnapshotProjectionFromSystemConfig(sysData: Record<string, unknown> | undefined): ByotSnapshotProjection;
export declare function byotSystemConfigFromDoc(sysData: Record<string, unknown> | undefined): UserSnapshot["systemConfig"];
export declare function mapUserDocToSnapshot(uid: string, data: Record<string, unknown>, channels: UserSnapshot["channels"]): UserSnapshot;
export {};
