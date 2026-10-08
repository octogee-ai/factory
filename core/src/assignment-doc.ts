import { isMigrationProgressRecord } from "@octogee/shared/types/glm";
import { GATEWAYS_COLLECTION } from "@octogee/shared/types/fleet-controller";
import {
  GATEWAY_ASSIGNMENTS_SUBCOLLECTION,
  isAssignmentState,
  type AssignmentDoc,
  type AssignmentSource,
} from "@octogee/shared/types/gateway-releases";

// gateways/{gatewayId}/assignments/{uid} — which customers a gateway serves
// (GATEWAY-SIMPLE-ROLL-SPEC). This module owns reading/writing that layer.
// Bare user mirrors stay put; assignment docs carry the roster state the
// migration plane flips while a customer moves between gateways.

// Narrow structural surfaces — the real firebase-admin Firestore satisfies them
// (collection → doc → collection → doc/get), and tests fake exactly these.
interface AssignmentDocRef {
  get: () => Promise<{ exists: boolean; data: () => Record<string, unknown> | undefined }>;
  set: (data: Record<string, unknown>, options?: { merge?: boolean }) => Promise<unknown>;
  delete: () => Promise<unknown>;
}

interface AssignmentCollectionRef {
  doc: (id: string) => AssignmentDocRef;
  get: () => Promise<{
    docs: Array<{ id: string; data: () => Record<string, unknown> | undefined }>;
  }>;
}

export interface AssignmentFirestore {
  collection: (name: string) => {
    doc: (id: string) => { collection: (name: string) => AssignmentCollectionRef };
  };
}

function assignmentsCollection(
  db: AssignmentFirestore,
  gatewayId: string,
): AssignmentCollectionRef {
  return db
    .collection(GATEWAYS_COLLECTION)
    .doc(gatewayId)
    .collection(GATEWAY_ASSIGNMENTS_SUBCOLLECTION);
}

const ASSIGNMENT_SOURCES: ReadonlySet<AssignmentSource> = new Set<AssignmentSource>([
  "onboarding",
  "migrate-customer",
  "repair",
]);

// A parsed AssignmentDoc or null when the stored shape is not a complete
// assignment — a partial/junk doc must never be resolved as a mount signal.
// Revision-era fields (revisionId, release) on legacy docs are ignored; the
// cutover script normalizes sources (e.g. retired "rollout") when it runs.
// Legacy docs predate createdAt; their updatedAt is the closest serving-since we have.
function assignmentCreatedAt(data: Record<string, unknown>): number {
  if (typeof data.createdAt === "number") return data.createdAt;
  return typeof data.updatedAt === "number" ? data.updatedAt : 0;
}

export function parseAssignmentDoc(
  uid: string,
  data: Record<string, unknown> | undefined,
): AssignmentDoc | null {
  if (!data) return null;
  const slug = data.slug;
  const gatewayId = data.gatewayId;
  const source = data.source;
  if (
    typeof slug !== "string" ||
    typeof gatewayId !== "string" ||
    typeof source !== "string" ||
    !ASSIGNMENT_SOURCES.has(source as AssignmentSource)
  ) {
    return null;
  }
  return {
    uid,
    slug,
    gatewayId,
    source: source as AssignmentSource,
    state: isAssignmentState(data.state) ? data.state : "serving",
    epoch: typeof data.epoch === "number" && data.epoch >= 0 ? data.epoch : 0,
    createdAt: assignmentCreatedAt(data),
    updatedAt: typeof data.updatedAt === "number" ? data.updatedAt : 0,
    updatedByOperationId:
      typeof data.updatedByOperationId === "string" ? data.updatedByOperationId : null,
    ...(Array.isArray(data.handoffProgress)
      ? { handoffProgress: data.handoffProgress.filter(isMigrationProgressRecord) }
      : {}),
  };
}

export async function readAssignmentDocsForGateway(
  db: AssignmentFirestore,
  gatewayId: string,
): Promise<AssignmentDoc[]> {
  const snap = await assignmentsCollection(db, gatewayId).get();
  const out: AssignmentDoc[] = [];
  for (const doc of snap.docs) {
    const parsed = parseAssignmentDoc(doc.id, doc.data());
    if (parsed) out.push(parsed);
  }
  return out;
}

export async function readAssignmentDoc(
  db: AssignmentFirestore,
  gatewayId: string,
  uid: string,
): Promise<AssignmentDoc | null> {
  const snap = await assignmentsCollection(db, gatewayId).doc(uid).get();
  if (!snap.exists) return null;
  return parseAssignmentDoc(uid, snap.data());
}

export async function deleteAssignmentDoc(
  db: AssignmentFirestore,
  gatewayId: string,
  uid: string,
): Promise<void> {
  await assignmentsCollection(db, gatewayId).doc(uid).delete();
}
