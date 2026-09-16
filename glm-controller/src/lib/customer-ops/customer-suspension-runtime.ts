import { FieldValue, type DocumentReference, type Firestore } from "firebase-admin/firestore";
import {
  MODEL_BROKER_CREDITS_COLLECTION,
  MODEL_BROKER_GATEWAY_POINTERS_COLLECTION,
  MODEL_BROKER_TOKENS_COLLECTION,
} from "@octogee/shared/types/model-broker-usage";
import { GLM_OPERATIONS_COLLECTION } from "@octogee/shared/types/glm";
import { GATEWAYS_COLLECTION } from "@octogee/shared/types/fleet-controller";
import { GATEWAY_ASSIGNMENTS_SUBCOLLECTION } from "@octogee/shared/types/gateway-releases";

const TERMINAL_STRIPE_SUBSCRIPTION_STATUSES = new Set(["canceled", "incomplete_expired"]);
const FIRESTORE_VISIBILITY_BATCH_SIZE = 400;

type VisibilityWrite = {
  kind: "update" | "delete";
  ref: DocumentReference;
};

function migrationOwnerUid(operation: Record<string, unknown>): string | null {
  if (typeof operation.inputUid === "string") return operation.inputUid;
  const input = operation.input;
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const uid = (input as Record<string, unknown>).uid;
  return typeof uid === "string" ? uid : null;
}

function migrationNeedsCancellationRequest(operation: Record<string, unknown>): boolean {
  if (operation.status === "running" || operation.customerMigrationV2 !== undefined) return true;
  const output = operation.output;
  if (!output || typeof output !== "object" || Array.isArray(output)) return false;
  const cleanup = (output as Record<string, unknown>).configCleanup;
  return cleanup !== null && typeof cleanup === "object";
}

export async function cancelCustomerMigrationsForSuspension(
  db: Pick<Firestore, "collection" | "runTransaction">,
  uid: string,
  now: number,
): Promise<void> {
  const snapshot = await db
    .collection(GLM_OPERATIONS_COLLECTION)
    .where("status", "in", ["pending", "running"])
    .get();
  for (const doc of snapshot.docs) {
    const operation = doc.data() as Record<string, unknown>;
    if (operation.kind !== "migrate-customer" || migrationOwnerUid(operation) !== uid) continue;
    await db.runTransaction(async (transaction) => {
      const fresh = await transaction.get(doc.ref);
      if (!fresh.exists) return;
      const current = fresh.data() as Record<string, unknown>;
      if (
        current.kind !== "migrate-customer" ||
        migrationOwnerUid(current) !== uid ||
        (current.status !== "pending" && current.status !== "running")
      ) return;
      if (migrationNeedsCancellationRequest(current)) {
        transaction.update(doc.ref, { cancellationRequestedAt: now });
        return;
      }
      transaction.update(doc.ref, {
        status: "failed",
        completedAt: now,
        error: "customer migration cancelled because the account was suspended",
        rolledBack: false,
        nextAttemptAt: FieldValue.delete(),
        waitingOn: FieldValue.delete(),
      });
    });
  }
}

export async function releaseCustomerPlacement(
  db: Pick<Firestore, "collection" | "runTransaction">,
  uid: string,
  capturedGatewayId: string | null,
): Promise<void> {
  const userRef = db.collection("users").doc(uid);
  const assignmentRef = (gatewayId: string) => db
    .collection(GATEWAYS_COLLECTION)
    .doc(gatewayId)
    .collection(GATEWAY_ASSIGNMENTS_SUBCOLLECTION)
    .doc(uid);
  await db.runTransaction(async (txn) => {
    const user = await txn.get(userRef);
    const provisioning = user.data()?.provisioning as Record<string, unknown> | undefined;
    const openclaw = provisioning?.openclaw as Record<string, unknown> | undefined;
    const currentGatewayId = typeof openclaw?.gatewayId === "string" ? openclaw.gatewayId : null;
    for (const gatewayId of new Set([capturedGatewayId, currentGatewayId])) {
      if (gatewayId) txn.delete(assignmentRef(gatewayId));
    }
    if (!user.exists || currentGatewayId === null) return;
    txn.update(userRef, {
      "provisioning.openclaw.gatewayId": FieldValue.delete(),
      "provisioning.openclaw.gatewayAssignedAt": FieldValue.delete(),
    });
  });
}

