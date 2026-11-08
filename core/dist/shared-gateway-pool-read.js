import { GATEWAYS_COLLECTION } from "@octogee/shared/types/fleet-controller";
import { deriveSharedGatewayPoolConfig, parseSharedGatewayAutoscalingConfig, } from "@octogee/shared/types/shared-gateway-pool";
export const ORCHESTRATOR_CONFIG_DOC_PATH = "config/orchestrator";
export function sharedClassGatewayQuery(db) {
    return db.collection(GATEWAYS_COLLECTION).where("gatewayClass", "==", "shared");
}
function sharedPoolMemberRootsFromSnapshot(snapshot) {
    return snapshot.docs.map((doc) => {
        const data = doc.data();
        return {
            gatewayId: doc.id,
            gatewayClass: data.gatewayClass,
            desiredStatus: data.desiredStatus,
        };
    });
}
async function readSharedPoolMemberRoots(db, transaction) {
    const query = sharedClassGatewayQuery(db);
    const snapshot = transaction ? await transaction.get(query) : await query.get();
    return sharedPoolMemberRootsFromSnapshot(snapshot);
}
export async function readSharedGatewayPoolConfig(db, transaction) {
    return deriveSharedGatewayPoolConfig(await readSharedPoolMemberRoots(db, transaction));
}
export async function readSharedGatewayPoolConfigInStore(transaction) {
    const roots = await transaction.gateways.roots.list({ gatewayClass: "shared" });
    return deriveSharedGatewayPoolConfig(roots.map((root) => ({
        gatewayId: root.gatewayId,
        gatewayClass: root.gatewayClass,
        desiredStatus: root.desiredStatus,
    })));
}
export class InvalidSharedGatewayAutoscalingConfigError extends Error {
    constructor() {
        super(`${ORCHESTRATOR_CONFIG_DOC_PATH}.sharedGatewayAutoscaling is invalid`);
    }
}
export async function readSharedGatewayAutoscalingConfig(db, transaction) {
    const reference = db.doc(ORCHESTRATOR_CONFIG_DOC_PATH);
    const snapshot = transaction ? await transaction.get(reference) : await reference.get();
    const data = snapshot.exists ? snapshot.data() : undefined;
    const config = parseSharedGatewayAutoscalingConfig(data?.sharedGatewayAutoscaling);
    if (config === null)
        throw new InvalidSharedGatewayAutoscalingConfigError();
    return config;
}
