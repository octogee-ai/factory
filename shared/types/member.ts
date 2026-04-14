/**
 * Canonical Member type — membership subcollection doc.
 *
 * Stored at `workspaces/{wid}/members/{uid}` (workspace members) or
 * `workspaces/{wid}/projects/{pid}/members/{uid}` (project members).
 * Doc ID = the member's Firebase UID. Per DATA-MODEL-REVIEW v3 §6.10.
 *
 * Replaces the pre-v3 `projects/{pid}.guestUids[]` array.
 */

export type MemberRole = 'owner' | 'member' | 'guest';

export interface Member {
  /** Doc ID = Firebase UID. */
  id: string;
  role: MemberRole;
  joinedAt: unknown; // Firestore Timestamp
}
