/**
 * Unit tests for the multi-account MM config emitted by boot-sync.
 *
 * Current shape (post-epic):
 *   - `default` account = octogee-bot's token. NOT written here — OpenClaw
 *     materializes it at load time by migrating the top-level `botToken`
 *     that the entrypoint + pre-boot-config seed. System agents use it.
 *   - `{slug}-coach` account = the customer's coach PAT, with
 *     `groupPolicy: "allowlist"` and `groupAllowFrom: [customer, admin]`.
 *     Only sees that tenant's channel events — isolation at the MM auth
 *     layer.
 *
 * Historical note: an earlier iteration also emitted an `admin` account
 * with `botToken: "${MM_BOT_TOKEN}"` as a placeholder. OpenClaw's env-var
 * substitution only fires for the account literally named "default", so
 * `admin` ended up sending the literal placeholder string → 401 →
 * reconnect loop → event-loop starvation that prevented other per-account
 * WSes from starting. That path is gone; see the regression guard below.
 *
 * Three extracted helpers are tested:
 *   - `fetchCoachTokens(deps, customers)` — async, reads each customer's
 *     `users/{uid}/secrets/coachMattermost.personalToken` from Firestore.
 *   - `buildMattermostAccounts(customers, tokens, adminMmUserId, warn?)` —
 *     pure, returns the accounts map: one `{slug}-coach` entry per
 *     customer with a mint'd PAT AND a non-empty `groupAllowFrom`.
 *   - `buildCustomerBindings(customers)` — pure, returns the flat list of
 *     `{ agentId, match: { channel, accountId, peer } }` bindings.
 */

import { describe, it, expect, vi } from "vitest";
import {
  buildMattermostAccounts,
  buildCustomerBindings,
  fetchCoachTokens,
  mergeAccountsPreservingDefault,
  type CoachTokenDeps,
} from "../boot-sync.js";

// ── fetchCoachTokens ────────────────────────────────────────────────────────

describe("fetchCoachTokens", () => {
  function mkDeps(
    docs: Record<string, { personalToken?: string } | undefined>,
    logSpy = vi.fn(),
  ): CoachTokenDeps & { logs: ReturnType<typeof vi.fn> } {
    const db = {
      collection: (_users: string) => ({
        doc: (uid: string) => ({
          collection: (_secrets: string) => ({
            doc: (_coachMm: string) => ({
              get: async () => {
                const data = docs[uid];
                return { exists: !!data, data: () => data };
              },
            }),
          }),
        }),
      }),
    };
    return { db, log: logSpy, logs: logSpy };
  }

  it("reads users/{uid}/secrets/coachMattermost.personalToken and keys by uid", async () => {
    const deps = mkDeps({
      "uid-chris": { personalToken: "tok-chris-abc123" },
      "uid-sam": { personalToken: "tok-sam-def456" },
    });
    const result = await fetchCoachTokens(deps, [
      { uid: "uid-chris", slug: "chris-builds-a3f2" },
      { uid: "uid-sam", slug: "sam-cooks-b4g3" },
    ]);
    expect(result.get("uid-chris")).toBe("tok-chris-abc123");
    expect(result.get("uid-sam")).toBe("tok-sam-def456");
    expect(result.size).toBe(2);
  });

  it("omits customers with no secrets doc and logs a warning", async () => {
    const logSpy = vi.fn();
    const deps = mkDeps(
      { "uid-chris": { personalToken: "tok-chris" } },
      logSpy,
    );
    const result = await fetchCoachTokens(deps, [
      { uid: "uid-chris", slug: "chris-builds-a3f2" },
      { uid: "uid-sam", slug: "sam-cooks-b4g3" },
    ]);
    expect(result.has("uid-chris")).toBe(true);
    expect(result.has("uid-sam")).toBe(false);
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining("sam-cooks-b4g3"),
    );
  });

  it("omits entries when secrets doc exists but personalToken is empty", async () => {
    const logSpy = vi.fn();
    const deps = mkDeps({ "uid-chris": { personalToken: "" } }, logSpy);
    const result = await fetchCoachTokens(deps, [
      { uid: "uid-chris", slug: "chris-builds-a3f2" },
    ]);
    expect(result.has("uid-chris")).toBe(false);
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining("chris-builds-a3f2"),
    );
  });

  it("tolerates Firestore errors for a single customer (continues others)", async () => {
    const logSpy = vi.fn();
    const db = {
      collection: (_users: string) => ({
        doc: (uid: string) => ({
          collection: (_secrets: string) => ({
            doc: (_coachMm: string) => ({
              get: async () => {
                if (uid === "uid-broken") throw new Error("firestore hiccup");
                return { exists: true, data: () => ({ personalToken: "tok-ok" }) };
              },
            }),
          }),
        }),
      }),
    };
    const result = await fetchCoachTokens({ db, log: logSpy }, [
      { uid: "uid-broken", slug: "broken-a1b2" },
      { uid: "uid-ok", slug: "ok-c3d4" },
    ]);
    expect(result.has("uid-broken")).toBe(false);
    expect(result.get("uid-ok")).toBe("tok-ok");
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("broken-a1b2"));
  });
});

