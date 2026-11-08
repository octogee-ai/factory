import { describe, expect, it, vi } from "vitest";
import { MalformedRecordError, type PlatformStateTransaction } from "@octogee/core/platform-state";
import {
  createDocumentFixtureStore,
  createJournalFixtureStore,
  fixtureDocumentsAt,
  journalRowsAtPaths,
  type FixtureDocuments,
} from "@octogee/core/testing/journal-store";
import {
  assertCustomerRestoreNotInProgress,
  cancelCustomerMigrationsForSuspension,
  cancelStripeSubscription,
  deactivateCustomerVisibility,
  deleteStripeCustomer,
  disableCreditAutoTopUp,
  expireStripeCheckoutSession,
  invalidatePendingCredentialFlows,
  listOpenStripeCheckoutSessionIds,
  listLiveStripeSubscriptionIds,
  listStripeCustomerIdsForUid,
  releaseCustomerPlacement,
  revokeOwnerModelBrokerTokens,
} from "../lib/customer-ops/customer-suspension-runtime.js";

type Documents = Record<string, Record<string, unknown>>;

function countingStore(records: Documents) {
  const base = fixtureDocumentsAt(records);
  let writes = 0;
  const documents: FixtureDocuments = {
    ...base,
    set: (path, row) => { writes += 1; base.set(path, row); },
    delete: (path) => { writes += 1; base.delete(path); },
  };
  const fixture = createJournalFixtureStore(journalRowsAtPaths(records), { documents });
  const committed: number[] = [];
  const store = new Proxy(fixture, {
    get(target, property, receiver) {
      if (property !== "transaction") return Reflect.get(target, property, receiver);
      return async <T>(options: { label: string; readOnly?: boolean }, body: (transaction: PlatformStateTransaction) => Promise<T>) => {
        const before = writes;
        const result = await target.transaction(options, body);
        committed.push(writes - before);
        return result;
      };
    },
  });
  return { store, committed };
}

const assignment = (gatewayId: string) => ({
  uid: "uid-1", slug: "alice", gatewayId, source: "onboarding", state: "serving", epoch: 1,
});

function placementRecords(openclaw: Record<string, unknown> | null, assigned: string[] = ["shared-0"]): Documents {
  return {
    ...(openclaw === null ? {} : { "users/uid-1": { username: "alice", provisioning: { openclaw } } }),
    ...Object.fromEntries(assigned.map((gatewayId) => [`gateways/${gatewayId}/assignments/uid-1`, assignment(gatewayId)])),
  };
}

const assignmentPaths = (records: Documents) => Object.keys(records).filter((path) => path.includes("/assignments/")).sort();

describe("assertCustomerRestoreNotInProgress", () => {
  it("rejects unresolved restore before suspension effects", async () => {
    const store = createDocumentFixtureStore(placementRecords({ restoreFence: { phase: "dispatched" } }));
    await expect(assertCustomerRestoreNotInProgress(store, "uid-1")).rejects.toThrow("customer restore is in progress");
  });
  it("rejects a malformed restore fence before suspension effects", async () => {
    const store = createDocumentFixtureStore(placementRecords({ restoreFence: null }));
    await expect(assertCustomerRestoreNotInProgress(store, "uid-1")).rejects.toBeInstanceOf(MalformedRecordError);
  });
  it.each([null, { gatewayId: "shared-1" }])("allows an unfenced account or completed cleanup retry", async (openclaw) => {
    const store = createDocumentFixtureStore(placementRecords(openclaw, []));
    await expect(assertCustomerRestoreNotInProgress(store, "uid-1")).resolves.toBeUndefined();
  });
});

