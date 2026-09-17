import type { Request } from "express";
import { describe, expect, it, vi } from "vitest";

import {
  createAgentSupportTurnVerifier,
  createOwnerWorkspaceTurnVerifier,
  createProjectWorkspaceTurnVerifier,
} from "./openclaw-owner-turn.js";

const REQUESTER_ID = "u".repeat(26);
const CHANNEL_ID = "c".repeat(26);

interface FakeChannel {
  path: string;
  data?: Record<string, unknown>;
}

interface FakeMember {
  mattermostUserId?: string;
  canonicalSource?: string;
  canonicalState?: string;
  mattermostChannelId?: string;
}

const MEMBER_ID = "m".repeat(26);

function activeMember(overrides: FakeMember = {}): FakeMember {
  return {
    mattermostUserId: MEMBER_ID,
    canonicalSource: "mattermost-general",
    canonicalState: "active",
    mattermostChannelId: CHANNEL_ID,
    ...overrides,
  };
}

function fakeDb(input: {
  workspaceOwner?: string;
  coachId?: string;
  channels?: FakeChannel[];
  members?: FakeMember[];
} = {}) {
  const channels = input.channels ?? [];
  const members = input.members ?? [];
  const memberWhere = vi.fn((field: string, _op: string, value: unknown) => ({
    limit: (count: number) => ({
      get: async () => ({
        docs: members
          .filter((member) => member[field as keyof FakeMember] === value)
          .slice(0, count)
          .map((member) => ({ data: () => member })),
      }),
    }),
  }));
  const collection = vi.fn(() => ({ where: memberWhere }));
  const queryGet = vi.fn(async () => ({
    docs: channels.map((channel) => ({
      ref: { path: channel.path },
      data: () => channel.data ?? {},
    })),
  }));
  const limit = vi.fn(() => ({ get: queryGet }));
  const where = vi.fn(() => ({ limit }));
  const collectionGroup = vi.fn(() => ({ where }));
  const db = {
    doc: (path: string) => ({
      get: async () => ({
        exists: path === "workspaces/eggman" && input.workspaceOwner !== undefined,
        data: () => path === "workspaces/eggman"
          ? { ownerUid: input.workspaceOwner, ownerActive: true }
          : path === "agents/uid-eggman" ? { mattermost: { userId: input.coachId } } : undefined,
      }),
    }),
    collectionGroup,
    collection,
  };
  return { db: db as never, collectionGroup, where, limit, collection, memberWhere };
}

function input(
  requestContext: Record<string, unknown> | undefined,
  overrides: Partial<{
    agentId: string;
    ownerUid: string;
    assignedData: Record<string, unknown>;
  }> = {},
) {
  return {
    req: { body: { requestContext } } as Request,
    gatewayId: "builder-gateway",
    agentId: overrides.agentId ?? "octogee-eggman-coach",
    ownerUid: overrides.ownerUid ?? "uid-eggman",
    assignedData: overrides.assignedData ?? {
      workspaceId: "eggman",
      mattermost: { userId: REQUESTER_ID },
    },
  };
}

function context(to: string, overrides: Record<string, unknown> = {}) {
  return {
    channel: "mattermost",
    accountId: "eggman-coach",
    requesterSenderId: REQUESTER_ID,
    nativeChannelId: CHANNEL_ID,
    to,
    ...overrides,
  };
}

