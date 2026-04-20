/**
 * Workspace slug resolution — resolves a URL slug to a user UID.
 *
 * Per DATA-MODEL-REVIEW v3.1 §10.1: workspaces/{slug}.ownerUid is the
 * single source. The pre-v3.1 usernames/ collection has been deleted.
 */
import { readWorkspace } from "./firestoreReads";

export async function resolveWorkspaceUid(slug: string): Promise<string | null> {
  const workspace = await readWorkspace(slug);
  return workspace?.ownerUid ?? null;
}
