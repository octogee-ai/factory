import { FieldValue, type Firestore } from "firebase-admin/firestore";

export interface CustomerErasureCollectionPolicy {
  customerKey?: "uid" | "slug" | "email";
  uidFields?: readonly string[];
  slugFields?: readonly string[];
  emailFields?: readonly string[];
  uidArrayFields?: readonly string[];
  emailArrayFields?: readonly string[];
}

export const CUSTOMER_ERASURE_COLLECTION_POLICIES = {
  users: { customerKey: "uid" },
  customerStats: { customerKey: "uid" },
  agents: { customerKey: "uid" },
  modelBrokerCredits: { customerKey: "uid" },
  operatorGatewayReservations: { customerKey: "uid" },
  trialGatewayClaims: { customerKey: "uid" },
  workspaces: { customerKey: "slug" },
  emailSuppressions: { customerKey: "email" },
  modelBrokerUsageEvents: { uidFields: ["ownerUid"] },
  modelBrokerUsageRollups: { uidFields: ["ownerUid"] },
  modelBrokerUsageWindows: { uidFields: ["ownerUid"] },
  modelBrokerWeekWindows: { uidFields: ["ownerUid"] },
  modelBrokerRateWindows: { uidFields: ["ownerKey"] },
  modelBrokerTokens: { uidFields: ["ownerUid"] },
  modelBrokerGatewayTokens: { uidFields: ["ownerUid"] },
  modelBrokerCreditTopups: { uidFields: ["ownerUid"] },
  connectFlows: { uidFields: ["uid"] },
  byosubFlows: { uidFields: ["uid"] },
  invites: {
    uidFields: [
      "inviteeUid",
      "inviterUid",
      "callerUid",
      "ownerUid",
      "createdBy",
      "redeemedBy",
      "acceptedBy",
      "revokedBy",
    ],
    emailFields: ["inviteeEmail", "email"],
  },
  channelInvites: { uidFields: ["createdBy"] },
  posts: { uidFields: ["authorUid"] },
  glmOperations: { uidFields: ["inputUid"] },
  feed: { uidFields: ["actorUid", "targetUid"] },
  stars: { uidFields: ["actorUid", "target.ownerUid"] },
  follows: { uidFields: ["actorUid", "target.ownerUid"] },
  gatewayTickets: { uidFields: ["uid"] },
  gatewayTicketMintLog: { uidFields: ["uid"] },
  openclawControlTickets: { uidFields: ["uid"] },
  openclawControlAudit: { uidFields: ["uid"] },
  channelSessionModelAudit: { uidFields: ["actorUid"] },
  builder_shell_sessions: { uidFields: ["attacherUid", "takenOverFromUid"] },
  chatArtifactJobs: {
    uidFields: ["ownerUid", "workspaceOwnerUid"],
    slugFields: ["workspaceSlug"],
  },
  cleanupJobs: { slugFields: ["slug"] },
  gateways: { uidArrayFields: ["coOwnerUids"] },
  email: { emailFields: ["to"], emailArrayFields: ["to"] },
  gatewayAccessGrants: {
    uidFields: ["ownerUid", "granteeUid", "createdByUid", "updatedByUid", "revokedByUid"],
  },
  gatewayAccessAudit: { uidFields: ["ownerUid", "actorUid", "granteeUid"] },
  gatewayAccessApprovals: {
    uidFields: ["ownerUid", "granteeUid", "confirmedByUid", "cancelledByUid"],
  },
  gatewayConnectionAssistance: { uidFields: ["ownerUid", "requesterUid"] },
  agentImports: { uidFields: ["uid"] },
  agentControls: {},
  glmGateways: {},
  platformConfig: {},
  revisionTombstones: {},
  systemTypingPhrases: {},
} as const satisfies Record<string, CustomerErasureCollectionPolicy>;

type PolicyEntry = [string, CustomerErasureCollectionPolicy];
const POLICY_ENTRIES = Object.entries(CUSTOMER_ERASURE_COLLECTION_POLICIES) as PolicyEntry[];

function policyQueries(key: "uidFields" | "slugFields" | "emailFields") {
  return POLICY_ENTRIES.flatMap(([collection, policy]) =>
    (policy[key] ?? []).map((field) => ({ collection, field })));
}

function policyArrayQueries(key: "uidArrayFields" | "emailArrayFields") {
  return POLICY_ENTRIES.flatMap(([collection, policy]) =>
    (policy[key] ?? []).map((field) => ({ collection, field })));
}

export const CUSTOMER_REFERENCE_QUERIES = policyQueries("uidFields");
export const CUSTOMER_SLUG_REFERENCE_QUERIES = policyQueries("slugFields");

export const CUSTOMER_GROUP_REFERENCE_QUERIES = [
  { collectionGroup: "members", field: "id" },
  { collectionGroup: "assignments", field: "uid" },
] as const;

export const CUSTOMER_ARRAY_REFERENCE_QUERIES = policyArrayQueries("uidArrayFields");
export const CUSTOMER_EMAIL_REFERENCE_QUERIES = policyQueries("emailFields");
export const CUSTOMER_EMAIL_ARRAY_REFERENCE_QUERIES = policyArrayQueries("emailArrayFields");

const CUSTOMER_KEYED_ROOTS = POLICY_ENTRIES
  .filter(([, policy]) => policy.customerKey === "uid")
  .map(([collection]) => collection);
const CUSTOMER_SLUG_KEYED_ROOTS = POLICY_ENTRIES
  .filter(([, policy]) => policy.customerKey === "slug")
  .map(([collection]) => collection);
const CUSTOMER_EMAIL_KEYED_ROOTS = POLICY_ENTRIES
  .filter(([, policy]) => policy.customerKey === "email")
  .map(([collection]) => collection);

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
    ...(slug ? CUSTOMER_SLUG_KEYED_ROOTS.map((collection) =>
      db.collection(collection).doc(slug)) : []),
    ...(email ? CUSTOMER_EMAIL_KEYED_ROOTS.map((collection) =>
      db.collection(collection).doc(email)) : []),
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