// ── buildMattermostAccounts ─────────────────────────────────────────────────

describe("buildMattermostAccounts", () => {
  // Regression guard: NEVER emit an `admin` account. OpenClaw's env-var
  // `${MM_BOT_TOKEN}` substitution only fires for the account literally
  // named "default", so `admin: { botToken: "${MM_BOT_TOKEN}" }` sends the
  // literal placeholder as a bearer token → MM 401 → reconnect loop →
  // event-loop starvation that prevents coach WSes from starting. The
  // `default` account exists at runtime via OpenClaw's auto-migration of
  // the top-level botToken (written by pre-boot-config).
  it("emits NO entries on empty input — no admin, no placeholders", () => {
    const accounts = buildMattermostAccounts([], new Map());
    expect(accounts).toEqual({});
  });

  it("NEVER emits an `admin` account (root cause of silent channel-start failure)", () => {
    const accounts = buildMattermostAccounts(
      [{ uid: "uid-a", slug: "chris", customerMmUserId: "mm-chris" }],
      new Map([["uid-a", "tok-chris"]]),
      "mm-admin",
    );
    expect(accounts.admin).toBeUndefined();
  });

  it("adds `{slug}-coach` entries for customers with a mint'd PAT + allowlist scoped to (customer, admin)", () => {
    const accounts = buildMattermostAccounts(
      [
        { uid: "uid-a", slug: "chris", customerMmUserId: "mm-chris" },
        { uid: "uid-b", slug: "sam", customerMmUserId: "mm-sam" },
      ],
      new Map([
        ["uid-a", "tok-chris"],
        ["uid-b", "tok-sam"],
      ]),
      "mm-admin",
    );
    expect(accounts["chris-coach"]).toEqual({
      botToken: "tok-chris",
      groupPolicy: "allowlist",
      groupAllowFrom: ["mm-chris", "mm-admin"],
    });
    expect(accounts["sam-coach"]).toEqual({
      botToken: "tok-sam",
      groupPolicy: "allowlist",
      groupAllowFrom: ["mm-sam", "mm-admin"],
    });
  });

  it("OMITS customers without a PAT — never emits a null/empty botToken", () => {
    const accounts = buildMattermostAccounts(
      [
        { uid: "uid-a", slug: "chris", customerMmUserId: "mm-chris" },
        { uid: "uid-b", slug: "sam" }, // no token
      ],
      new Map([["uid-a", "tok-chris"]]),
      "mm-admin",
    );
    expect(accounts["chris-coach"]).toMatchObject({
      botToken: "tok-chris",
      groupPolicy: "allowlist",
    });
    expect(accounts["sam-coach"]).toBeUndefined();
    expect(Object.values(accounts).every((a) => a.botToken.length > 0)).toBe(true);
  });

  // Regression guard: each customer's token must land under their OWN
  // accountId. A Map-lookup bug that indexed by slug-position instead of
  // uid could cross tenants — this test drives three customers and asserts
  // each account's token matches its uid source AND each allowlist
  // contains that customer's OWN MM user id (not another tenant's).
  it("routes tokens + allowlists per-uid — no cross-workspace bleed", () => {
    const accounts = buildMattermostAccounts(
      [
        { uid: "uid-a", slug: "chris", customerMmUserId: "mm-chris" },
        { uid: "uid-b", slug: "sam", customerMmUserId: "mm-sam" },
        { uid: "uid-c", slug: "pat", customerMmUserId: "mm-pat" },
      ],
      new Map([
        ["uid-a", "tok-A"],
        ["uid-b", "tok-B"],
        ["uid-c", "tok-C"],
      ]),
      "mm-admin",
    );
    expect(accounts["chris-coach"].groupAllowFrom).toEqual(["mm-chris", "mm-admin"]);
    expect(accounts["sam-coach"].groupAllowFrom).toEqual(["mm-sam", "mm-admin"]);
    expect(accounts["pat-coach"].groupAllowFrom).toEqual(["mm-pat", "mm-admin"]);
  });

  it("coach-only-for-admin: when customerMmUserId is absent, allowlist is {admin} — the customer cannot trigger their own coach", () => {
    // This is a tenant-breaking outcome (customer can't use their own
    // coach), not a graceful fallback. Documented here because the emit
    // still happens — the builder doesn't have enough signal to know if
    // this is a re-provisioning race or actual data corruption. Operators
    // should fix the missing customerMmUserId in Firestore.
    const accounts = buildMattermostAccounts(
      [{ uid: "uid-a", slug: "chris" /* no customerMmUserId */ }],
      new Map([["uid-a", "tok-chris"]]),
      "mm-admin",
    );
    expect(accounts["chris-coach"].groupAllowFrom).toEqual(["mm-admin"]);
  });

  // Regression guard for P1-4. Before: `groupAllowFrom: []` + `groupPolicy:
  // "allowlist"` means every group message is silently dropped. After:
  // skip the account upsert entirely + warn, so the gap surfaces as
  // "coach offline" (visible) rather than "coach ignores messages"
  // (invisible).
  it("REFUSES to emit when both customerMmUserId and adminMmUserId are missing (warns; skips account)", () => {
    const warn = vi.fn();
    const accounts = buildMattermostAccounts(
      [{ uid: "uid-a", slug: "chris" /* no customerMmUserId */ }],
      new Map([["uid-a", "tok-chris"]]),
      undefined /* no admin */,
      warn,
    );
    expect(accounts["chris-coach"]).toBeUndefined();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("empty allowlist"),
    );
  });
});

