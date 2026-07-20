import { FieldValue, type Firestore } from "firebase-admin/firestore";

export const CUSTOMER_REFERENCE_QUERIES = [
  { collection: "modelBrokerUsageEvents", field: "ownerUid" },
  { collection: "modelBrokerUsageRollups", field: "ownerUid" },
  { collection: "modelBrokerUsageWindows", field: "ownerUid" },
  { collection: "modelBrokerWeekWindows", field: "ownerUid" },
  { collection: "modelBrokerRateWindows", field: "ownerKey" },
  { collection: "modelBrokerTokens", field: "ownerUid" },
  { collection: "modelBrokerGatewayTokens", field: "ownerUid" },
  { collection: "modelBrokerCreditTopups", field: "ownerUid" },
  { collection: "connectFlows", field: "uid" },
  { collection: "byosubFlows", field: "uid" },
  { collection: "invites", field: "inviteeUid" },
  { collection: "invites", field: "inviterUid" },
  { collection: "invites", field: "callerUid" },
  { collection: "invites", field: "ownerUid" },
  { collection: "invites", field: "createdBy" },
  { collection: "invites", field: "redeemedBy" },
  { collection: "invites", field: "acceptedBy" },
  { collection: "invites", field: "revokedBy" },
  { collection: "channelInvites", field: "createdBy" },
  { collection: "posts", field: "authorUid" },
  { collection: "glmOperations", field: "inputUid" },
  { collection: "feed", field: "actorUid" },
  { collection: "feed", field: "targetUid" },
  { collection: "stars", field: "actorUid" },
  { collection: "stars", field: "target.ownerUid" },
  { collection: "follows", field: "actorUid" },
  { collection: "follows", field: "target.ownerUid" },
  { collection: "gatewayTickets", field: "uid" },
  { collection: "gatewayTicketMintLog", field: "uid" },
  { collection: "openclawControlTickets", field: "uid" },
  { collection: "openclawControlAudit", field: "uid" },
  { collection: "channelSessionModelAudit", field: "actorUid" },
  { collection: "builder_shell_sessions", field: "attacherUid" },
  { collection: "builder_shell_sessions", field: "takenOverFromUid" },
  { collection: "chatArtifactJobs", field: "ownerUid" },
  { collection: "chatArtifactJobs", field: "workspaceOwnerUid" },
] as const;

export const CUSTOMER_SLUG_REFERENCE_QUERIES = [
  { collection: "cleanupJobs", field: "slug" },
  { collection: "chatArtifactJobs", field: "workspaceSlug" },
] as const;

export const CUSTOMER_GROUP_REFERENCE_QUERIES = [
  { collectionGroup: "members", field: "id" },
] as const;

export const CUSTOMER_ARRAY_REFERENCE_QUERIES = [
  { collection: "gateways", field: "coOwnerUids" },
] as const;

export const CUSTOMER_EMAIL_REFERENCE_QUERIES = [
  { collection: "invites", field: "inviteeEmail" },
  { collection: "invites", field: "email" },
  { collection: "email", field: "to" },
] as const;

export const CUSTOMER_EMAIL_ARRAY_REFERENCE_QUERIES = [
  { collection: "email", field: "to" },
] as const;

const CUSTOMER_KEYED_ROOTS = [
  "users",
  "customerStats",
  "agents",
  "modelBrokerCredits",
  "operatorGatewayReservations",
  "trialGatewayClaims",
] as const;

type ErasureFirestore = Pick<Firestore, "collection" | "collectionGroup" | "recursiveDelete">;
type VerificationFirestore = Pick<Firestore, "collection" | "collectionGroup">;

function customerRootRefs(
  db: VerificationFirestore,
  uid: string,
  slug: string,
  email: string | null,
) {
  return [
    ...CUSTOMER_KEYED_ROOTS.map((collection) =>
      db.collection(collection).doc(uid)),
    ...(slug ? [db.collection("workspaces").doc(slug)] : []),
    ...(email ? [db.collection("emailSuppressions").doc(email)] : []),
  ];
}