describe("createOwnerWorkspaceTurnVerifier", () => {
  it("allows the assigned Builder's direct Coach DM only through the canonical coach-dm channel", async () => {
    const harness = fakeDb({
      workspaceOwner: "uid-eggman",
      channels: [{ path: "workspaces/eggman/channels/coach-dm" }],
    });
    const verify = createOwnerWorkspaceTurnVerifier(harness.db);

    await expect(verify(input(context(`user:${REQUESTER_ID}`)))).resolves.toBe(true);
    expect(harness.where).toHaveBeenCalledWith("mattermost.channelId", "==", CHANNEL_ID);
  });

  it.each(["general", "coach-dm", "launchroom"])(
    "allows the assigned Builder in an active direct workspace %s channel",
    async (channelName) => {
      const harness = fakeDb({
        workspaceOwner: "uid-eggman",
        channels: [{ path: `workspaces/eggman/channels/${channelName}` }],
      });
      const verify = createOwnerWorkspaceTurnVerifier(harness.db);

      await expect(verify(input(context(`channel:${CHANNEL_ID}`)))).resolves.toBe(true);
      expect(harness.collectionGroup).toHaveBeenCalledWith("channels");
      expect(harness.where).toHaveBeenCalledWith("mattermost.channelId", "==", CHANNEL_ID);
      expect(harness.limit).toHaveBeenCalledWith(2);
    },
  );

  it("allows an active workspace member in a workspace channel under the owner's grant", async () => {
    const harness = fakeDb({
      workspaceOwner: "uid-eggman",
      channels: [{ path: "workspaces/eggman/channels/general" }],
      members: [activeMember()],
    });
    const verify = createOwnerWorkspaceTurnVerifier(harness.db);

    await expect(verify(input(context(`channel:${CHANNEL_ID}`, { requesterSenderId: MEMBER_ID })))).resolves.toBe(true);
    expect(harness.collection).toHaveBeenCalledWith("workspaces/eggman/members");
    expect(harness.memberWhere).toHaveBeenCalledWith("mattermostUserId", "==", MEMBER_ID);
  });

  it("does not consult the member mirror for the assigned Builder", async () => {
    const harness = fakeDb({
      workspaceOwner: "uid-eggman",
      channels: [{ path: "workspaces/eggman/channels/general" }],
    });
    const verify = createOwnerWorkspaceTurnVerifier(harness.db);

    await expect(verify(input(context(`channel:${CHANNEL_ID}`)))).resolves.toBe(true);
    expect(harness.collection).not.toHaveBeenCalled();
  });

  it.each([
    ["non-member", []],
    ["revoking member", [activeMember({ canonicalState: "revoking" })]],
    ["member without a canonical Mattermost source", [activeMember({ canonicalSource: "manual" })]],
    ["member missing the canonical channel", [activeMember({ mattermostChannelId: undefined })]],
    ["ambiguous member mapping", [activeMember(), activeMember()]],
  ])("rejects a %s in a workspace channel", async (_label, members) => {
    const harness = fakeDb({
      workspaceOwner: "uid-eggman",
      channels: [{ path: "workspaces/eggman/channels/general" }],
      members,
    });
    const verify = createOwnerWorkspaceTurnVerifier(harness.db);

    await expect(verify(input(context(`channel:${CHANNEL_ID}`, { requesterSenderId: MEMBER_ID })))).resolves.toBe(false);
  });

  it("keeps the coach-dm direct lane for the assigned Builder only", async () => {
    const harness = fakeDb({
      workspaceOwner: "uid-eggman",
      channels: [{ path: "workspaces/eggman/channels/coach-dm" }],
      members: [activeMember()],
    });
    const verify = createOwnerWorkspaceTurnVerifier(harness.db);

    await expect(verify(input(context(`user:${MEMBER_ID}`, { requesterSenderId: MEMBER_ID })))).resolves.toBe(false);
  });

  it("accepts the same exact trusted context from a read-only broker query", async () => {
    const harness = fakeDb({
      workspaceOwner: "uid-eggman",
      channels: [{ path: "workspaces/eggman/channels/general" }],
    });
    const verify = createOwnerWorkspaceTurnVerifier(harness.db);
    const turn = input(undefined);
    turn.req = {
      body: {},
      query: { requestContext: JSON.stringify(context(`channel:${CHANNEL_ID}`)) },
    } as unknown as Request;

    await expect(verify(turn)).resolves.toBe(true);
  });

  it("rejects an ambiguous request with contexts in both the body and query", async () => {
    const harness = fakeDb({
      workspaceOwner: "uid-eggman",
      channels: [{ path: "workspaces/eggman/channels/general" }],
    });
    const verify = createOwnerWorkspaceTurnVerifier(harness.db);
    const turn = input(context(`channel:${CHANNEL_ID}`));
    turn.req.query = {
      requestContext: JSON.stringify(context(`channel:${CHANNEL_ID}`)),
    };

    await expect(verify(turn)).resolves.toBe(false);
  });

  it.each([
    ["missing context", undefined, {}],
    ["wrong provider", context(`user:${REQUESTER_ID}`, { channel: "slack" }), {}],
    ["wrong account", context(`user:${REQUESTER_ID}`, { accountId: "victim-coach" }), {}],
    ["unassigned sender", context(`user:${REQUESTER_ID}`), {
      assignedData: { workspaceId: "eggman", mattermost: { userId: "v".repeat(26) } },
    }],
    ["foreign assigned workspace", context(`user:${REQUESTER_ID}`), {
      assignedData: { workspaceId: "victim", mattermost: { userId: REQUESTER_ID } },
    }],
    ["wrong DM recipient", context(`user:${"v".repeat(26)}`), {}],
    ["missing native channel", context(`user:${REQUESTER_ID}`, { nativeChannelId: undefined }), {}],
    ["invalid native channel", context(`user:${REQUESTER_ID}`, { nativeChannelId: "NOT-A-MM-ID" }), {}],
    ["project agent", context(`user:${REQUESTER_ID}`), { agentId: "octogee-eggman-proj-orbit-coach" }],
    ["claimed owner mismatch", context(`user:${REQUESTER_ID}`), { ownerUid: "uid-victim" }],
    ["invalid requester id", context(`user:${REQUESTER_ID}`, { requesterSenderId: "NOT-A-MM-ID" }), {}],
    ["forged owner flag", context(`user:${REQUESTER_ID}`, { requesterSenderId: "v".repeat(26), senderIsOwner: true }), {}],
    ["extra owner flag", context(`user:${REQUESTER_ID}`, { senderIsOwner: true }), {}],
  ])("rejects %s", async (_label, requestContext, overrides) => {
    const harness = fakeDb({ workspaceOwner: "uid-eggman" });
    const verify = createOwnerWorkspaceTurnVerifier(harness.db);

    await expect(verify(input(requestContext, overrides))).resolves.toBe(false);
  });

  it("rejects when the workspace is missing or belongs to another owner", async () => {
    for (const workspaceOwner of [undefined, "uid-victim"]) {
      const harness = fakeDb({ workspaceOwner });
      const verify = createOwnerWorkspaceTurnVerifier(harness.db);
      await expect(verify(input(context(`user:${REQUESTER_ID}`)))).resolves.toBe(false);
    }
  });

  it("rejects a direct-message route that does not map to coach-dm", async () => {
    const harness = fakeDb({
      workspaceOwner: "uid-eggman",
      channels: [{ path: "workspaces/eggman/channels/general" }],
    });
    const verify = createOwnerWorkspaceTurnVerifier(harness.db);

    await expect(verify(input(context(`user:${REQUESTER_ID}`)))).resolves.toBe(false);
  });

  it("rejects a channel route that does not match the trusted native channel", async () => {
    const harness = fakeDb({
      workspaceOwner: "uid-eggman",
      channels: [{ path: "workspaces/eggman/channels/general" }],
    });
    const verify = createOwnerWorkspaceTurnVerifier(harness.db);

    await expect(verify(input(context(`channel:${"d".repeat(26)}`)))).resolves.toBe(false);
  });

  it.each([
    ["admin", [{ path: "workspaces/eggman/channels/admin" }]],
    ["project", [{ path: "workspaces/eggman/projects/orbit/channels/general" }]],
    ["foreign", [{ path: "workspaces/victim/channels/general" }]],
    ["community", [{ path: "communities/friends/channels/general" }]],
    ["ambiguous", [
      { path: "workspaces/eggman/channels/general" },
      { path: "workspaces/eggman/channels/launchroom" },
    ]],
    ["archived", [{ path: "workspaces/eggman/channels/launchroom", data: { archivedAt: "now" } }]],
    ["archiving", [{
      path: "workspaces/eggman/channels/launchroom",
      data: { archivedAt: true },
    }]],
  ])("rejects a %s channel mapping", async (_label, channels) => {
    const harness = fakeDb({ workspaceOwner: "uid-eggman", channels });
    const verify = createOwnerWorkspaceTurnVerifier(harness.db);

    await expect(verify(input(context(`channel:${CHANNEL_ID}`)))).resolves.toBe(false);
  });
});

