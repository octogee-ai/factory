import type { DocumentReference, Firestore } from "firebase-admin/firestore";
import {
  MODEL_BROKER_CREDITS_COLLECTION,
  MODEL_BROKER_GATEWAY_POINTERS_COLLECTION,
  MODEL_BROKER_TOKENS_COLLECTION,
} from "@octogee/shared/types/model-broker-usage";

const TERMINAL_STRIPE_SUBSCRIPTION_STATUSES = new Set(["canceled", "incomplete_expired"]);
const FIRESTORE_VISIBILITY_BATCH_SIZE = 400;

type VisibilityWrite = {
  kind: "update" | "delete";
  ref: DocumentReference;
};

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

export async function pauseOwnedDedicatedGateway(
  db: Pick<Firestore, "collection">,
  gatewayId: string,
  uid: string,
  now: number,
): Promise<void> {
  const ref = db.collection("gateways").doc(gatewayId);
  const snap = await ref.get();
  if (!snap.exists) return;
  const data = snap.data() as Record<string, unknown>;
  const coOwners = Array.isArray(data.coOwnerUids) ? data.coOwnerUids : [];
  const ownerOnly = data.ownerUid === uid && coOwners.length === 0;
  if (!ownerOnly || data.gatewayClass === "shared") return;
  await ref.set(
    {
      desiredStatus: "paused",
      updatedAt: now,
      updatedBy: "customer-deletion-lifecycle",
    },
    { merge: true },
  );
}