describe("releaseCustomerPlacement", () => {
  it.each(["shared-0", undefined])("clears the migration projection after releasing placement %j", async (gatewayId) => {
    const records = placementRecords({
      ...(gatewayId === undefined ? {} : { gatewayId }),
      migration: { state: "preparing", phase: "waiting", operationId: "failed-activation" },
    });
    await releaseCustomerPlacement(createDocumentFixtureStore(records), "uid-1", "shared-0");
    expect(records["users/uid-1"]).toEqual({ username: "alice", provisioning: { openclaw: {} } });
  });

  it.each([
    ["a malformed", null, MalformedRecordError],
    ["a malformed", false, MalformedRecordError],
    ["an unresolved", { phase: "dispatched", claimStartedAt: 1 }, "customer restore is in progress"],
  ])("preserves all assignments while %s restore fence remains: %j", async (_label, restoreFence, refusal) => {
    const records = placementRecords({ gatewayId: "shared-1", restoreFence }, ["shared-0", "shared-1"]);
    const before = structuredClone(records);
    const attempt = releaseCustomerPlacement(createDocumentFixtureStore(records), "uid-1", "shared-0");
    if (typeof refusal === "string") await expect(attempt).rejects.toThrow(refusal);
    else await expect(attempt).rejects.toBeInstanceOf(refusal);
    expect(records).toEqual(before);
  });

  it.each([
    ["a malformed", null, MalformedRecordError],
    ["a malformed", false, MalformedRecordError],
    ["an unresolved", { sourceGatewayId: "shared-1", targetGatewayId: "target", phase: "dispatched", claimStartedAt: 1 }, "customer source transfer is in progress"],
  ])("preserves all assignments while %s source transfer fence remains: %j", async (_label, sourceTransferFence, refusal) => {
    const records = placementRecords({ gatewayId: "shared-1", sourceTransferFence }, ["shared-0", "shared-1"]);
    const before = structuredClone(records);
    const attempt = releaseCustomerPlacement(createDocumentFixtureStore(records), "uid-1", "shared-0");
    if (typeof refusal === "string") await expect(attempt).rejects.toThrow(refusal);
    else await expect(attempt).rejects.toBeInstanceOf(refusal);
    expect(records).toEqual(before);
  });

  it("deletes the assignment and clears the user mirror that still points at the gateway", async () => {
    const records = placementRecords({
      gatewayId: "shared-0", gatewayAssignedAt: 10, gatewayProfile: "standard", controlUiEnabled: true, status: "complete",
    });

    await releaseCustomerPlacement(createDocumentFixtureStore(records), "uid-1", "shared-0");

    expect(assignmentPaths(records)).toEqual([]);
    expect(records["users/uid-1"]).toEqual({ username: "alice", provisioning: { openclaw: { status: "complete" } } });
  });

  it("releases the gateway the mirror names now as well as the one captured at suspension time", async () => {
    const records = placementRecords({ gatewayId: "shared-1" }, ["shared-0", "shared-1", "shared-2"]);

    await releaseCustomerPlacement(createDocumentFixtureStore(records), "uid-1", "shared-0");

    expect(assignmentPaths(records)).toEqual(["gateways/shared-2/assignments/uid-1"]);
    expect(records["users/uid-1"]).toEqual({ username: "alice", provisioning: { openclaw: {} } });
  });

  it("releases the current placement when nothing was captured at suspension time", async () => {
    const records = placementRecords({ gatewayId: "shared-1" }, ["shared-0", "shared-1"]);

    await releaseCustomerPlacement(createDocumentFixtureStore(records), "uid-1", null);

    expect(assignmentPaths(records)).toEqual(["gateways/shared-0/assignments/uid-1"]);
    expect(records["users/uid-1"]).toEqual({ username: "alice", provisioning: { openclaw: {} } });
  });

  it("still deletes the captured assignment when the user document is gone", async () => {
    const records = placementRecords(null, ["shared-0", "shared-1"]);

    await releaseCustomerPlacement(createDocumentFixtureStore(records), "uid-1", "shared-0");

    expect(records).toEqual({ "gateways/shared-1/assignments/uid-1": assignment("shared-1") });
  });
});

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

