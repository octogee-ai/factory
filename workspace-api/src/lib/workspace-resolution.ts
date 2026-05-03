import { readWorkspace } from "./firestoreReads";

export async function resolveWorkspaceUid(slug: string): Promise<string | null> {
  const workspace = await readWorkspace(slug);
  return workspace?.ownerUid ?? null;
}
