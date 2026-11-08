import { UnsupportedOperationError } from "../errors.js";
function unsupported(operation) {
    throw new UnsupportedOperationError("firestore", `channelIdentities.${operation}`, "backend-capability");
}
export function createFirestoreChannelIdentitiesRepository() {
    return {
        find: async () => unsupported("find"),
        listForOwner: async () => unsupported("listForOwner"),
        link: async () => unsupported("link"),
        unlink: async () => unsupported("unlink"),
    };
}
