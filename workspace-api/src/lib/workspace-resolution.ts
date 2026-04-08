/**
 * Workspace slug resolution — resolves a URL slug to a user UID.
 *
 * Fallback chain:
 *   1. workspaceSlugs/{slug} — canonical for new users (system-generated slugs)
 *   2. usernames/{slug}      — backward compat (old users where username === workspaceSlug)
 *
 * Returns null if neither collection has the slug.
 */
import { db } from "./db";

export async function resolveWorkspaceUid(slug: string): Promise<string | null> {
  // 1. Try workspaceSlugs (canonical)
  const wsDoc = await db.doc(`workspaceSlugs/${slug}`).get();
  if (wsDoc.exists) return wsDoc.data()?.uid ?? null;

  // 2. Fallback to usernames (backward compat for pre-decoupling users)
  const unDoc = await db.doc(`usernames/${slug}`).get();
  if (unDoc.exists) return unDoc.data()?.uid ?? null;

  return null;
}
