import { Timestamp, type Firestore } from "firebase-admin/firestore";
import { describe, expect, it, vi } from "vitest";
import { userAccountFromData, firestoreUserAccountReader } from "./user-account.js";

describe("userAccountFromData", () => {
  it("collects every distinct Stripe customer and the personal and user subscriptions", () => {
    const account = userAccountFromData("u1", {
      subscription: { stripeCustomerId: "cus_1", id: "sub_personal" },
      stripeCustomerId: "cus_1",
      billing: { stripeCustomerId: "cus_2", subscriptionId: "sub_billing" },
      builderSubscription: { id: "sub_builder" },
    });

    expect(account.stripeCustomerIds).toEqual(["cus_1", "cus_2"]);
    expect(account.stripeSubscriptionIds).toEqual(["sub_personal", "sub_builder"]);
  });

  it("falls back to the billing subscription when the personal subscription has no id", () => {
    const account = userAccountFromData("u1", { billing: { subscriptionId: "sub_billing" } });

    expect(account.stripeSubscriptionIds).toEqual(["sub_billing"]);
    expect(account.stripeCustomerIds).toEqual([]);
  });

  it.each([
    [1_700, 1_700],
    [new Date(2_000), 2_000],
    [Timestamp.fromMillis(3_000), 3_000],
    ["yesterday", null],
  ])("reads lastActive %s as millis %s", (lastActive, expected) => {
    expect(userAccountFromData("u1", { lastActive }).lastActive).toBe(expected);
  });

  it("keeps the plan inputs, including a legacy tier, and drops empty identity strings", () => {
    const account = userAccountFromData("u1", { username: "", email: "a@b.co", tier: "pro" });

    expect(account).toMatchObject({ uid: "u1", username: null, email: "a@b.co" });
    expect(account.planInputs).toMatchObject({ tier: "pro" });
  });

  it("projects the admin profile fields and drops non-string Mattermost usernames", () => {
    expect(userAccountFromData("u1", {
      displayName: "User",
      byotActive: true,
      usage: { totalTokensUsed: 5 },
      mattermost: { username: "user-mm" },
      onboardingStep: "admitted",
      onboardingComplete: true,
    })).toMatchObject({
      displayName: "User",
      byotActive: true,
      usage: { totalTokensUsed: 5 },
      mattermostUsername: "user-mm",
      onboardingStep: "admitted",
      onboardingComplete: true,
    });
    expect(userAccountFromData("u1", { mattermost: { username: 456 }, byotActive: "yes" })).toMatchObject({
      mattermostUsername: null,
      byotActive: false,
      onboardingStep: null,
      onboardingComplete: false,
      usage: {},
    });
  });
});

describe("firestoreUserAccountReader.getMany", () => {
  function reader(existing: Record<string, Record<string, unknown>>) {
    const getAll = vi.fn(async (...refs: Array<{ id: string }>) => refs.map((ref) => ({
      id: ref.id,
      exists: ref.id in existing,
      data: () => existing[ref.id],
    })));
    const db = { collection: () => ({ doc: (id: string) => ({ id }) }), getAll } as unknown as Firestore;
    return { accounts: firestoreUserAccountReader(db), getAll };
  }

  it("reads each distinct uid once and omits missing accounts", async () => {
    const { accounts, getAll } = reader({ u1: { username: "one" }, u2: { username: "two" } });

    const found = await accounts.getMany(["u1", "u2", "u1", "missing"]);

    expect([...found.keys()]).toEqual(["u1", "u2"]);
    expect(found.get("u2")?.username).toBe("two");
    expect(getAll).toHaveBeenCalledTimes(1);
    expect(getAll.mock.calls[0]).toHaveLength(3);
  });

  it("skips the read for an empty uid list", async () => {
    const { accounts, getAll } = reader({});

    await expect(accounts.getMany([])).resolves.toEqual(new Map());
    expect(getAll).not.toHaveBeenCalled();
  });
});