function token(): Record<string, unknown> {
  return {
    capped: true, gatewayId: "builder-1", ownerUid: "uid-1", provider: "anthropic", secretName: "broker-secret",
    createdAt: 1, expiresAt: null, limits: { spendWindowUsd: null, spendWeekUsd: null, requestsPerMinute: null },
  };
}

function tokens(prefix: string, count: number): Documents {
  return Object.fromEntries(Array.from({ length: count }, (_, index) => [`modelBrokerTokens/${prefix}${index}`, token()]));
}

function pointers(prefix: string, count: number): Documents {
  return Object.fromEntries(Array.from({ length: count }, (_, index) => [`modelBrokerGatewayTokens/${prefix}${index}`, {
    gatewayId: "builder-1", ownerUid: "uid-1", provider: "anthropic", secretName: "broker-secret", tokenHash: `hash-${index}`, updatedAt: 1,
  }]));
}

function migration(id: string, fields: Record<string, unknown>): Documents {
  return {
    [`glmOperations/${id}`]: {
      kind: "migrate-customer", status: "pending", createdBy: "glm-controller", createdAt: 10, startedAt: null, completedAt: null,
      steps: [], inputUid: "uid-1", input: { uid: "uid-1", fromGatewayId: "default", toGatewayId: "builder-1" },
      waitingOn: "source", nextAttemptAt: 70, ...fields,
    },
  };
}