export async function deactivateCustomerVisibility(
  db: Pick<Firestore, "collection" | "collectionGroup" | "batch">,
  uid: string,
): Promise<void> {
  const [workspaces, projects, posts, ...socialSnapshots] = await Promise.all([
    db.collection("workspaces").where("ownerUid", "==", uid).get(),
    db.collectionGroup("projects").where("ownerUid", "==", uid).get(),
    db.collection("posts").where("authorUid", "==", uid).get(),
    db.collection("feed").where("actorUid", "==", uid).get(),
    db.collection("feed").where("targetUid", "==", uid).get(),
    db.collection("stars").where("actorUid", "==", uid).get(),
    db.collection("stars").where("target.ownerUid", "==", uid).get(),
    db.collection("follows").where("actorUid", "==", uid).get(),
    db.collection("follows").where("target.ownerUid", "==", uid).get(),
  ]);
  const writes: VisibilityWrite[] = [
    ...[...workspaces.docs, ...projects.docs, ...posts.docs].map((doc) => ({
      kind: "update" as const,
      ref: doc.ref,
    })),
    ...Array.from(new Map(
      socialSnapshots
        .flatMap((snapshot) => snapshot.docs)
        .map((doc) => [doc.ref.path, doc.ref]),
    ).values(), (ref) => ({ kind: "delete" as const, ref })),
  ];
  for (let offset = 0; offset < writes.length; offset += FIRESTORE_VISIBILITY_BATCH_SIZE) {
    const batch = db.batch();
    for (const write of writes.slice(offset, offset + FIRESTORE_VISIBILITY_BATCH_SIZE)) {
      if (write.kind === "update") batch.update(write.ref, { ownerActive: false });
      else batch.delete(write.ref);
    }
    await batch.commit();
  }
}

export async function listStripeCustomerIdsForUid(
  fetchImpl: typeof fetch,
  stripeSecretKey: string,
  uid: string,
): Promise<string[]> {
  const customerIds = new Set<string>();
  let pageToken: string | null = null;
  let hasMore = true;
  while (hasMore) {
    const query = new URLSearchParams({ query: `metadata['octogee_uid']:'${uid}'`, limit: "100" });
    if (pageToken) query.set("page", pageToken);
    const response = await fetchImpl(`https://api.stripe.com/v1/customers/search?${query}`, {
      headers: { Authorization: `Bearer ${stripeSecretKey}` },
    });
    const body = await response.text();
    if (!response.ok) {
      throw new Error(`Stripe customer search failed ${response.status}: ${body.slice(0, 300)}`);
    }
    let page: { data?: unknown; has_more?: unknown; next_page?: unknown };
    try {
      page = JSON.parse(body) as { data?: unknown; has_more?: unknown; next_page?: unknown };
    } catch {
      throw new Error("Stripe customer search returned invalid JSON");
    }
    if (!Array.isArray(page.data) || typeof page.has_more !== "boolean") {
      throw new Error("Stripe customer search returned a malformed page");
    }
    for (const customer of page.data as Array<{ id?: unknown }>) {
      if (typeof customer.id !== "string") {
        throw new Error("Stripe customer search returned a malformed customer");
      }
      customerIds.add(customer.id);
    }
    hasMore = page.has_more;
    if (hasMore && (typeof page.next_page !== "string" || page.next_page.length === 0)) {
      throw new Error("Stripe customer search pagination stalled");
    }
    pageToken = typeof page.next_page === "string" ? page.next_page : null;
  }
  return [...customerIds].sort();
}

