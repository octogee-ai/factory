import type { Firestore } from "firebase-admin/firestore";
import { GLM_GATEWAYS_COLLECTION, GLM_OPERATIONS_COLLECTION, gatewayVmPodName, resolveGatewayRuntime } from "@octogee/shared/types/glm";
import { GATEWAYS_COLLECTION } from "@octogee/shared/types/fleet-controller";
import { configuredBuilderCredentialBootstrapAllowed } from "@octogee/core/gateway-live-release";
import { migrationCancellationDeferred } from "@octogee/core/fleet-state";
import { slugFromAssignedUser } from "@octogee/core/assigned-roster";
import type { BoundTenant } from "./sa-to-tenant.js";

function readPath(value: unknown, path: string): unknown {
  for (const key of path.split(".")) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    value = (value as Record<string, unknown>)[key];
  }
  return value;
}

export async function configuredBuilderPreparationAllowed(
  db: Firestore,
  bound: Extract<BoundTenant, { kind: "gateway" }>,
  slug: string,
  ownerUid: string,
): Promise<boolean> {
  if (bound.ownerUid !== ownerUid || !bound.podUid) return false;
  const gatewaySnap = await db.collection(GATEWAYS_COLLECTION).doc(bound.gatewayId).get();
  if (!configuredBuilderCredentialBootstrapAllowed(gatewaySnap.data(), {
    gatewayId: bound.gatewayId, podName: bound.podName, slug, uid: ownerUid,
  })) return false;
  const [userSnap, runtimeSnap, operations] = await Promise.all([
    db.collection("users").doc(ownerUid).get(),
    db.collection(GLM_GATEWAYS_COLLECTION).doc(bound.gatewayId).get(),
    db.collection(GLM_OPERATIONS_COLLECTION)
      .where("kind", "==", "migrate-customer")
      .where("inputUid", "==", ownerUid)
      .where("status", "==", "running")
      .get(),
  ]);
  const user = userSnap.data() as Record<string, unknown> | undefined;
  const sourceGatewayId = readPath(user, "provisioning.openclaw.gatewayId");
  if (typeof sourceGatewayId !== "string" || !sourceGatewayId || sourceGatewayId === bound.gatewayId || slugFromAssignedUser(user) !== slug) return false;
  const runtime = runtimeSnap.data() as Record<string, unknown> | undefined;
  if (runtime?.gatewayId !== bound.gatewayId) return false;
  if (!preparationRuntimeMatches(runtime, bound, slug, ownerUid)) return false;
  const matching = operations.docs.filter((doc) => preparationOperationMatches(doc.data(), doc.id, { ownerUid, sourceGatewayId, targetGatewayId: bound.gatewayId, slug }));
  return matching.length === 1;
}

function preparationRuntimeMatches(
  runtime: Record<string, unknown>,
  bound: Extract<BoundTenant, { kind: "gateway" }>,
  slug: string,
  ownerUid: string,
): boolean {
  const podUid = bound.podUid;
  if (!podUid) return false;
  if (resolveGatewayRuntime(runtime.runtime) === "gce-vm") {
    return /^\d+$/.test(podUid) &&
      readPath(runtime, "vm.instanceId") === bound.podUid &&
      readPath(runtime, "vmInstance.ownerUid") === ownerUid &&
      readPath(runtime, "vmInstance.builderSlug") === slug &&
      bound.podName === gatewayVmPodName(bound.gatewayId, podUid);
  }
  const pods = readPath(runtime, "kubernetes.pods");
  return Array.isArray(pods) && pods.some((pod) => pod?.uid === bound.podUid && pod?.name === bound.podName);
}

function preparationOperationMatches(
  operation: Record<string, unknown>,
  operationId: string,
  scope: { ownerUid: string; sourceGatewayId: string; targetGatewayId: string; slug: string },
): boolean {
  const { ownerUid, sourceGatewayId, targetGatewayId, slug } = scope;
  const input = operation.input as Record<string, unknown> | undefined;
  return operation.kind === "migrate-customer" && operation.status === "running" &&
    preparationCancellationDeferred(operation, operationId, slug) && !operation.cutoverCommittedAt && input?.uid === ownerUid &&
    input.fromGatewayId === sourceGatewayId && input.toGatewayId === targetGatewayId;
}


function preparationCancellationDeferred(operation: Record<string, unknown>, operationId: string, slug: string): boolean {
  if (operation.cancellationRequestedAt === undefined) return true;
  if (!Number.isSafeInteger(operation.startedAt) || Number(operation.startedAt) <= 0 ||
      !migrationCancellationDeferred(operation, operationId)) return false;
  const state = operation.customerMigrationV2 as Record<string, unknown> | undefined;
  if (state) {
    return state.slug === slug && state.migrationId === `mig-${operationId}` &&
      ["sourceQuiesced", "finalSynced", "targetVerified"].includes(String(state.phase)) && state.cutoverAt === undefined &&
      Number.isSafeInteger(state.sourceEpoch) && Number(state.sourceEpoch) >= 0;
  }
  return (operation.schedulerHandoff as { slug?: unknown } | undefined)?.slug === slug;
}
