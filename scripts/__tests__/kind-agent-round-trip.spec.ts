import { describe, expect, it } from "vitest";
import {
  agentReply,
  fleetJson,
  ledgerEvidence,
  parseArgs,
  run,
} from "../ops/kind-agent-round-trip.mjs";

const MODEL = "platform-openrouter/meta/muse-ember";
const PASSWORD = "one-time-chat-password";
const BOT = "bot-user-id";
const SENT_AT = 1_000_000;

interface Post { id: string; user_id: string; create_at: number; message: string; type?: string; delete_at?: number }

function postList(...posts: Post[]) {
  return { order: posts.map(post => post.id), posts: Object.fromEntries(posts.map(post => [post.id, post])) };
}

function cluster(overrides: { gateways?: unknown[]; users?: unknown[]; replies?: Post[]; ledger?: unknown[] } = {}) {
  let now = SENT_AT - 60_000;
  const calls = { fleet: [] as string[][], sql: [] as Array<{ sql: string; variables: Record<string, string> }>, posts: [] as unknown[], signIn: [] as string[][] };
  const lines: string[] = [];
  let gateways = overrides.gateways ?? [];
  let users = overrides.users ?? [];
  const deps = {
    log: (line: string) => lines.push(line),
    clock: { now: () => now, sleep: async (ms: number) => { now += ms; } },
    fleet: (args: string[]) => {
      calls.fleet.push(args);
      const [noun, verb] = args;
      if (noun === "gateway" && verb === "ls") return { gateways };
      if (noun === "gateway" && verb === "add") { gateways = [{ gatewayId: "shared-a", status: "ready" }]; return {}; }
      if (noun === "user" && verb === "ls") return { users };
      if (noun === "user" && verb === "add") { users = [{ id: "uid-1", name: "lin", assignedGatewayId: null }]; return {}; }
      if (noun === "user" && verb === "assign") { users = [{ id: "uid-1", name: "lin", assignedGatewayId: "shared-a" }]; return {}; }
      if (noun === "user" && verb === "inspect") {
        return { user: { id: "uid-1", name: "lin", provisioningStatus: "complete", mountedGatewayId: "shared-a" } };
      }
      if (noun === "user" && verb === "issue-passwords") {
        return { dryRun: false, response: { chat: { username: "lin", password: PASSWORD }, git: { username: "ws-lin", password: "git" } } };
      }
      throw new Error(`unexpected fleet call ${args.join(" ")}`);
    },
    sql: (sql: string, variables: Record<string, string>) => {
      calls.sql.push({ sql, variables });
      if (sql.includes("model_broker_usage_events")) return (overrides.ledger ?? []).map(row => JSON.stringify(row)).join("\n");
      return "";
    },
    waitForGatewayPod: () => "",
    signIn: async (username: string, password: string) => {
      calls.signIn.push([username, password]);
      return {
        get: async (path: string) => {
          if (path === "/api/v4/users/username/lin-coach") return { id: BOT, username: "lin-coach" };
          if (path === "/api/v4/users/me/teams") return [{ id: "team-1" }];
          if (path === "/api/v4/teams/team-1/channels/name/lin-coach") return { id: "channel-1" };
          if (path.startsWith("/api/v4/channels/channel-1/posts?since=")) {
            return postList(...(overrides.replies ?? []).filter(post => post.create_at <= now));
          }
          throw new Error(`unexpected GET ${path}`);
        },
        post: async (path: string, body: unknown) => {
          calls.posts.push({ path, body });
          now = SENT_AT;
          return { id: "sent", create_at: SENT_AT };
        },
      };
    },
  };
  return { deps, calls, lines };
}

const options = { fleet: "octogee-fleet", gateway: "shared-a", user: "lin", model: MODEL, replyTimeoutMs: 300_000, state: "/state/roundtrip" };
const reply: Post = { id: "reply", user_id: BOT, create_at: SENT_AT + 20_000, message: "I can hear you." };
const ledgerRow = { provider: "openrouter", model: "meta/muse-ember", upstreamStatus: 200, totalTokens: 1200, costUsd: 0.0002 };

