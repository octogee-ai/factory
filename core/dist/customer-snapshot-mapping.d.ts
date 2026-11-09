import type { FleetBrokerProjectAgent } from "@octogee/shared/types/fleet-broker";
import type { UserSnapshot } from "./customer-lifecycle.js";
import type { MattermostTokenSecret } from "./platform-state/secrets.js";
import type { PlatformStateRepositories } from "./platform-state/store.js";
type ChannelBinding = UserSnapshot["channels"][number];
export declare function mapWorkspaceChannelDoc(data: Record<string, unknown>): ChannelBinding | null;
export declare function mapProjectChannelDoc(projectId: string, data: Record<string, unknown>): ChannelBinding | null;
export type ProjectAgentCredential = Pick<MattermostTokenSecret, "mattermostUserId" | "personalToken">;
export declare function mapProjectAgentState(projectId: string, projectData: Record<string, unknown>, credential: ProjectAgentCredential | null): FleetBrokerProjectAgent | null;
type ProjectAgentStates = Array<NonNullable<ReturnType<typeof mapProjectAgentState>>>;
export declare function collectStoredProjectAgentStates(state: Pick<PlatformStateRepositories, "workspaces" | "secrets">, uid: string, slug: string): Promise<ProjectAgentStates>;
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
