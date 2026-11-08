import type { ChannelIdentitiesRepository } from "../channel-identities.js";
import { UnsupportedOperationError } from "../errors.js";

function unsupported(operation: string): never {
  throw new UnsupportedOperationError("firestore", `channelIdentities.${operation}`, "backend-capability");
}

export function createFirestoreChannelIdentitiesRepository(): ChannelIdentitiesRepository {
  return {
    find: async () => unsupported("find"),
    listForOwner: async () => unsupported("listForOwner"),
    link: async () => unsupported("link"),
    unlink: async () => unsupported("unlink"),
  };
}
