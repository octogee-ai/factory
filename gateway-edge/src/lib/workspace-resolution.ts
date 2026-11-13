import { platformStateStore } from "./platform-state.js";

export async function resolveWorkspaceUid(slug: string): Promise<string | null> {
  return (await platformStateStore.workspaces.records.get(slug))?.ownerUid ?? null;
}
