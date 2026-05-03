export type MemberRole = 'owner' | 'member' | 'guest';

export interface Member {
  /** Doc ID = Firebase UID. */
  id: string;
  role: MemberRole;
  joinedAt: unknown; // Firestore Timestamp
}