// ── buildCustomerBindings ───────────────────────────────────────────────────

describe("buildCustomerBindings", () => {
  it("emits one binding per customer channel with accountId pinned to {slug}-coach", () => {
    const bindings = buildCustomerBindings([
      {
        slug: "chris",
        channels: [{ channelId: "ch-general-1" }, { channelId: "ch-coach-1" }],
      },
    ]);
    expect(bindings).toEqual([
      {
        agentId: "octogee-chris-coach",
        match: {
          channel: "mattermost",
          accountId: "chris-coach",
          peer: { kind: "group", id: "ch-general-1" },
        },
      },
      {
        agentId: "octogee-chris-coach",
        match: {
          channel: "mattermost",
          accountId: "chris-coach",
          peer: { kind: "group", id: "ch-coach-1" },
        },
      },
    ]);
  });

  // Core multi-tenant invariant. Under the OLD single-account model, an MM
  // event for chris-ch-1 could theoretically fan out to sam's agent if
  // bindings matched only on channelId. Under the new model every binding
  // pins accountId, so OpenClaw filters events at the WS-receiver layer
  // before agent resolution. This test locks that pinning so a future
  // refactor that drops accountId fails loudly.
  it("NEVER emits a binding without accountId (multi-tenant isolation lock)", () => {
    const bindings = buildCustomerBindings([
      { slug: "chris", channels: [{ channelId: "ch-1" }] },
      { slug: "sam", channels: [{ channelId: "ch-2" }] },
    ]);
    for (const b of bindings) {
      expect(b.match.accountId).toBeTruthy();
      expect(b.match.accountId).toMatch(/-coach$/);
    }
  });

  it("routes each customer's channels to their own accountId — no cross-tenant bleed", () => {
    const bindings = buildCustomerBindings([
      { slug: "chris", channels: [{ channelId: "chris-general" }] },
      { slug: "sam", channels: [{ channelId: "sam-general" }] },
    ]);
    const chrisBinding = bindings.find((b) => b.match.peer.id === "chris-general");
    const samBinding = bindings.find((b) => b.match.peer.id === "sam-general");
    expect(chrisBinding?.match.accountId).toBe("chris-coach");
    expect(samBinding?.match.accountId).toBe("sam-coach");
    expect(chrisBinding?.agentId).toBe("octogee-chris-coach");
    expect(samBinding?.agentId).toBe("octogee-sam-coach");
  });

  it("returns [] when a customer has zero channels (not-yet-provisioned)", () => {
    const bindings = buildCustomerBindings([
      { slug: "chris", channels: [] },
    ]);
    expect(bindings).toEqual([]);
  });
});

