import type { Firestore, Query, QuerySnapshot, Transaction } from "firebase-admin/firestore";
import { GATEWAYS_COLLECTION } from "@octogee/shared/types/fleet-controller";
import {
  deriveSharedGatewayPoolConfig,
  parseSharedGatewayAutoscalingConfig,
  type SharedGatewayAutoscalingConfig,
  type SharedGatewayPoolConfig,
  type SharedPoolMemberRoot,
} from "@octogee/shared/types/shared-gateway-pool";

export const ORCHESTRATOR_CONFIG_DOC_PATH = "config/orchestrator";

export function sharedClassGatewayQuery(db: Firestore): Query {
  return db.collection(GATEWAYS_COLLECTION).where("gatewayClass", "==", "shared");
}

export function sharedPoolMemberRootsFromSnapshot(snapshot: QuerySnapshot): SharedPoolMemberRoot[] {
  return snapshot.docs.map((doc) => {
    const data = doc.data() as Record<string, unknown>;
    return {
      gatewayId: doc.id,
      gatewayClass: data.gatewayClass,
      desiredStatus: data.desiredStatus,
    };
  });
}

export async function readSharedPoolMemberRoots(
  db: Firestore,
  transaction?: Transaction,
): Promise<SharedPoolMemberRoot[]> {
  const query = sharedClassGatewayQuery(db);
  const snapshot = transaction ? await transaction.get(query) : await query.get();
  return sharedPoolMemberRootsFromSnapshot(snapshot);
}

export async function readSharedGatewayPoolConfig(
  db: Firestore,
  transaction?: Transaction,
): Promise<SharedGatewayPoolConfig | null> {
  return deriveSharedGatewayPoolConfig(await readSharedPoolMemberRoots(db, transaction));
}

export class InvalidSharedGatewayAutoscalingConfigError extends Error {
  constructor() {
    super(`${ORCHESTRATOR_CONFIG_DOC_PATH}.sharedGatewayAutoscaling is invalid`);
  }
}

export async function readSharedGatewayAutoscalingConfig(
  db: Firestore,
  transaction?: Transaction,
): Promise<SharedGatewayAutoscalingConfig> {
  const reference = db.doc(ORCHESTRATOR_CONFIG_DOC_PATH);
  const snapshot = transaction ? await transaction.get(reference) : await reference.get();
  const data = snapshot.exists ? (snapshot.data() as Record<string, unknown> | undefined) : undefined;
  const config = parseSharedGatewayAutoscalingConfig(data?.sharedGatewayAutoscaling);
  if (config === null) throw new InvalidSharedGatewayAutoscalingConfigError();
  return config;
}
