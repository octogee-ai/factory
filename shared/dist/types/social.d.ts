export interface StarTargetUser {
    type: 'builder';
    ownerUid: string;
    username: string;
}
export interface StarTargetProject {
    type: 'project';
    workspaceSlug: string;
    projectSlug: string;
    ownerUid: string;
}
export interface StarTargetPost {
    type: 'post';
    postId: string;
    ownerUid: string;
}
export type StarTarget = StarTargetUser | StarTargetProject | StarTargetPost;
export type FollowTarget = StarTargetUser | StarTargetProject;
export declare function starDocId(actorUid: string, target: StarTarget): string;
export declare function followDocId(actorUid: string, target: FollowTarget): string;
export declare function isStarTarget(v: unknown): v is StarTarget;
export declare function isFollowTarget(v: unknown): v is FollowTarget;
