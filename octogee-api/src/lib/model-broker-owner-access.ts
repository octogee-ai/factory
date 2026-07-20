import { accountAllowsInteractiveAccess } from "@octogee/shared/types/account-lifecycle";

interface OwnerAccessDb {
  collection: (name: string) => {
    doc: (id: string) => {
      get: () => Promise<{
        exists: boolean;
        data: () => Record<string, unknown> | undefined;
      }>;
    };
  };
}

export interface ModelBrokerOwnerAccessInput {
  gatewayId: string;
  ownerUid: string | null;
}

export type ModelBrokerOwnerAccessResolver = (
  input: ModelBrokerOwnerAccessInput,
) => Promise<boolean>;

export function createModelBrokerOwnerAccessResolver(
  db: OwnerAccessDb,
): ModelBrokerOwnerAccessResolver {
  return async (input) => {
    let ownerUid = input.ownerUid;
    if (!ownerUid) {
      const gateway = await db.collection("gateways").doc(input.gatewayId).get();
      const candidate = gateway.data()?.ownerUid;
      ownerUid = typeof candidate === "string" && candidate.length > 0
        ? candidate
        : null;
    }
    if (!ownerUid) return false;
    const user = await db.collection("users").doc(ownerUid).get();
    const data = user.exists ? user.data() : undefined;
    return data !== undefined && accountAllowsInteractiveAccess(data);
  };
}
