export type MemberRole = 'owner' | 'member' | 'guest';
export interface Member {
    id: string;
    role: MemberRole;
    joinedAt: unknown;
}
