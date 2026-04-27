import { describe, it, expect } from "vitest";
import { shapeBundle, type MmChannelMeta, type MmUserMeta } from "../shape.js";

const COACH_USER_ID = "coach-uid-26-chars-abcdefgh";
const SITE = "https://mattermost.octogee.com";
const TEAM = "christopher";

const channels = new Map<string, MmChannelMeta>([
  ["ch1", { id: "ch1", name: "builder-pulse", display_name: "Builder Pulse", team_id: "team-id-1" }],
]);

const users = new Map<string, MmUserMeta>([
  ["u-taylor", { id: "u-taylor", username: "taylor", first_name: "Taylor", last_name: "R" }],
  ["u-other", { id: "u-other", username: "other", nickname: "Otto" }],
]);

const baseCtx = {
  coachMmUserId: COACH_USER_ID,
  siteUrl: SITE,
  teamName: TEAM,
  channels,
  users,
};

describe("shapeBundle", () => {
  it("preserves MM order", () => {
    const out = shapeBundle(
      {
        posts: {
          p1: { id: "p1", channel_id: "ch1", user_id: "u-taylor", message: "first", create_at: 1_700_000_000_000 },
          p2: { id: "p2", channel_id: "ch1", user_id: "u-other", message: "second", create_at: 1_700_000_001_000 },
        },
        order: ["p1", "p2"],
      },
      baseCtx,
    );
    expect(out.posts.map((p) => p.post_id)).toEqual(["p1", "p2"]);
  });

  it("filters out coach-authored posts (boundary §2.3.8)", () => {
    const out = shapeBundle(
      {
        posts: {
          p1: { id: "p1", channel_id: "ch1", user_id: COACH_USER_ID, message: "echo", create_at: 1_700_000_000_000 },
          p2: { id: "p2", channel_id: "ch1", user_id: "u-taylor", message: "real", create_at: 1_700_000_001_000 },
        },
        order: ["p1", "p2"],
      },
      baseCtx,
    );
    expect(out.posts).toHaveLength(1);
    expect(out.posts[0].post_id).toBe("p2");
    expect(out.posts[0].snippet).toBe("real");
  });

  it("filters MULTIPLE coach-authored posts in one bundle — guards against `find` vs `filter`", () => {
    // Catches a regression where the impl uses .find() (returns first non-coach
    // match) or otherwise stops at the first hit. Posts arranged so coach
    // and non-coach interleave — output must contain BOTH non-coach posts
    // and NEITHER coach post.
    const out = shapeBundle(
      {
        posts: {
          p1: { id: "p1", channel_id: "ch1", user_id: COACH_USER_ID, message: "coach echo 1", create_at: 1 },
          p2: { id: "p2", channel_id: "ch1", user_id: "u-taylor", message: "real one", create_at: 2 },
          p3: { id: "p3", channel_id: "ch1", user_id: COACH_USER_ID, message: "coach echo 2", create_at: 3 },
          p4: { id: "p4", channel_id: "ch1", user_id: "u-other", message: "real two", create_at: 4 },
        },
        order: ["p1", "p2", "p3", "p4"],
      },
      baseCtx,
    );
    expect(out.posts.map((p) => p.post_id)).toEqual(["p2", "p4"]);
  });

  it("compares coach-author filter against post.user_id specifically (not username/display_name)", () => {
    // If the impl ever swapped the filter to compare against author.username
    // or author.display_name (they're easier to read in logs), the coach's
    // post would slip through whenever its user metadata was missing or
    // the username string didn't equal the coach id. This test pins the
    // contract: filter is keyed on user_id even when username happens to
    // collide with non-coach posts, AND when the coach has no user metadata.
    const usersWithCoachMissing = new Map<string, MmUserMeta>([
      ["u-taylor", { id: "u-taylor", username: "taylor" }],
      // Coach's user metadata intentionally absent — the filter must still
      // catch the post via user_id, not via author lookup.
    ]);
    const out = shapeBundle(
      {
        posts: {
          p1: { id: "p1", channel_id: "ch1", user_id: COACH_USER_ID, message: "echo", create_at: 1 },
          p2: { id: "p2", channel_id: "ch1", user_id: "u-taylor", message: "real", create_at: 2 },
        },
        order: ["p1", "p2"],
      },
      { ...baseCtx, users: usersWithCoachMissing },
    );
    expect(out.posts.map((p) => p.post_id)).toEqual(["p2"]);
  });

  it("filters soft-deleted and system posts", () => {
    const out = shapeBundle(
      {
        posts: {
          p1: {
            id: "p1", channel_id: "ch1", user_id: "u-taylor",
            message: "deleted", create_at: 1_700_000_000_000, delete_at: 1_700_000_500_000,
          },
          p2: {
            id: "p2", channel_id: "ch1", user_id: "u-taylor",
            message: "joined the channel", create_at: 1_700_000_001_000, type: "system_join_channel",
          },
          p3: {
            id: "p3", channel_id: "ch1", user_id: "u-taylor",
            message: "real", create_at: 1_700_000_002_000,
          },
        },
        order: ["p1", "p2", "p3"],
      },
      baseCtx,
    );
    expect(out.posts.map((p) => p.post_id)).toEqual(["p3"]);
  });

  it("uses display_name fallback chain (nickname → first+last → username)", () => {
    const out = shapeBundle(
      {
        posts: {
          a: { id: "a", channel_id: "ch1", user_id: "u-taylor", message: "x", create_at: 1 },
          b: { id: "b", channel_id: "ch1", user_id: "u-other", message: "y", create_at: 2 },
        },
        order: ["a", "b"],
      },
      baseCtx,
    );
    expect(out.posts[0].author.display_name).toBe("Taylor R");
    expect(out.posts[1].author.display_name).toBe("Otto");
  });

  it("builds permalink as `<site>/<team>/pl/<id>` — the URL the MM web UI actually resolves", () => {
    // Pinned literal — NOT a template that mirrors the impl. If MM's
    // permalink shape ever changes (e.g. /post/<id>, /m/<id>, omitting the
    // team segment), this test forces the contract change to be conscious
    // rather than silent. Don't refactor to a template that uses SITE/TEAM
    // constants — that re-introduces the same impl-mirroring bug.
    const out = shapeBundle(
      {
        posts: { p: { id: "p", channel_id: "ch1", user_id: "u-taylor", message: "hi", create_at: 1 } },
        order: ["p"],
      },
      baseCtx,
    );
    expect(out.posts[0].permalink).toBe("https://mattermost.octogee.com/christopher/pl/p");
  });

  it("strips a single trailing slash from siteUrl in permalinks", () => {
    const out = shapeBundle(
      {
        posts: { p: { id: "p", channel_id: "ch1", user_id: "u-taylor", message: "hi", create_at: 1 } },
        order: ["p"],
      },
      { ...baseCtx, siteUrl: "https://mattermost.octogee.com/" },
    );
    expect(out.posts[0].permalink).toBe("https://mattermost.octogee.com/christopher/pl/p");
  });

  it("snippet anchors around the longest query token when multiple match (search mode)", () => {
    // Adversarial: the SHORT token ("the") appears EARLIER in the message,
    // and the LONG token ("splitter") appears LATER. If the impl picks
    // first-found instead of longest-token, the snippet will anchor on
    // "the" near the start. The longest-token contract requires anchoring
    // on "splitter" near the middle.
    const message =
      "the early section is filler ".repeat(15) +
      "and now the actual payment splitter decision is here, " +
      "and the rest trails off ".repeat(15);
    const out = shapeBundle(
      {
        posts: { p: { id: "p", channel_id: "ch1", user_id: "u-taylor", message, create_at: 1 } },
        order: ["p"],
      },
      { ...baseCtx, query: "the splitter" },
    );
    expect(out.posts[0].snippet).toMatch(/splitter/);
    expect(out.posts[0].snippet.length).toBeLessThanOrEqual(220);
  });

  it("snippet falls back to first occurrence when only one token matches", () => {
    const long = "intro words ".repeat(40) + "the payment splitter decision happened here " + "trailing ".repeat(40);
    const out = shapeBundle(
      {
        posts: { p: { id: "p", channel_id: "ch1", user_id: "u-taylor", message: long, create_at: 1 } },
        order: ["p"],
      },
      { ...baseCtx, query: "splitter" },
    );
    expect(out.posts[0].snippet).toMatch(/splitter/);
    expect(out.posts[0].snippet.length).toBeLessThanOrEqual(220);
  });

  it("snippet falls back to message start when no query token matches", () => {
    const out = shapeBundle(
      {
        posts: { p: { id: "p", channel_id: "ch1", user_id: "u-taylor", message: "x".repeat(500), create_at: 1 } },
        order: ["p"],
      },
      baseCtx,
    );
    expect(out.posts[0].snippet.endsWith("…")).toBe(true);
    expect(out.posts[0].snippet.length).toBeLessThan(220);
  });

  it("strips MM operators from query when picking snippet anchor", () => {
    const out = shapeBundle(
      {
        posts: {
          p: {
            id: "p", channel_id: "ch1", user_id: "u-taylor",
            // 'taylor' would be a false anchor if 'from:taylor' wasn't stripped
            message: "irrelevant ".repeat(30) + "here is the actual decision payload " + "more ".repeat(30),
            create_at: 1,
          },
        },
        order: ["p"],
      },
      { ...baseCtx, query: "from:taylor decision" },
    );
    expect(out.posts[0].snippet).toMatch(/decision/);
  });

  it("emits ISO 8601 created_at", () => {
    const out = shapeBundle(
      {
        posts: { p: { id: "p", channel_id: "ch1", user_id: "u-taylor", message: "hi", create_at: 1_700_000_000_000 } },
        order: ["p"],
      },
      baseCtx,
    );
    expect(out.posts[0].created_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  });

  it("threads: thread_root_id is null at root, set on replies", () => {
    const out = shapeBundle(
      {
        posts: {
          root: { id: "root", channel_id: "ch1", user_id: "u-taylor", message: "Q?", create_at: 1, root_id: "" },
          reply: { id: "reply", channel_id: "ch1", user_id: "u-other", message: "A.", create_at: 2, root_id: "root" },
        },
        order: ["root", "reply"],
      },
      baseCtx,
    );
    expect(out.posts[0].thread_root_id).toBeNull();
    expect(out.posts[1].thread_root_id).toBe("root");
  });
});
