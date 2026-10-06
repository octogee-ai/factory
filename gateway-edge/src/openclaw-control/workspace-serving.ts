import type { RollRosterStore } from "../roll-roster.js";

export type WorkspaceServingState = "serving" | "not-serving" | "roster-loading";

export type WorkspaceServingResolver = () => WorkspaceServingState;

export type WorkspaceServingDenial = "workspace-not-serving" | "roster-loading";

export function workspaceServingDenial(state: WorkspaceServingState): WorkspaceServingDenial | null {
  if (state === "serving") return null;
  return state === "roster-loading" ? "roster-loading" : "workspace-not-serving";
}

export function workspaceServingResolver(
  env: { GATEWAY_OWNER_UID?: string },
  store: Pick<RollRosterStore, "loaded" | "get"> | null,
): WorkspaceServingResolver {
  const ownerUid = env.GATEWAY_OWNER_UID?.trim();
  if (!ownerUid) return () => "serving";
  if (!store) return () => "roster-loading";
  return () => {
    if (!store.loaded()) return "roster-loading";
    return store.get(ownerUid)?.state === "serving" ? "serving" : "not-serving";
  };
}