describe("Firestore suspension fences", () => {
  it("terminally cancels queued Builder migrations and requests cancellation for started work", async () => {
    const records: Documents = {
      ...migration("queued-migration", {}),
      ...migration("started-migration", { status: "running", startedAt: 20, customerMigrationV2: { phase: "initialized" } }),
      ...migration("forward-retry", { schedulerHandoff: { forwardRecovery: { schemaVersion: 1, phase: "source-flushed" } } }),
      ...migration("other-builder", { inputUid: "uid-2", input: { uid: "uid-2", fromGatewayId: "default", toGatewayId: "builder-2" } }),
    };
    const before = structuredClone(records);

    await expect(cancelCustomerMigrationsForSuspension(createDocumentFixtureStore(records), "uid-1", "delete-1", 80)).resolves.toBe(true);

    const { waitingOn: _waitingOn, nextAttemptAt: _nextAttemptAt, ...queued } = before["glmOperations/queued-migration"];
    expect(records["glmOperations/queued-migration"]).toEqual({
      ...queued,
      status: "failed",
      completedAt: 80,
      error: "customer migration cancelled because the account was suspended",
      rolledBack: false,
      cancelledByDeletionId: "delete-1",
    });
    expect(records["glmOperations/started-migration"]).toEqual({ ...before["glmOperations/started-migration"], cancellationRequestedAt: 80 });
    expect(records["glmOperations/forward-retry"]).toEqual({ ...before["glmOperations/forward-retry"], cancellationRequestedAt: 80 });
    expect(records["glmOperations/other-builder"]).toEqual(before["glmOperations/other-builder"]);
  });

  it("leaves a migration alone once it left the live statuses before its cancellation transaction", async () => {
    const records: Documents = migration("queued-migration", {});
    const store = createDocumentFixtureStore(records);
    const listed = await store.journal.operations.listByStatus(["pending", "running"]);
    records["glmOperations/queued-migration"].status = "succeeded";
    const listing = vi.spyOn(store.journal.operations, "listByStatus").mockResolvedValue(listed);

    await expect(cancelCustomerMigrationsForSuspension(store, "uid-1", "delete-1", 80)).resolves.toBe(false);

    expect(listing).toHaveBeenCalledWith(["pending", "running"]);
    expect(records["glmOperations/queued-migration"]).toMatchObject({ status: "succeeded" });
    expect(records["glmOperations/queued-migration"]).not.toHaveProperty("cancelledByDeletionId");
  });

  it("deactivates every public projection and deletes social edges in bounded batches", async () => {
    const records: Documents = Object.fromEntries(Array.from({ length: 250 }, (_, index) => [
      [`workspaces/ws-${index}`, { id: `ws-${index}`, slug: `ws-${index}`, ownerUid: "uid-1", ownerActive: true }],
      [`workspaces/ws-0/projects/p-${index}`, { ownerUid: "uid-1", ownerActive: true }],
    ]).flat());
    records["workspaces/other"] = { id: "other", slug: "other", ownerUid: "uid-2", ownerActive: true };
    const { store, committed: transactions } = countingStore(records);
    const refs = (prefix: string) => Array.from({ length: 250 }, (_, index) => ({
      ref: { path: `${prefix}/${index}` },
    }));
    const queryDocs: Record<string, Array<{ ref: { path: string } }>> = {
      posts: refs("posts"),
      feed: refs("feed"),
      stars: refs("stars"),
      follows: refs("follows"),
    };
    const committed: Array<Array<{ kind: string; path: string }>> = [];
    const db = {
      collection: (name: string) => ({
        where: () => ({ get: async () => ({ docs: queryDocs[name] }) }),
      }),
      batch: () => {
        const operations: Array<{ kind: string; path: string }> = [];
        return {
          update: (ref: { path: string }) => operations.push({ kind: "update", path: ref.path }),
          delete: (ref: { path: string }) => operations.push({ kind: "delete", path: ref.path }),
          commit: async () => { committed.push(operations); },
        };
      },
    };

    await deactivateCustomerVisibility(store, db as never, "uid-1");

    expect(transactions).toEqual([400, 100]);
    const owned = Object.entries(records).filter(([path]) => path !== "workspaces/other");
    expect(owned).toHaveLength(500);
    expect(owned.every(([, row]) => row.ownerActive === false)).toBe(true);
    expect(records["workspaces/other"]).toMatchObject({ ownerActive: true });
    expect(committed.map((batch) => batch.length)).toEqual([400, 400, 200]);
    expect(committed.flat().filter((write) => write.kind === "update")).toHaveLength(250);
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

  it("revokes every owner token and deletes every owner pointer", async () => {
    const records: Documents = {
      ...tokens("t", 2),
      "modelBrokerTokens/foreign": { ...token(), ownerUid: "uid-2" },
      ...pointers("p", 1),
    };

    await revokeOwnerModelBrokerTokens(createDocumentFixtureStore(records), "uid-1", 50);

    expect(records["modelBrokerTokens/t0"]).toEqual({ ...token(), revoked: true, revokedAt: 50 });
    expect(records["modelBrokerTokens/t1"]).toEqual({ ...token(), revoked: true, revokedAt: 50 });
    expect(records["modelBrokerTokens/foreign"]).toEqual({ ...token(), ownerUid: "uid-2" });
    expect(records).not.toHaveProperty("modelBrokerGatewayTokens/p0");
  });

  it("revokes tens of thousands of owner tokens in bounded batches", async () => {
    const records: Documents = { ...tokens("tokens", 1_050), ...pointers("pointers", 3) };
    const { store, committed } = countingStore(records);

    await revokeOwnerModelBrokerTokens(store, "uid-1", 50);

    expect(committed).toEqual([400, 400, 253]);
  });

  it("refuses to revoke from a malformed owner token record", async () => {
    const records: Documents = { ...tokens("t", 1), "modelBrokerTokens/legacy": { ...token(), capped: false } };

    await expect(revokeOwnerModelBrokerTokens(createDocumentFixtureStore(records), "uid-1", 50))
      .rejects.toBeInstanceOf(MalformedRecordError);

    expect(records["modelBrokerTokens/t0"]).toEqual(token());
  });

  it("disables automatic top-up without deleting the financial balance", async () => {
    const set = vi.fn(async () => undefined);
    const db = { collection: () => ({ doc: () => ({ set }) }) };
    await disableCreditAutoTopUp(db as never, "uid-1", 60);
    expect(set).toHaveBeenCalledWith({
      autoTopUp: { enabled: false, disabledAt: 60, disabledReason: "account_suspended" },
    }, { merge: true });
  });

});
