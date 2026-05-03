import { describe, it, expect, vi } from "vitest";
import {
  buildMattermostAccounts,
  buildCustomerBindings,
  fetchCoachTokens,
  mergeAccountsPreservingDefault,
  type CoachTokenDeps,
} from "../lib/openclaw-config-builders.js";

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

describe("buildMattermostAccounts", () => {
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
      commands: { native: false },
    });
    expect(accounts["sam-coach"]).toEqual({
      botToken: "tok-sam",
      groupPolicy: "allowlist",
      groupAllowFrom: ["mm-sam", "mm-admin"],
      commands: { native: false },
    });
  });

  it("OMITS customers without a PAT — never emits a null/empty botToken", () => {
    const accounts = buildMattermostAccounts(
      [
        { uid: "uid-a", slug: "chris", customerMmUserId: "mm-chris" },
        { uid: "uid-b", slug: "sam" },
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
    const accounts = buildMattermostAccounts(
      [{ uid: "uid-a", slug: "chris" }],
      new Map([["uid-a", "tok-chris"]]),
      "mm-admin",
    );
    expect(accounts["chris-coach"].groupAllowFrom).toEqual(["mm-admin"]);
  });

  it("REFUSES to emit when both customerMmUserId and adminMmUserId are missing (warns; skips account)", () => {
    const warn = vi.fn();
    const accounts = buildMattermostAccounts(
      [{ uid: "uid-a", slug: "chris" }],
      new Map([["uid-a", "tok-chris"]]),
      undefined,
      warn,
    );
    expect(accounts["chris-coach"]).toBeUndefined();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("empty allowlist"),
    );
  });
});

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

describe("mergeAccountsPreservingDefault", () => {
  it("takes all coach entries from the fresh list and preserves `default` from existing", () => {
    const existing = {
      default: { botToken: "bot-token-xyz" },
      "chris-coach": { botToken: "stale-coach-abc" },
    };
    const coach = {
      "marie-coach": { botToken: "marie-tok", groupPolicy: "allowlist" as const, groupAllowFrom: ["u1"] },
    };
    const merged = mergeAccountsPreservingDefault(existing, coach);
    expect(merged).toEqual({
      default: { botToken: "bot-token-xyz" },
      "marie-coach": { botToken: "marie-tok", groupPolicy: "allowlist", groupAllowFrom: ["u1"] },
    });
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
      admin: { botToken: "legacy-admin-that-must-not-survive" },
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
