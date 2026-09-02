import { describe, expect, it, vi } from "vitest";
import { Readable } from "node:stream";
import {
  createDirectActivityTargetHandler,
  parseDirectActivityTargetCandidate,
  resolveDirectActivityTarget,
  type DirectActivityTargetCandidate,
} from "../direct-activity-target.js";

const AGENT_ID = "octogee-alice-coach";
const AGENT_MM_USER_ID = "aaaaaaaaaaaaaaaaaaaaaaaaaa";
const OWNER_MM_USER_ID = "oooooooooooooooooooooooooo";
const CHANNEL_ID = "dddddddddddddddddddddddddd";
const ROOT_POST_ID = "rrrrrrrrrrrrrrrrrrrrrrrrrr";
const INBOUND_POST_ID = "iiiiiiiiiiiiiiiiiiiiiiiiii";

function candidate(): DirectActivityTargetCandidate {
  return {
    sessionKey: `agent:${AGENT_ID}:mattermost:direct:${OWNER_MM_USER_ID}:thread:${ROOT_POST_ID}`,
    agentId: AGENT_ID,
    ownerUserId: OWNER_MM_USER_ID,
    rootPostId: ROOT_POST_ID,
    inboundPostId: INBOUND_POST_ID,
  };
}

function harness(overrides: {
  inboundUserId?: string;
  rootUserId?: string;
  expectedMemberIds?: string[];
} = {}) {
  const posts = new Map([
    [INBOUND_POST_ID, {
      id: INBOUND_POST_ID,
      channelId: CHANNEL_ID,
      rootId: ROOT_POST_ID,
      userId: overrides.inboundUserId ?? OWNER_MM_USER_ID,
      props: {},
      fileIds: [],
    }],
    [ROOT_POST_ID, {
      id: ROOT_POST_ID,
      channelId: CHANNEL_ID,
      rootId: "",
      userId: overrides.rootUserId ?? OWNER_MM_USER_ID,
      props: {},
      fileIds: [],
    }],
  ]);
  const verifyChannel = vi.fn(async () => 123);
  const deps = {
    resolveAgentIdentity: vi.fn(async () => ({
      agentId: AGENT_ID,
      uid: "uid-alice",
      coachMmUserId: AGENT_MM_USER_ID,
      coachToken: "coach-pat",
      workspaceSlug: "alice",
      projectSlug: "workspace",
    })),
    resolveDirectConversationTarget: vi.fn(async () => ({
      primaryChannelId: CHANNEL_ID,
      channelDocPath: "workspaces/alice/channels/coach-dm",
      expectedChannelTeamId: null,
      expectedChannelName: null,
      expectedChannelType: "D" as const,
      expectedMemberIds: overrides.expectedMemberIds ?? [AGENT_MM_USER_ID, OWNER_MM_USER_ID],
    })),
    mmClientFor: vi.fn(() => ({
      getPost: vi.fn(async (postId: string) => posts.get(postId) ?? null),
    } as never)),
    verifyChannel,
  };
  return { deps, verifyChannel };
}

describe("native direct Activity target resolver", () => {
  it("derives the physical DM from the exact inbound/root posts and verifies the live roster", async () => {
    const { deps, verifyChannel } = harness();

    await expect(resolveDirectActivityTarget(candidate(), deps)).resolves.toEqual({
      sessionKey: candidate().sessionKey,
      agentId: AGENT_ID,
      conversationId: CHANNEL_ID,
      rootPostId: ROOT_POST_ID,
    });
    expect(deps.resolveDirectConversationTarget).toHaveBeenCalledWith(
      AGENT_ID,
      CHANNEL_ID,
      OWNER_MM_USER_ID,
    );
    expect(verifyChannel).toHaveBeenCalledTimes(1);
  });

  it("rejects a post not authored by the owner encoded in the native direct session", async () => {
    const { deps, verifyChannel } = harness({ inboundUserId: "xxxxxxxxxxxxxxxxxxxxxxxxxx" });

    await expect(resolveDirectActivityTarget(candidate(), deps)).resolves.toBeNull();
    expect(deps.resolveDirectConversationTarget).not.toHaveBeenCalled();
    expect(verifyChannel).not.toHaveBeenCalled();
  });

  it("rejects an Agent-authored root beneath an owner-authored inbound reply", async () => {
    const { deps, verifyChannel } = harness({ rootUserId: AGENT_MM_USER_ID });

    await expect(resolveDirectActivityTarget(candidate(), deps)).resolves.toBeNull();
    expect(deps.resolveDirectConversationTarget).not.toHaveBeenCalled();
    expect(verifyChannel).not.toHaveBeenCalled();
  });

  it("rejects a broker target whose members are not exactly the Agent and owner", async () => {
    const { deps, verifyChannel } = harness({
      expectedMemberIds: [AGENT_MM_USER_ID, "xxxxxxxxxxxxxxxxxxxxxxxxxx"],
    });

    await expect(resolveDirectActivityTarget(candidate(), deps)).resolves.toBeNull();
    expect(verifyChannel).not.toHaveBeenCalled();
  });

  it("accepts only a threaded native session with matching owner and root facts", () => {
    expect(parseDirectActivityTargetCandidate(candidate())).toEqual(candidate());
    expect(parseDirectActivityTargetCandidate({
      ...candidate(),
      sessionKey: `agent:${AGENT_ID}:mattermost:direct:${OWNER_MM_USER_ID}`,
    })).toBeNull();
    expect(parseDirectActivityTargetCandidate({
      ...candidate(),
      ownerUserId: "xxxxxxxxxxxxxxxxxxxxxxxxxx",
    })).toBeNull();
    expect(parseDirectActivityTargetCandidate({
      ...candidate(),
      nativeChannelId: "guessed-channel",
    })).toBeNull();
  });

  it("accepts resolver requests only from the authenticated loopback producer", async () => {
    const { deps } = harness();
    const handler = createDirectActivityTargetHandler({ gatewayToken: "gateway-token", deps });
    const invoke = async (authorization: string, remoteAddress: string) => {
      const req = Readable.from([JSON.stringify(candidate())]) as Readable & {
        method: string;
        headers: Record<string, string>;
        socket: { remoteAddress: string };
      };
      req.method = "POST";
      req.headers = { authorization };
      req.socket = { remoteAddress };
      let status = 0;
      let body = "";
      const res = {
        writeHead: vi.fn((nextStatus: number) => { status = nextStatus; }),
        end: vi.fn((value: string) => { body = value; }),
      };
      await handler(req as never, res as never);
      return { status, body: JSON.parse(body) as Record<string, unknown> };
    };

    await expect(invoke("Bearer wrong-token", "127.0.0.1")).resolves.toEqual({
      status: 401,
      body: { error: "unauthorized" },
    });
    await expect(invoke("Bearer gateway-token", "10.0.0.2")).resolves.toEqual({
      status: 401,
      body: { error: "unauthorized" },
    });
    expect(deps.resolveAgentIdentity).not.toHaveBeenCalled();
  });
});