describe("kind agent round trip", () => {
  it("pins the model, places the user, and passes on a reply that the broker recorded", async () => {
    const { deps, calls, lines } = cluster({ replies: [reply], ledger: [ledgerRow] });

    const result = await run(deps, options);

    expect(JSON.parse(calls.sql[0].variables.value)).toEqual({
      freeTierModelRef: MODEL,
      builderAgentModelRef: MODEL,
      builderAgentFallbackModelRef: null,
    });
    expect(calls.fleet).toContainEqual(["gateway", "add", "--id=shared-a", "--apply"]);
    expect(calls.fleet).toContainEqual(["user", "add", "lin", "--email=lin@example.com", "--apply"]);
    expect(calls.fleet).toContainEqual(["user", "assign", "lin", "--to=shared-a", "--apply"]);
    expect(calls.signIn).toEqual([["lin", PASSWORD]]);
    expect(calls.posts).toEqual([{ path: "/api/v4/posts", body: { channel_id: "channel-1", message: expect.any(String) } }]);
    expect(calls.sql[1].variables).toEqual({ owner: "uid-1", since: String(SENT_AT) });
    expect(result.reply.id).toBe("reply");
    expect(result.evidence).toMatchObject({ calls: 1, provider: "openrouter", model: "meta/muse-ember", totalTokens: 1200 });
    expect(lines.join("\n")).not.toContain(PASSWORD);
  });

  it("reuses a ready gateway and a user already placed on it", async () => {
    const { deps, calls } = cluster({
      gateways: [{ gatewayId: "shared-a", status: "ready" }],
      users: [{ id: "uid-1", name: "lin", assignedGatewayId: "shared-a" }],
      replies: [reply],
      ledger: [ledgerRow],
    });

    await run(deps, options);

    expect(calls.fleet.map(args => args.slice(0, 2).join(" "))).not.toContain("gateway add");
    expect(calls.fleet.map(args => args.slice(0, 2).join(" "))).not.toContain("user add");
    expect(calls.fleet.map(args => args.slice(0, 2).join(" "))).not.toContain("user assign");
  });

  it("fails when the agent does not reply before the timeout", async () => {
    const { deps } = cluster({ replies: [], ledger: [ledgerRow] });

    await expect(run(deps, options)).rejects.toThrow(
      "Timed out after 300s waiting for a reply from lin-coach. A known OpenClaw bug can drop the first turn",
    );
  });

  it("fails on a reply the broker has no successful call to the pinned model for, such as an error notice", async () => {
    const notice = { ...reply, message: "⚠️ The AI service is having trouble. Please try again in a moment." };
    const { deps } = cluster({
      replies: [notice],
      ledger: [{ ...ledgerRow, model: "z-ai/glm-5.2" }, { ...ledgerRow, upstreamStatus: 503 }],
    });

    await expect(run(deps, options)).rejects.toThrow(
      "no successful call to openrouter/meta/muse-ember for the user (recorded: openrouter/z-ai/glm-5.2 HTTP 200, openrouter/meta/muse-ember HTTP 503)."
        + " lin-coach replied: \"⚠️ The AI service is having trouble. Please try again in a moment.\"",
    );
  });
});

describe("agentReply", () => {
  it("takes the agent's earliest non-empty post after the prompt", () => {
    const posts = postList(
      { id: "mine", user_id: "user", create_at: SENT_AT, message: "hello" },
      { id: "before", user_id: BOT, create_at: SENT_AT - 1, message: "welcome" },
      { id: "system", user_id: BOT, create_at: SENT_AT + 1, message: "joined", type: "system_join_channel" },
      { id: "deleted", user_id: BOT, create_at: SENT_AT + 2, message: "gone", delete_at: SENT_AT + 3 },
      { id: "blank", user_id: BOT, create_at: SENT_AT + 4, message: "  " },
      { id: "later", user_id: BOT, create_at: SENT_AT + 9, message: "second" },
      { id: "first", user_id: BOT, create_at: SENT_AT + 5, message: "first" },
    );

    expect(agentReply(posts, { botUserId: BOT, after: SENT_AT })?.id).toBe("first");
    expect(agentReply(postList(), { botUserId: BOT, after: SENT_AT })).toBeNull();
  });
});

describe("ledgerEvidence", () => {
  it("accepts any successful call when no model is pinned", () => {
    expect(ledgerEvidence([{ ...ledgerRow, provider: "anthropic", model: "claude" }], null)).toMatchObject({ provider: "anthropic" });
  });
});

describe("parseArgs", () => {
  it("needs a state directory and a platform model ref", () => {
    expect(() => parseArgs([])).toThrow("--state is required");
    expect(() => parseArgs(["--state=/s", "--model=openrouter/meta/muse-ember"])).toThrow("--model needs a platform model ref");
    expect(parseArgs(["--state=/s", `--model=${MODEL}`, "--reply-timeout=60"])).toMatchObject({ model: MODEL, replyTimeoutMs: 60_000 });
  });
});

describe("fleetJson", () => {
  it("does not echo unparseable output, which can hold one-time passwords", () => {
    expect(() => fleetJson(["user", "issue-passwords", "lin", "--apply"], `chat password ${PASSWORD}`))
      .toThrow(/^octogee-fleet user issue-passwords lin printed output that is not JSON$/);
  });
});