export async function listLiveStripeSubscriptionIds(
  fetchImpl: typeof fetch,
  stripeSecretKey: string,
  customerId: string,
): Promise<string[]> {
  const live = new Set<string>();
  let startingAfter: string | null = null;
  let hasMore = true;
  while (hasMore) {
    const query = new URLSearchParams({ customer: customerId, status: "all", limit: "100" });
    if (startingAfter) query.set("starting_after", startingAfter);
    const response = await fetchImpl(`https://api.stripe.com/v1/subscriptions?${query}`, {
      headers: { Authorization: `Bearer ${stripeSecretKey}` },
    });
    const body = await response.text();
    if (!response.ok) {
      throw new Error(`Stripe subscription listing failed ${response.status}: ${body.slice(0, 300)}`);
    }
    let page: { data?: unknown; has_more?: unknown };
    try {
      page = JSON.parse(body) as { data?: unknown; has_more?: unknown };
    } catch {
      throw new Error("Stripe subscription listing returned invalid JSON");
    }
    if (!Array.isArray(page.data) || typeof page.has_more !== "boolean") {
      throw new Error("Stripe subscription listing returned a malformed page");
    }
    const subscriptions = page.data as Array<{ id?: unknown; status?: unknown }>;
    for (const subscription of subscriptions) {
      if (typeof subscription.id !== "string" || typeof subscription.status !== "string") {
        throw new Error("Stripe subscription listing returned a malformed subscription");
      }
      if (!TERMINAL_STRIPE_SUBSCRIPTION_STATUSES.has(subscription.status)) {
        live.add(subscription.id);
      }
    }
    hasMore = page.has_more;
    if (hasMore && subscriptions.length === 0) {
      throw new Error("Stripe subscription listing pagination stalled");
    }
    startingAfter = subscriptions.at(-1)?.id as string | null;
  }
  return [...live].sort();
}

export async function cancelStripeSubscription(
  fetchImpl: typeof fetch,
  stripeSecretKey: string,
  subscriptionId: string,
): Promise<void> {
  const response = await fetchImpl(
    `https://api.stripe.com/v1/subscriptions/${encodeURIComponent(subscriptionId)}`,
    {
      method: "DELETE",
      headers: { Authorization: `Bearer ${stripeSecretKey}` },
    },
  );
  if (response.ok) return;
  const body = await response.text();
  if (response.status === 404) {
    try {
      const parsed = JSON.parse(body) as { error?: { code?: unknown } };
      if (parsed.error?.code === "resource_missing") return;
    } catch {
      throw new Error(`Stripe cancellation failed ${response.status}: ${body.slice(0, 300)}`);
    }
  }
  throw new Error(`Stripe cancellation failed ${response.status}: ${body.slice(0, 300)}`);
}

export async function listOpenStripeCheckoutSessionIds(
  fetchImpl: typeof fetch,
  stripeSecretKey: string,
  customerId: string,
): Promise<string[]> {
  const sessionIds = new Set<string>();
  let startingAfter: string | null = null;
  let hasMore = true;
  while (hasMore) {
    const query = new URLSearchParams({ customer: customerId, status: "open", limit: "100" });
    if (startingAfter) query.set("starting_after", startingAfter);
    const response = await fetchImpl(`https://api.stripe.com/v1/checkout/sessions?${query}`, {
      headers: { Authorization: `Bearer ${stripeSecretKey}` },
    });
    const body = await response.text();
    if (!response.ok) {
      throw new Error(`Stripe checkout session listing failed ${response.status}: ${body.slice(0, 300)}`);
    }
    let page: { data?: unknown; has_more?: unknown };
    try {
      page = JSON.parse(body) as { data?: unknown; has_more?: unknown };
    } catch {
      throw new Error("Stripe checkout session listing returned invalid JSON");
    }
    if (!Array.isArray(page.data) || typeof page.has_more !== "boolean") {
      throw new Error("Stripe checkout session listing returned a malformed page");
    }
    const sessions = page.data as Array<{ id?: unknown }>;
    for (const session of sessions) {
      if (typeof session.id !== "string") {
        throw new Error("Stripe checkout session listing returned a malformed session");
      }
      sessionIds.add(session.id);
    }
    hasMore = page.has_more;
    if (hasMore && sessions.length === 0) {
      throw new Error("Stripe checkout session listing pagination stalled");
    }
    startingAfter = sessions.at(-1)?.id as string | null;
  }
  return [...sessionIds].sort();
}

