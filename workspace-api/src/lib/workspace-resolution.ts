/**
 * Workspace slug resolution — resolves a URL slug to a user UID.
 *
 * Per DATA-MODEL-REVIEW v3 §2: username IS the workspace slug. The
 * `usernames/{username}` collection is the single claim. The pre-v3
 * `workspaceSlugs/` collection has been deleted.
 */
import { db } from "./db";

export async function resolveWorkspaceUid(slug: string): Promise<string | null> {
  const unDoc = await db.doc(`usernames/${slug}`).get();
  if (unDoc.exists) return unDoc.data()?.uid ?? null;
  return null;
}
