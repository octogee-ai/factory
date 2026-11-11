import {
  GrpcStatus,
  type DocumentReference,
  type Firestore,
} from "firebase-admin/firestore";
import type { PlatformStateStore, PlatformStateTransaction } from "@octogee/core/platform-state";

export interface UserErasureCollectionPolicy {
  userKey?: "uid" | "email";
  ownsSubcollections?: true;
  uidFields?: readonly string[];
  slugFields?: readonly string[];
  emailFields?: readonly string[];
  emailArrayFields?: readonly string[];
}

export const USER_ERASURE_COLLECTION_POLICIES = {
  customerStats: { userKey: "uid" },
  modelBrokerCredits: { userKey: "uid" },
  emailSuppressions: { userKey: "email" },
  opsSupportQuestions: { uidFields: ["ownerUid"] },
  modelBrokerUsageEvents: { uidFields: ["ownerUid"] },
  modelBrokerUsageRollups: { uidFields: ["ownerUid"] },
  modelBrokerUsageWindows: { uidFields: ["ownerUid"] },
  modelBrokerWeekWindows: { uidFields: ["ownerUid"] },
  modelBrokerSignupOfferBudgets: { uidFields: ["ownerUid"] },
  modelBrokerRateWindows: { uidFields: ["ownerKey"] },
  modelBrokerCreditTopups: { uidFields: ["ownerUid"] },
  connectFlows: { uidFields: ["uid"] },
  desktopSignInCodes: { uidFields: ["uid"] },
  desktopSignInChallenges: {},
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
  feed: { uidFields: ["actorUid", "targetUid"] },
  stars: { uidFields: ["actorUid", "target.ownerUid"] },
  follows: { uidFields: ["actorUid", "target.ownerUid"] },
  gatewayTickets: { uidFields: ["uid"] },
  gatewayTicketMintLog: { uidFields: ["uid"] },
  openclawControlTickets: { uidFields: ["uid"] },
  channelSessionModelAudit: { uidFields: ["actorUid"] },
  chatArtifactJobs: {
    uidFields: ["ownerUid", "workspaceOwnerUid"],
    slugFields: ["workspaceSlug"],
  },
  cleanupJobs: { slugFields: ["slug"] },
  email: { emailFields: ["to"], emailArrayFields: ["to"], ownsSubcollections: true },
  gatewayAccessGrants: {
    uidFields: ["ownerUid", "granteeUid", "createdByUid", "updatedByUid", "revokedByUid"],
  },
  gatewayAccessAudit: { uidFields: ["ownerUid", "actorUid", "granteeUid"] },
  gatewayAccessApprovals: {
    uidFields: ["ownerUid", "granteeUid", "confirmedByUid", "cancelledByUid"],
  },
  gatewayConnectionAssistance: { uidFields: ["ownerUid", "requesterUid"] },
  productivityApprovals: { uidFields: ["ownerUid"] },
  agentProjectRuns: { uidFields: ["ownerUid"] },
  agentProjectRunOwnerLeases: { uidFields: ["ownerUid"] },
  projectPreviewAliases: { uidFields: ["ownerUid"] },
  projectPreviewStates: { uidFields: ["ownerUid"] },
  projectPreviews: { uidFields: ["ownerUid"] },
  agentImports: { uidFields: ["uid"] },
  revisionTombstones: {},
  systemTypingPhrases: {},
} as const satisfies Record<string, UserErasureCollectionPolicy>;

export const PLATFORM_STATE_ERASURE_COLLECTIONS = [
  "users",
  "agents",
  "workspaces",
  "glmOperations",
  "gatewayRecoveryReceipts",
  "gateways",
  "glmGateways",
  "modelBrokerTokens",
  "modelBrokerGatewayTokens",
  "platformConfig",
] as const;

type PolicyEntry = [string, UserErasureCollectionPolicy];
const POLICY_ENTRIES = Object.entries(USER_ERASURE_COLLECTION_POLICIES) as PolicyEntry[];

