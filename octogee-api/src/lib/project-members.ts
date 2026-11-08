import type { Firestore } from "firebase-admin/firestore";

export async function projectMemberExists(
  db: Pick<Firestore, "doc">,
  workspaceSlug: string,
  projectSlug: string,
  uid: string,
): Promise<boolean> {
  return (await db.doc(`workspaces/${workspaceSlug}/projects/${projectSlug}/members/${uid}`).get()).exists;
}
