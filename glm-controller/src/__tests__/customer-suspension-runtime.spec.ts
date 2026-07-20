import { describe, expect, it, vi } from "vitest";
import {
  cancelStripeSubscription,
  deleteStripeCustomer,
  disableCreditAutoTopUp,
  pauseOwnedDedicatedGateway,
  revokeOwnerModelBrokerTokens,
} from "../lib/customer-ops/customer-suspension-runtime.js";

describe("cancelStripeSubscription", () => {
  it("cancels the subscription through Stripe's idempotent DELETE endpoint", async () => {
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 200 }));
    await cancelStripeSubscription(fetchImpl as typeof fetch, "sk_test_1", "sub_1");
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://api.stripe.com/v1/subscriptions/sub_1",
      expect.objectContaining({
        method: "DELETE",
        headers: { Authorization: "Bearer sk_test_1" },
      }),
    );
  });

  it("treats Stripe resource_missing as already cancelled", async () => {
    const fetchImpl = vi.fn(async () => new Response(
      JSON.stringify({ error: { code: "resource_missing" } }),
      { status: 404 },
    ));
    await expect(cancelStripeSubscription(
      fetchImpl as typeof fetch,
      "sk_test_1",
      "sub_gone",
    )).resolves.toBeUndefined();
  });

  it("surfaces every other Stripe failure", async () => {
    const fetchImpl = vi.fn(async () => new Response("rate limited", { status: 429 }));
    await expect(cancelStripeSubscription(
      fetchImpl as typeof fetch,
      "sk_test_1",
      "sub_1",
    )).rejects.toThrow(/429.*rate limited/);
  });
});

describe("deleteStripeCustomer", () => {
  it("deletes the Stripe customer and treats resource_missing as already erased", async () => {
    const deleted = vi.fn(async () => new Response("{}", { status: 200 }));
    await deleteStripeCustomer(deleted as typeof fetch, "sk_test_1", "cus_1");
    expect(deleted).toHaveBeenCalledWith(
      "https://api.stripe.com/v1/customers/cus_1",
      expect.objectContaining({ method: "DELETE" }),
    );

    const missing = vi.fn(async () => new Response(
      JSON.stringify({ error: { code: "resource_missing" } }),
      { status: 404 },
    ));
    await expect(deleteStripeCustomer(
      missing as typeof fetch,
      "sk_test_1",
      "cus_gone",
    )).resolves.toBeUndefined();
  });
});

describe("Firestore suspension fences", () => {
  it("revokes every owner token and deletes every owner pointer in one batch", async () => {
    const writes: string[] = [];
    const docs = (ids: string[]) => ids.map((id) => ({ id, ref: { path: id } }));
    const db = {
      collection: (name: string) => ({
        where: () => ({ get: async () => ({ docs: docs(name === "modelBrokerTokens" ? ["t1", "t2"] : ["p1"]) }) }),
      }),
      batch: () => ({
        set: (ref: { path: string }, data: Record<string, unknown>) => writes.push(`set:${ref.path}:${data.revokedAt}`),
        delete: (ref: { path: string }) => writes.push(`delete:${ref.path}`),
        commit: async () => undefined,
      }),
    };
    await revokeOwnerModelBrokerTokens(db as never, "uid-1", 50);
    expect(writes).toEqual(["set:t1:50", "set:t2:50", "delete:p1"]);
  });

  it("disables automatic top-up without deleting the financial balance", async () => {
    const set = vi.fn(async () => undefined);
    const db = { collection: () => ({ doc: () => ({ set }) }) };
    await disableCreditAutoTopUp(db as never, "uid-1", 60);
    expect(set).toHaveBeenCalledWith({
      autoTopUp: { enabled: false, disabledAt: 60, disabledReason: "account_suspended" },
    }, { merge: true });
  });

  it("pauses an owner-only dedicated gateway but leaves a shared gateway running", async () => {
    const dedicatedSet = vi.fn(async () => undefined);
    const sharedSet = vi.fn(async () => undefined);
    const db = {
      collection: () => ({
        doc: (id: string) => ({
          get: async () => ({
            exists: true,
            data: () => id === "dedicated"
              ? { ownerUid: "uid-1", coOwnerUids: [], gatewayClass: "builder" }
              : { ownerUid: null, coOwnerUids: [], gatewayClass: "shared" },
          }),
          set: id === "dedicated" ? dedicatedSet : sharedSet,
        }),
      }),
    };
    await pauseOwnedDedicatedGateway(db as never, "dedicated", "uid-1", 70);
    await pauseOwnedDedicatedGateway(db as never, "shared", "uid-1", 70);
    expect(dedicatedSet).toHaveBeenCalledWith({
      desiredStatus: "paused",
      updatedAt: 70,
      updatedBy: "customer-deletion-lifecycle",
    }, { merge: true });
    expect(sharedSet).not.toHaveBeenCalled();
  });
});