function policyQueries(key: "uidFields" | "slugFields" | "emailFields") {
  return POLICY_ENTRIES.flatMap(([collection, policy]) =>
    (policy[key] ?? []).map((field) => ({ collection, field })));
}

function policyArrayQueries(key: "emailArrayFields") {
  return POLICY_ENTRIES.flatMap(([collection, policy]) =>
    (policy[key] ?? []).map((field) => ({ collection, field })));
}

export const USER_REFERENCE_QUERIES = policyQueries("uidFields");
export const USER_SLUG_REFERENCE_QUERIES = policyQueries("slugFields");

export const USER_GROUP_REFERENCE_QUERIES = [
  { collectionGroup: "members", field: "id" },
] as const;

export const USER_EMAIL_REFERENCE_QUERIES = policyQueries("emailFields");
export const USER_EMAIL_ARRAY_REFERENCE_QUERIES = policyArrayQueries("emailArrayFields");

const USER_KEYED_ROOTS = POLICY_ENTRIES
  .filter(([, policy]) => policy.userKey === "uid")
  .map(([collection]) => collection);
const USER_EMAIL_KEYED_ROOTS = POLICY_ENTRIES
  .filter(([, policy]) => policy.userKey === "email")
  .map(([collection]) => collection);

const SUBCOLLECTION_OWNING_COLLECTIONS = new Set(POLICY_ENTRIES
  .filter(([, policy]) => policy.ownsSubcollections)
  .map(([collection]) => collection));

const RETRYABLE_LEAF_DELETE_CODES = new Set<number>([
  GrpcStatus.DEADLINE_EXCEEDED,
  GrpcStatus.RESOURCE_EXHAUSTED,
  GrpcStatus.ABORTED,
  GrpcStatus.INTERNAL,
  GrpcStatus.UNAVAILABLE,
]);
const MAX_LEAF_DELETE_ATTEMPTS = 5;
const PLATFORM_WRITE_BATCH_SIZE = 400;

type PlatformWrite = (transaction: PlatformStateTransaction) => Promise<void>;

type ErasureFirestore = Pick<
  Firestore,
  "collection" | "collectionGroup" | "recursiveDelete" | "bulkWriter"
>;
type VerificationFirestore = Pick<Firestore, "collection" | "collectionGroup">;