describe("createProjectWorkspaceTurnVerifier", () => {
  function projectContext(overrides: Record<string, unknown> = {}) {
    return context(`channel:${CHANNEL_ID}`, {
      accountId: "eggman-proj-orbit",
      ...overrides,
    });
  }

  function projectInput(
    requestContext: Record<string, unknown> | undefined = projectContext(),
    overrides: Partial<{
      agentId: string;
      ownerUid: string;
      assignedData: Record<string, unknown>;
    }> = {},
  ) {
    return input(requestContext, {
      agentId: "octogee-eggman-proj-orbit-coach",
      ...overrides,
    });
  }

  it("allows the assigned Builder only in the project agent's canonical project channel", async () => {
    const harness = fakeDb({
      workspaceOwner: "uid-eggman",
      channels: [{ path: "workspaces/eggman/projects/orbit/channels/general" }],
    });
    const verify = createProjectWorkspaceTurnVerifier(harness.db);

    await expect(verify(projectInput())).resolves.toBe(true);
    expect(harness.where).toHaveBeenCalledWith("mattermost.channelId", "==", CHANNEL_ID);
    expect(harness.limit).toHaveBeenCalledWith(2);
  });

  it("allows an active workspace member in the project agent's canonical project channel", async () => {
    const harness = fakeDb({
      workspaceOwner: "uid-eggman",
      channels: [{ path: "workspaces/eggman/projects/orbit/channels/general" }],
      members: [activeMember()],
    });
    const verify = createProjectWorkspaceTurnVerifier(harness.db);

    await expect(verify(projectInput(projectContext({ requesterSenderId: MEMBER_ID })))).resolves.toBe(true);
    expect(harness.collection).toHaveBeenCalledWith("workspaces/eggman/members");
  });

  it.each([
    ["workspace coach", projectContext(), { agentId: "octogee-eggman-coach" }],
    ["wrong project account", projectContext({ accountId: "eggman-proj-other" }), {}],
    ["wrong assigned Builder", projectContext(), {
      assignedData: { workspaceId: "eggman", mattermost: { userId: "v".repeat(26) } },
    }],
    ["foreign assigned workspace", projectContext(), {
      assignedData: { workspaceId: "victim", mattermost: { userId: REQUESTER_ID } },
    }],
    ["direct message", projectContext({ to: `user:${REQUESTER_ID}` }), {}],
    ["mismatched route", projectContext({ to: `channel:${"d".repeat(26)}` }), {}],
    ["extra field", projectContext({ senderIsOwner: true }), {}],
  ])("rejects a %s", async (_label, requestContext, overrides) => {
    const harness = fakeDb({ workspaceOwner: "uid-eggman" });
    const verify = createProjectWorkspaceTurnVerifier(harness.db);

    await expect(verify(projectInput(requestContext, overrides))).resolves.toBe(false);
  });

  it.each([
    ["workspace channel", "workspaces/eggman/channels/general", {}],
    ["sibling project", "workspaces/eggman/projects/other/channels/general", {}],
    ["foreign project", "workspaces/victim/projects/orbit/channels/general", {}],
    ["archived project channel", "workspaces/eggman/projects/orbit/channels/general", {
      archivedAt: "now",
    }],
  ])("rejects a %s mapping", async (_label, path, data) => {
    const harness = fakeDb({
      workspaceOwner: "uid-eggman",
      channels: [{ path, data }],
    });
    const verify = createProjectWorkspaceTurnVerifier(harness.db);

    await expect(verify(projectInput())).resolves.toBe(false);
  });

  it("rejects an ambiguous channel id mapping", async () => {
    const harness = fakeDb({
      workspaceOwner: "uid-eggman",
      channels: [
        { path: "workspaces/eggman/projects/orbit/channels/general" },
        { path: "workspaces/eggman/projects/other/channels/general" },
      ],
    });
    const verify = createProjectWorkspaceTurnVerifier(harness.db);

    await expect(verify(projectInput())).resolves.toBe(false);
  });
});

