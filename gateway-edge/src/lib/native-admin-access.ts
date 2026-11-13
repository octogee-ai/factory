import { openNativeUserClient } from "../openclaw-control/native-user-client.js";
import { resolveWorkspaceNativeIdentity, WorkspaceNativeAccessError } from "./workspace-native-access.js";

export interface NativeAdminAccess { gatewayId: string; workspaceSlug: string; canControl: boolean }
export type NativeAdminAccessOutcome =
  | ({ kind: "allowed" } & NativeAdminAccess)
  | { kind: "unauthenticated" }
  | { kind: "forbidden" }
  | { kind: "not_found" };
export async function resolveNativeAdminAccess(args: Parameters<typeof resolveWorkspaceNativeIdentity>[0]): Promise<NativeAdminAccessOutcome> {
  let identity;
  try { identity = await resolveWorkspaceNativeIdentity(args); }
  catch (error) {
    if (error instanceof WorkspaceNativeAccessError && [401, 403, 404].includes(error.status)) {
      if (error.status === 401) return { kind: "unauthenticated" };
      if (error.status === 404) return { kind: "not_found" };
      return { kind: "forbidden" };
    }
    throw error;
  }
  const client = await openNativeUserClient(identity.uid, identity.gatewayId, args.env);
  try {
    return client.scopes.has("operator.admin")
      ? { kind: "allowed", gatewayId: identity.gatewayId, workspaceSlug: identity.workspaceSlug, canControl: true }
      : { kind: "forbidden" };
  } finally { client.close(); }
}