function userRootRefs(
  db: VerificationFirestore,
  uid: string,
  email: string | null,
) {
  return [
    ...USER_KEYED_ROOTS.map((collection) =>
      db.collection(collection).doc(uid)),
    ...(email ? USER_EMAIL_KEYED_ROOTS.map((collection) =>
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
    ...USER_REFERENCE_QUERIES.map((query) =>
      db.collection(query.collection).where(query.field, "==", uid).get()),
    ...USER_SLUG_REFERENCE_QUERIES.map((query) =>
      db.collection(query.collection).where(query.field, "==", slug).get()),
    ...USER_GROUP_REFERENCE_QUERIES.map((query) =>
      db.collectionGroup(query.collectionGroup).where(query.field, "==", uid).get()),
    ...(email
      ? USER_EMAIL_REFERENCE_QUERIES.map((query) =>
          db.collection(query.collection).where(query.field, "==", email).get())
      : []),
  ]);
  return snapshots.flatMap((snapshot) => snapshot.docs)
    .filter((doc) => !workspaceMemberPath(doc.ref.path));
}

function workspaceMemberPath(path: string): boolean {
  const segments = path.split("/");
  return segments.length === 4 && segments[0] === "workspaces" && segments[2] === "members";
}

async function emailArrayReferenceDocs(
  db: VerificationFirestore,
  email: string | null,
) {
  if (!email) return [];
  const snapshots = await Promise.all(USER_EMAIL_ARRAY_REFERENCE_QUERIES.map((query) =>
    db.collection(query.collection).where(query.field, "array-contains", email).get()));
  return snapshots.flatMap((snapshot) => snapshot.docs);
}

async function platformStateReferences(store: PlatformStateStore, uid: string, currentOperationId: string) {
  const [operations, receipts, assignments, members, projectMembers, tokens, pointers, accessRecords] = await Promise.all([
    store.journal.operations.listReferencingUid(uid),
    store.journal.recoveryReceipts.listReferencingUid(uid),
    store.gateways.assignments.listForUid(uid),
    store.workspaces.members.listForUid(uid),
    store.workspaces.projectMembers.listForUid(uid),
    store.access.modelBrokerTokens.listForOwner(uid),
    store.access.modelBrokerGatewayTokens.listForOwner(uid),
    store.access.listRecordsForUid(uid),
  ]);
  return {
    operations: operations.filter((operation) => operation.id !== currentOperationId),
    receipts,
    assignments,
    members,
    projectMembers,
    tokens,
    pointers,
    accessRecords,
  };
}

type PlatformStateReferences = Awaited<ReturnType<typeof platformStateReferences>>;

function platformStateReferencePaths(references: PlatformStateReferences): string[] {
  return [
    ...references.operations.map((operation) => `glmOperations/${operation.id}`),
    ...references.receipts.map((receipt) => `gatewayRecoveryReceipts/${receipt.id}`),
    ...references.assignments.map((assignment) => `gateways/${assignment.gatewayId}/assignments/${assignment.uid}`),
    ...references.members.map((member) => `workspaces/${member.workspaceSlug}/members/${member.uid}`),
    ...references.projectMembers.map((member) => `workspaces/${member.workspaceSlug}/projects/${member.projectSlug}/members/${member.uid}`),
    ...references.tokens.map((token) => `modelBrokerTokens/${token.tokenHash}`),
    ...references.pointers.map((pointer) => `modelBrokerGatewayTokens/${pointer.pointerKey}`),
    ...references.accessRecords,
  ];
}

function platformStateReferenceDeletes(references: PlatformStateReferences): PlatformWrite[] {
  return [
    ...references.operations.map((operation): PlatformWrite => (transaction) =>
      transaction.journal.operations.delete(operation.id)),
    ...references.receipts.map((receipt): PlatformWrite => (transaction) =>
      transaction.journal.recoveryReceipts.delete(receipt.id)),
    ...references.assignments.map((assignment): PlatformWrite => (transaction) =>
      transaction.gateways.assignments.delete(assignment.gatewayId, assignment.uid)),
    ...references.members.map((member): PlatformWrite => (transaction) =>
      transaction.workspaces.members.delete(member.workspaceSlug, member.uid)),
    ...references.projectMembers.map((member): PlatformWrite => (transaction) =>
      transaction.workspaces.projectMembers.delete(member.workspaceSlug, member.projectSlug, member.uid)),
    ...references.tokens.map((token): PlatformWrite => (transaction) =>
      transaction.access.modelBrokerTokens.delete(token.tokenHash)),
    ...references.pointers.map((pointer): PlatformWrite => (transaction) =>
      transaction.access.modelBrokerGatewayTokens.delete(pointer.pointerKey)),
  ];
}

async function erasePlatformState(
  store: PlatformStateStore,
  uid: string,
  slug: string,
  references: PlatformStateReferences,
): Promise<void> {
  const writes = platformStateReferenceDeletes(references);
  for (let offset = 0; offset < writes.length; offset += PLATFORM_WRITE_BATCH_SIZE) {
    const chunk = writes.slice(offset, offset + PLATFORM_WRITE_BATCH_SIZE);
    await store.transaction({ label: "customer-erasure.platform-references" }, async (transaction) => {
      for (const write of chunk) await write(transaction);
    });
  }
  await store.access.eraseForUid(uid);
  await store.workspaces.agentIdentities.delete(uid);
  if (slug) await store.workspaces.records.delete(slug);
  await store.users.records.delete(uid);
}

async function remainingPlatformState(
  store: PlatformStateStore,
  uid: string,
  slug: string,
  currentOperationId: string,
): Promise<string[]> {
  const [user, agentIdentity, workspace, ownedGateways, references] = await Promise.all([
    store.users.records.get(uid),
    store.workspaces.agentIdentities.get(uid),
    slug ? store.workspaces.records.get(slug) : null,
    store.gateways.roots.list({ ownerUid: uid }),
    platformStateReferences(store, uid, currentOperationId),
  ]);
  return [
    ...(user === null ? [] : [`users/${uid}`]),
    ...(agentIdentity === null ? [] : [`agents/${uid}`]),
    ...(workspace === null ? [] : [`workspaces/${slug}`]),
    ...ownedGateways.map((root) => `gateways/${root.gatewayId}`),
    ...platformStateReferencePaths(references),
  ];
}

function normalizedEmail(email: string | null): string | null {
  const normalized = email?.trim().toLowerCase() ?? "";
  return normalized.length > 0 ? normalized : null;
}

function ownsSubcollections(path: string): boolean {
  const segments = path.split("/");
  const collection = segments[segments.length - 2];
  return collection !== undefined && SUBCOLLECTION_OWNING_COLLECTIONS.has(collection);
}

async function deleteLeafRefs(db: ErasureFirestore, refs: DocumentReference[]): Promise<void> {
  if (refs.length === 0) return;
  const writer = db.bulkWriter();
  writer.onWriteError((error) =>
    RETRYABLE_LEAF_DELETE_CODES.has(error.code)
    && error.failedAttempts < MAX_LEAF_DELETE_ATTEMPTS);
  const settled = Promise.allSettled(refs.map((ref) => writer.delete(ref)));
  await writer.close();
  const failures = (await settled).filter((result) => result.status === "rejected");
  const first = failures[0];
  if (!first) return;
  throw new Error(
    `user erasure: ${failures.length} of ${refs.length} reference deletes failed — `
    + `${first.reason instanceof Error ? first.reason.message : String(first.reason)}`,
    { cause: first.reason },
  );
}

export interface UserFirestoreErasureDeps<Db> {
  store: PlatformStateStore;
  db: Db;
}

export async function eraseUserFirestore(
  { store, db }: UserFirestoreErasureDeps<ErasureFirestore>,
  uid: string,
  slug: string,
  email: string | null,
  currentOperationId: string,
): Promise<void> {
  const normalized = normalizedEmail(email);
  const roots = userRootRefs(db, uid, normalized);
  const [platformReferences, references, emailArrays] = await Promise.all([
    platformStateReferences(store, uid, currentOperationId),
    referenceDocs(db, uid, slug, normalized),
    emailArrayReferenceDocs(db, normalized),
  ]);
  const refs: DocumentReference[] = [
    ...roots,
    ...references.map((doc) => doc.ref),
    ...emailArrays.map((doc) => doc.ref),
  ];
  const rootPaths = new Set(roots.map((ref) => ref.path));
  const uniqueRefs = new Map(refs.map((ref) => [ref.path, ref]));
  const leafRefs: DocumentReference[] = [];
  for (const [path, ref] of uniqueRefs) {
    if (rootPaths.has(path) || ownsSubcollections(path)) {
      await db.recursiveDelete(ref);
      continue;
    }
    leafRefs.push(ref);
  }
  await deleteLeafRefs(db, leafRefs);
  await erasePlatformState(store, uid, slug, platformReferences);
}

export async function verifyUserFirestoreErasure(
  { store, db }: UserFirestoreErasureDeps<VerificationFirestore>,
  uid: string,
  slug: string,
  email: string | null,
  currentOperationId: string,
): Promise<string[]> {
  const normalized = normalizedEmail(email);
  const refs = userRootRefs(db, uid, normalized);
  const [rootSnaps, references, emailArrays, platformState] = await Promise.all([
    Promise.all(refs.map((ref) => ref.get())),
    referenceDocs(db, uid, slug, normalized),
    emailArrayReferenceDocs(db, normalized),
    remainingPlatformState(store, uid, slug, currentOperationId),
  ]);
  const remaining = refs
    .filter((_ref, index) => rootSnaps[index]?.exists)
    .map((ref) => ref.path);
  for (const doc of references) remaining.push(doc.ref.path);
  for (const doc of emailArrays) remaining.push(doc.ref.path);
  remaining.push(...platformState);
  return Array.from(new Set(remaining)).sort();
}
