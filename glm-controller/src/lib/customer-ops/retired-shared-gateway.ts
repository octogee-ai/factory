import type { DocumentData, Firestore, QuerySnapshot } from "firebase-admin/firestore";
import type { KubeOps } from "../kube-ops.js";

export async function isRetiredSharedGateway(
  db: Firestore,
  gatewayId: string,
  readRuntimeAbsent: (gatewayId: string) => Promise<boolean>,
): Promise<boolean> {
  if (!/^shared-[a-z0-9]+$/.test(gatewayId)) return false;
  const proof = await readRetirementProof(db, gatewayId);
  if (!proof || !(await readRuntimeAbsent(gatewayId))) return false;
  return await readRetirementProof(db, gatewayId) === proof;
}

async function readRetirementProof(db: Firestore, gatewayId: string): Promise<string | null> {
  return db.runTransaction(async (transaction) => {
    const rootRef = db.collection("gateways").doc(gatewayId);
    const operationId = `shared-pool-retire-${gatewayId}`;
    const [rootSnap, runtime, operationSnap, assignments, users, operations] = await Promise.all([
      transaction.get(rootRef),
      transaction.get(db.collection("glmGateways").doc(gatewayId)),
      transaction.get(db.collection("glmOperations").doc(operationId)),
      transaction.get(rootRef.collection("assignments")),
      transaction.get(db.collection("users").where("provisioning.openclaw.gatewayId", "==", gatewayId)),
      transaction.get(db.collection("glmOperations").where("gatewayId", "==", gatewayId)),
    ]);
    const operation = operationSnap.data();
    const version = operation?.input?.retirementClaimVersion;
    if (runtime.exists || !assignments.empty || !users.empty ||
      retirementOperationIdentityMismatch(operation, gatewayId) ||
      retirementOperationRetainedResources(operation!) ||
      retirementOperationTimingMismatch(operation!, version)) return null;
    const root = rootSnap.data();
    if (rootSnap.exists && sharedRootRetirementMismatch(root, operationId, version)) return null;
    if (gatewayRecreationObserved(operations, operation!)) return null;
    return JSON.stringify([operationId, version, operation!.createdAt, operation!.completedAt]);
  });
}

function retirementOperationIdentityMismatch(operation: DocumentData | undefined, gatewayId: string): boolean {
  return operation?.kind !== "retire-gateway" || operation.status !== "succeeded" ||
    operation.gatewayId !== gatewayId || operation.input?.gatewayId !== gatewayId ||
    operation.input?.source !== "shared-pool-scaler";
}

function retirementOperationRetainedResources(operation: DocumentData): boolean {
  return operation.input?.retainData === true || operation.input?.retainServiceAccount === true;
}

function retirementOperationTimingMismatch(operation: DocumentData, version: number): boolean {
  return !Number.isInteger(version) || version <= 0 ||
    typeof operation.createdAt !== "number" || !Number.isFinite(operation.createdAt) ||
    typeof operation.completedAt !== "number" || !Number.isFinite(operation.completedAt) ||
    operation.completedAt < operation.createdAt;
}

function sharedRootRetirementMismatch(root: DocumentData | undefined, operationId: string, version: number): boolean {
  return root?.gatewayClass !== "shared" || root.ownerUid != null ||
    root.desiredStatus !== "retired" || root.retirementVersion !== version ||
    root.retirementClaim?.operationId !== operationId || root.retirementClaim.version !== version ||
    root.retirementClaim.phase !== "claimed";
}

function gatewayRecreationObserved(operations: QuerySnapshot, operation: DocumentData): boolean {
  return operations.docs.some((doc) => {
    const candidate = doc.data();
    return candidate.kind === "add-gateway" && (
      (candidate.status !== "succeeded" && candidate.status !== "failed") ||
      typeof candidate.createdAt !== "number" || !Number.isFinite(candidate.createdAt) ||
      candidate.createdAt >= operation.createdAt);
  });
}

export async function retiredSharedGatewayRuntimeAbsent(
  kubeOps: Pick<KubeOps, "readAvailableReplicas" | "readGatewayPodDiagnostics">,
  namespace: string,
  gatewayId: string,
  deploymentName: string,
): Promise<boolean> {
  if (await kubeOps.readAvailableReplicas({ namespace, name: deploymentName }) !== null) return false;
  const pods = await kubeOps.readGatewayPodDiagnostics({ namespace, gatewayId });
  return pods.status === "missing" && pods.totalPods === 0 && pods.pods.length === 0;
}
