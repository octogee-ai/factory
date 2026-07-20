import { describe, expect, it, vi } from "vitest";
import {
  cancelStripeSubscription,
  deactivateCustomerVisibility,
  deleteStripeCustomer,
  disableCreditAutoTopUp,
  expireStripeCheckoutSession,
  invalidatePendingCredentialFlows,
  listOpenStripeCheckoutSessionIds,
  listLiveStripeSubscriptionIds,
  listStripeCustomerIdsForUid,
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

describe("listLiveStripeSubscriptionIds", () => {
  it("paginates every customer subscription and excludes terminal statuses", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        data: [
          { id: "sub_active", status: "active" },
          { id: "sub_canceled", status: "canceled" },
        ],
        has_more: true,
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        data: [
          { id: "sub_trial", status: "trialing" },
          { id: "sub_expired", status: "incomplete_expired" },
        ],
        has_more: false,
      }), { status: 200 }));

    await expect(listLiveStripeSubscriptionIds(
      fetchImpl as typeof fetch,
      "sk_test_1",
      "cus_1",
    )).resolves.toEqual(["sub_active", "sub_trial"]);
    expect(fetchImpl.mock.calls[1]?.[0]).toContain("starting_after=sub_canceled");
  });

  it("fails loudly when Stripe returns a malformed or failed listing", async () => {
    const failed = vi.fn(async () => new Response("rate limited", { status: 429 }));
    await expect(listLiveStripeSubscriptionIds(
      failed as typeof fetch,
      "sk_test_1",
      "cus_1",
    )).rejects.toThrow(/429.*rate limited/);
  });
});

describe("listStripeCustomerIdsForUid", () => {
  it("paginates every Stripe customer tagged with the Builder uid", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        data: [{ id: "cus_primary" }],
        has_more: true,
        next_page: "next-token",
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        data: [{ id: "cus_orphan" }],
        has_more: false,
      }), { status: 200 }));

    await expect(listStripeCustomerIdsForUid(
      fetchImpl as typeof fetch,
      "sk_test_1",
      "uid-1",
    )).resolves.toEqual(["cus_orphan", "cus_primary"]);
    expect(fetchImpl.mock.calls[0]?.[0]).toContain("customers/search");
    expect(fetchImpl.mock.calls[1]?.[0]).toContain("page=next-token");
  });
});

describe("open Stripe checkout sessions", () => {
  it("paginates every open session for a customer", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        data: [{ id: "cs_open_1" }],
        has_more: true,
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        data: [{ id: "cs_open_2" }],
        has_more: false,
      }), { status: 200 }));

    await expect(listOpenStripeCheckoutSessionIds(
      fetchImpl as typeof fetch,
      "sk_test_1",
      "cus_1",
    )).resolves.toEqual(["cs_open_1", "cs_open_2"]);
    expect(fetchImpl.mock.calls[1]?.[0]).toContain("starting_after=cs_open_1");
  });

  it("expires a checkout session and treats resource_missing as already closed", async () => {
    const expired = vi.fn(async () => new Response("{}", { status: 200 }));
    await expireStripeCheckoutSession(expired as typeof fetch, "sk_test_1", "cs_1");
    expect(expired).toHaveBeenCalledWith(
      "https://api.stripe.com/v1/checkout/sessions/cs_1/expire",
      expect.objectContaining({ method: "POST" }),
    );

    const missing = vi.fn(async () => new Response(
      JSON.stringify({ error: { code: "resource_missing" } }),
      { status: 404 },
    ));
    await expect(expireStripeCheckoutSession(
      missing as typeof fetch,
      "sk_test_1",
      "cs_gone",
    )).resolves.toBeUndefined();
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
  it("deactivates every public projection and deletes social edges in bounded batches", async () => {
    const refs = (prefix: string) => Array.from({ length: 250 }, (_, index) => ({
      ref: { path: `${prefix}/${index}` },
    }));
    const queryDocs: Record<string, Array<{ ref: { path: string } }>> = {
      workspaces: refs("workspaces"),
      projects: refs("projects"),
      posts: refs("posts"),
      feed: refs("feed"),
      stars: refs("stars"),
      follows: refs("follows"),
    };
    const committed: Array<Array<{ kind: string; path: string }>> = [];
    const query = (name: string) => ({
      where: () => ({ get: async () => ({ docs: queryDocs[name] }) }),
    });
    const db = {
      collection: (name: string) => query(name),
      collectionGroup: (name: string) => query(name),
      batch: () => {
        const operations: Array<{ kind: string; path: string }> = [];
        return {
          update: (ref: { path: string }) => operations.push({ kind: "update", path: ref.path }),
          delete: (ref: { path: string }) => operations.push({ kind: "delete", path: ref.path }),
          commit: async () => { committed.push(operations); },
        };
      },
    };

    await deactivateCustomerVisibility(db as never, "uid-1");

    expect(committed.map((batch) => batch.length)).toEqual([400, 400, 400, 300]);
    expect(committed.flat().filter((write) => write.kind === "update")).toHaveLength(750);
    expect(committed.flat().filter((write) => write.kind === "delete")).toHaveLength(750);
  });

  it("deletes every pending connector and BYOS flow owned by the user", async () => {
    const deleted: string[] = [];
    const db = {
      collection: (name: string) => ({
        where: () => ({
          get: async () => ({ docs: [{ ref: { path: `${name}/flow-1` } }] }),
        }),
      }),
      batch: () => ({
        delete: (ref: { path: string }) => { deleted.push(ref.path); },
        commit: async () => undefined,
      }),
    };

    await invalidatePendingCredentialFlows(db as never, "uid-1");

    expect(deleted).toEqual(["connectFlows/flow-1", "byosubFlows/flow-1"]);
  });

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