async function referenceDocs(
  db: VerificationFirestore,
  uid: string,
  slug: string,
  email: string | null,
) {
  const snapshots = await Promise.all([
    ...CUSTOMER_REFERENCE_QUERIES.map((query) =>
      db.collection(query.collection).where(query.field, "==", uid).get()),
    ...CUSTOMER_SLUG_REFERENCE_QUERIES.map((query) =>
      db.collection(query.collection).where(query.field, "==", slug).get()),
    ...CUSTOMER_GROUP_REFERENCE_QUERIES.map((query) =>
      db.collectionGroup(query.collectionGroup).where(query.field, "==", uid).get()),
    ...(email
      ? CUSTOMER_EMAIL_REFERENCE_QUERIES.map((query) =>
          db.collection(query.collection).where(query.field, "==", email).get())
      : []),
  ]);
  return snapshots.flatMap((snapshot) => snapshot.docs);
}

async function arrayReferenceDocs(
  db: VerificationFirestore,
  uid: string,
) {
  const snapshots = await Promise.all(CUSTOMER_ARRAY_REFERENCE_QUERIES.map((query) =>
    db.collection(query.collection).where(query.field, "array-contains", uid).get()));
  return snapshots.flatMap((snapshot) => snapshot.docs);
}

async function emailArrayReferenceDocs(
  db: VerificationFirestore,
  email: string | null,
) {
  if (!email) return [];
  const snapshots = await Promise.all(CUSTOMER_EMAIL_ARRAY_REFERENCE_QUERIES.map((query) =>
    db.collection(query.collection).where(query.field, "array-contains", email).get()));
  return snapshots.flatMap((snapshot) => snapshot.docs);
}

function normalizedEmail(email: string | null): string | null {
  const normalized = email?.trim().toLowerCase() ?? "";
  return normalized.length > 0 ? normalized : null;
}

export async function eraseCustomerFirestore(
  db: ErasureFirestore,
  uid: string,
  slug: string,
  email: string | null,
  currentOperationId: string,
): Promise<void> {
  const normalized = normalizedEmail(email);
  const refs = customerRootRefs(db, uid, slug, normalized);
  const [references, arrays, emailArrays] = await Promise.all([
    referenceDocs(db, uid, slug, normalized),
    arrayReferenceDocs(db, uid),
    emailArrayReferenceDocs(db, normalized),
  ]);
  for (const doc of arrays) {
    await doc.ref.update({ coOwnerUids: FieldValue.arrayRemove(uid) });
  }
  for (const doc of references) {
    if (doc.ref.path === `glmOperations/${currentOperationId}`) continue;
    refs.push(doc.ref);
  }
  for (const doc of emailArrays) refs.push(doc.ref);
  const uniqueRefs = new Map(refs.map((ref) => [ref.path, ref]));
  for (const ref of uniqueRefs.values()) await db.recursiveDelete(ref);
}

export async function verifyCustomerFirestoreErasure(
  db: VerificationFirestore,
  uid: string,
  slug: string,
  email: string | null,
  currentOperationId: string,
): Promise<string[]> {
  const normalized = normalizedEmail(email);
  const refs = customerRootRefs(db, uid, slug, normalized);
  const [rootSnaps, references, arrays, emailArrays] = await Promise.all([
    Promise.all(refs.map((ref) => ref.get())),
    referenceDocs(db, uid, slug, normalized),
    arrayReferenceDocs(db, uid),
    emailArrayReferenceDocs(db, normalized),
  ]);
  const remaining = refs
    .filter((_ref, index) => rootSnaps[index]?.exists)
    .map((ref) => ref.path);
  for (const doc of references) {
    if (doc.ref.path !== `glmOperations/${currentOperationId}`) {
      remaining.push(doc.ref.path);
    }
  }
  for (const doc of arrays) remaining.push(doc.ref.path);
  for (const doc of emailArrays) remaining.push(doc.ref.path);
  return Array.from(new Set(remaining)).sort();
}
