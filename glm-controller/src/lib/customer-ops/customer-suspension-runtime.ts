import type { Firestore } from "firebase-admin/firestore";
import {
  MODEL_BROKER_CREDITS_COLLECTION,
  MODEL_BROKER_GATEWAY_POINTERS_COLLECTION,
  MODEL_BROKER_TOKENS_COLLECTION,
} from "@octogee/shared/types/model-broker-usage";

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
