import { GATEWAYS_COLLECTION } from "@octogee/shared/types/fleet-controller";
import {
  GATEWAY_ASSIGNMENTS_SUBCOLLECTION,
  isAssignmentState,
  type AssignmentDoc,
  type AssignmentSource,
  type GatewayDoc,
} from "@octogee/shared/types/gateway-releases";

// gateways/{gatewayId}/assignments/{uid} — the revision-assignment layer
// (GATEWAY-RELEASES-SPEC "Placement and migration targeting"). This module owns
// reading/writing that layer and the pure placement-resolution rule. Bare user
// mirrors stay put; assignment docs carry the per-customer serving revision so a
// roll can migrate customers between two revisions of the same bare gateway.

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
  "rollout",
  "repair",
]);

// A parsed AssignmentDoc or null when the stored shape is not a complete
// assignment — a partial/junk doc must never be resolved as a mount signal.
export function parseAssignmentDoc(
  uid: string,
  data: Record<string, unknown> | undefined,
): AssignmentDoc | null {
  if (!data) return null;
  const slug = data.slug;
  const gatewayId = data.gatewayId;
  const revisionId = data.revisionId;
  const release = data.release;
  const source = data.source;
  if (
    typeof slug !== "string" ||
    typeof gatewayId !== "string" ||
    typeof revisionId !== "string" ||
    typeof release !== "number" ||
    typeof source !== "string" ||
    !ASSIGNMENT_SOURCES.has(source as AssignmentSource)
  ) {
    return null;
  }
  return {
    uid,
    slug,
    gatewayId,
    revisionId,
    release,
    source: source as AssignmentSource,
    // Pre-PR7 docs carry no roster fields: default to serving at epoch 0 (the
    // steady state before any flip) so they keep routing exactly as today.
    state: isAssignmentState(data.state) ? data.state : "serving",
    epoch: typeof data.epoch === "number" && data.epoch >= 0 ? data.epoch : 0,
    updatedAt: typeof data.updatedAt === "number" ? data.updatedAt : 0,
    updatedByOperationId:
      typeof data.updatedByOperationId === "string" ? data.updatedByOperationId : null,
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

// gateways/{gatewayId}.liveRevisionId — the revision serving traffic, used as the
// gap-user placement fallback (an approved user with no assignment doc mounts on
// the live revision). Null pre-backfill (no desired doc yet) — callers must treat
// null as "unknown", never as an exclusion.
interface GatewayDocReader {
  collection: (name: string) => { doc: (id: string) => AssignmentDocRef };
}

export async function readLiveRevisionId(
  db: GatewayDocReader,
  gatewayId: string,
): Promise<string | null> {
  const snap = await db.collection(GATEWAYS_COLLECTION).doc(gatewayId).get();
  if (!snap.exists) return null;
  const live = snap.data()?.liveRevisionId;
  return typeof live === "string" ? live : null;
}

// The revision-aware mount decision (GATEWAY-RELEASES-SPEC). An approved user
// mounts on the pod's revision iff:
//   - the pod has NO revision (legacy pod) → mount (byte-identical to today); or
//   - the user has an assignment doc → only on that assignment's revision; or
//   - the user is a gap user (no assignment doc) → only on the LIVE revision
//     (never on both revisions of a rolling gateway). When the live revision is
//     unknown (pre-backfill), a gap user still mounts — the safe default that
//     preserves today's single-revision behavior.
// Approval is decided by the caller from the user mirror; this predicate never
// re-decides approval.
export function mountsOnRevision(input: {
  podRevisionId: string;
  liveRevisionId: string | null;
  assignmentRevisionId: string | null;
}): boolean {
  if (!input.podRevisionId) return true;
  if (input.assignmentRevisionId != null) {
    return input.assignmentRevisionId === input.podRevisionId;
  }
  if (input.liveRevisionId == null) return true;
  return input.podRevisionId === input.liveRevisionId;
}

// Placement resolution rule (GATEWAY-RELEASES-SPEC "Placement and migration
// targeting"): the destination revision for a new/migrated assignment is the
// roll target while the roll is accepting new assignments, else the live
// revision. A resolved-but-not-ready revision is rejected — never place onto a
// revision that cannot yet serve.
export type PlacementRejectReason = "no-live-revision" | "revision-not-ready";

export type PlacementResolution =
  | { ok: true; revisionId: string; release: number | null }
  | { ok: false; reason: PlacementRejectReason };

export function resolvePlacementRevision(input: {
  gateway: Pick<GatewayDoc, "roll" | "liveRevisionId" | "liveRelease">;
  isRevisionReady: (revisionId: string) => boolean;
}): PlacementResolution {
  const { gateway, isRevisionReady } = input;
  const roll = gateway.roll;
  const revisionId =
    roll && roll.acceptingNewAssignments ? roll.targetRevisionId : gateway.liveRevisionId;
  const release =
    roll && roll.acceptingNewAssignments ? roll.toRelease : gateway.liveRelease;
  if (!revisionId) return { ok: false, reason: "no-live-revision" };
  if (!isRevisionReady(revisionId)) return { ok: false, reason: "revision-not-ready" };
  return { ok: true, revisionId, release };
}