export async function expireStripeCheckoutSession(
  fetchImpl: typeof fetch,
  stripeSecretKey: string,
  sessionId: string,
): Promise<void> {
  const response = await fetchImpl(
    `https://api.stripe.com/v1/checkout/sessions/${encodeURIComponent(sessionId)}/expire`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${stripeSecretKey}` },
    },
  );
  if (response.ok) return;
  const body = await response.text();
  if (response.status === 404) {
    try {
      const parsed = JSON.parse(body) as { error?: { code?: unknown } };
      if (parsed.error?.code === "resource_missing") return;
    } catch {
      throw new Error(`Stripe checkout session expiration failed ${response.status}: ${body.slice(0, 300)}`);
    }
  }
  throw new Error(`Stripe checkout session expiration failed ${response.status}: ${body.slice(0, 300)}`);
}

export async function invalidatePendingCredentialFlows(
  db: Pick<Firestore, "collection" | "batch">,
  uid: string,
): Promise<void> {
  const [connectorFlows, byosubFlows] = await Promise.all([
    db.collection("connectFlows").where("uid", "==", uid).get(),
    db.collection("byosubFlows").where("uid", "==", uid).get(),
  ]);
  const batch = db.batch();
  for (const flow of [...connectorFlows.docs, ...byosubFlows.docs]) batch.delete(flow.ref);
  await batch.commit();
}

export async function deleteStripeCustomer(
  fetchImpl: typeof fetch,
  stripeSecretKey: string,
  customerId: string,
): Promise<void> {
  const response = await fetchImpl(
    `https://api.stripe.com/v1/customers/${encodeURIComponent(customerId)}`,
    {
      method: "DELETE",
      headers: { Authorization: `Bearer ${stripeSecretKey}` },
    },
  );
  if (response.ok) return;
  const body = await response.text();
  if (response.status === 404) {
    try {
      const parsed = JSON.parse(body) as { error?: { code?: unknown } };
      if (parsed.error?.code === "resource_missing") return;
    } catch {
      throw new Error(`Stripe customer deletion failed ${response.status}: ${body.slice(0, 300)}`);
    }
  }
  throw new Error(`Stripe customer deletion failed ${response.status}: ${body.slice(0, 300)}`);
}

export async function revokeOwnerModelBrokerTokens(
  db: Pick<Firestore, "collection" | "batch">,
  uid: string,
  now: number,
): Promise<void> {
  const [tokens, pointers] = await Promise.all([
    db.collection(MODEL_BROKER_TOKENS_COLLECTION).where("ownerUid", "==", uid).get(),
    db
      .collection(MODEL_BROKER_GATEWAY_POINTERS_COLLECTION)
      .where("ownerUid", "==", uid)
      .get(),
  ]);
  const batch = db.batch();
  for (const token of tokens.docs) {
    batch.set(token.ref, { revoked: true, revokedAt: now }, { merge: true });
  }
  for (const pointer of pointers.docs) batch.delete(pointer.ref);
  await batch.commit();
}

export async function disableCreditAutoTopUp(
  db: Pick<Firestore, "collection">,
  uid: string,
  now: number,
): Promise<void> {
  await db.collection(MODEL_BROKER_CREDITS_COLLECTION).doc(uid).set(
    {
      autoTopUp: {
        enabled: false,
        disabledAt: now,
        disabledReason: "account_suspended",
      },
    },
    { merge: true },
  );
}