// ── mergeAccountsPreservingDefault ─────────────────────────────────────────

describe("mergeAccountsPreservingDefault", () => {
  it("takes all coach entries from the fresh list and preserves `default` from existing", () => {
    const existing = {
      default: { botToken: "bot-token-xyz" },
      "chris-coach": { botToken: "stale-coach-abc" }, // will be dropped (not in fresh)
    };
    const coach = {
      "marie-coach": { botToken: "marie-tok", groupPolicy: "allowlist" as const, groupAllowFrom: ["u1"] },
    };
    const merged = mergeAccountsPreservingDefault(existing, coach);
    expect(merged).toEqual({
      default: { botToken: "bot-token-xyz" },
      "marie-coach": { botToken: "marie-tok", groupPolicy: "allowlist", groupAllowFrom: ["u1"] },
    });
    // Stale coach not in fresh list is dropped — nuked-customer cleanup.
    expect(merged).not.toHaveProperty("chris-coach");
  });

  it("emits only coach entries when existing has no `default` (fresh PVC)", () => {
    const merged = mergeAccountsPreservingDefault(
      {},
      { "x-coach": { botToken: "x", groupPolicy: "allowlist" as const, groupAllowFrom: ["u1"] } },
    );
    expect(merged).toEqual({
      "x-coach": { botToken: "x", groupPolicy: "allowlist", groupAllowFrom: ["u1"] },
    });
  });

  it("preserves ONLY `default` — stale non-coach entries (e.g. legacy `admin`) are dropped", () => {
    const existing = {
      default: { botToken: "bot" },
      admin: { botToken: "legacy-admin-that-must-not-survive" }, // historical footgun
    };
    const merged = mergeAccountsPreservingDefault(existing, {});
    expect(merged).toEqual({ default: { botToken: "bot" } });
    expect(merged).not.toHaveProperty("admin");
  });

  it("when coach list has zero customers, result is just `default`", () => {
    const merged = mergeAccountsPreservingDefault(
      { default: { botToken: "bot" } },
      {},
    );
    expect(merged).toEqual({ default: { botToken: "bot" } });
  });

  it("REGRESSION: reboot with ≥1 customer must retain `default` (the hang-on-reboot bug)", () => {
    // Scenario: pod rebooted, existing on-disk openclaw.json has both
    // `default` (from template) and `chris1969-coach` (from prior session).
    // boot-sync regens with Firestore listing chris1969 as still-present.
    // Pre-fix: `accounts: coachAccounts` replaced the whole map, dropping
    // `default`, which tanked OpenClaw's channel-init.
    const existing = {
      default: { botToken: "octogee-bot-token" },
      "chris1969-coach": { botToken: "stale-pat", groupPolicy: "allowlist" as const, groupAllowFrom: [] },
    };
    const coach = {
      "chris1969-coach": {
        botToken: "fresh-pat-from-firestore",
        groupPolicy: "allowlist" as const,
        groupAllowFrom: ["mm-chris", "mm-admin"],
      },
    };
    const merged = mergeAccountsPreservingDefault(existing, coach);
    expect(merged.default).toEqual({ botToken: "octogee-bot-token" });
    expect(merged["chris1969-coach"]).toEqual({
      botToken: "fresh-pat-from-firestore",
      groupPolicy: "allowlist",
      groupAllowFrom: ["mm-chris", "mm-admin"],
    });
  });
});