it('accepts only the assigned workspace Coach when it delegates in the canonical project channel', async () => {
  const h = fakeDb({ workspaceOwner: 'uid-eggman', coachId: 'b'.repeat(26), channels: [{ path: 'workspaces/eggman/projects/orbit/channels/general' }] });
  const verify = createProjectWorkspaceTurnVerifier(h.db);
  const check = (sender: string) => verify(input(context(`channel:${CHANNEL_ID}`, { accountId: 'eggman-proj-orbit', requesterSenderId: sender }), { agentId: 'octogee-eggman-proj-orbit-coach' }));
  await expect(check('b'.repeat(26))).resolves.toBe(true);
  await expect(check('x'.repeat(26))).resolves.toBe(false);
});

describe("createAgentSupportTurnVerifier", () => {
  it("verifies a project agent through the project lane instead of refusing it as a non-coach", async () => {
    const harness = fakeDb({
      workspaceOwner: "uid-eggman",
      channels: [{ path: "workspaces/eggman/projects/orbit/channels/general" }],
    });
    const verify = createAgentSupportTurnVerifier(harness.db);

    await expect(verify(input(
      context(`channel:${CHANNEL_ID}`, { accountId: "eggman-proj-orbit" }),
      { agentId: "octogee-eggman-proj-orbit-coach" },
    ))).resolves.toBe(true);
  });

  it("still verifies a workspace coach through the owner lane", async () => {
    const harness = fakeDb({
      workspaceOwner: "uid-eggman",
      channels: [{ path: "workspaces/eggman/channels/coach-dm" }],
    });
    const verify = createAgentSupportTurnVerifier(harness.db);

    await expect(verify(input(context(`user:${REQUESTER_ID}`)))).resolves.toBe(true);
  });

  it("refuses a project agent presenting its workspace coach account", async () => {
    const harness = fakeDb({
      workspaceOwner: "uid-eggman",
      channels: [{ path: "workspaces/eggman/projects/orbit/channels/general" }],
    });
    const verify = createAgentSupportTurnVerifier(harness.db);

    await expect(verify(input(
      context(`channel:${CHANNEL_ID}`, { accountId: "eggman-coach" }),
      { agentId: "octogee-eggman-proj-orbit-coach" },
    ))).resolves.toBe(false);
  });

  it("refuses an identity that is neither a coach nor a project agent", async () => {
    const harness = fakeDb({ workspaceOwner: "uid-eggman" });
    const verify = createAgentSupportTurnVerifier(harness.db);

    await expect(verify(input(
      context(`channel:${CHANNEL_ID}`),
      { agentId: "some-other-agent" },
    ))).resolves.toBe(false);
  });
});
