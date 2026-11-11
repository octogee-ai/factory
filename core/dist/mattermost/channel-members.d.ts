export type UserChannelKind = "coach" | "general" | "admin" | "project";
export interface UserChannelMemberIds {
    customerMmUserId: string | null;
    defaultAgentMmUserId: string | null;
    adminMmUserId: string | null;
}
export declare function userChannelMembers(kind: UserChannelKind, ids: UserChannelMemberIds): string[];
