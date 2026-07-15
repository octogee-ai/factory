export type CustomerChannelKind = "coach" | "general" | "admin" | "project";
export interface CustomerChannelMemberIds {
    customerMmUserId: string | null;
    coachMmUserId: string | null;
    adminMmUserId: string | null;
}
export declare function customerChannelMembers(kind: CustomerChannelKind, ids: CustomerChannelMemberIds): string[];
