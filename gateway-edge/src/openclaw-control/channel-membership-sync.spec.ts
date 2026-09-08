import { describe, expect, it, vi } from "vitest";
import { synchronizeChannelMemberships, type ChannelMembershipRpc } from "./channel-membership-sync.js";

const key = (id: string) => `agent:octogee-alice-coach:mattermost:group:${id.repeat(26)}`;

function gateway(input: { keys?: string[]; members?: Record<string, unknown[]>; incomplete?: boolean; fail?: string } = {}) {
  const call = vi.fn(async (method: string, params: Record<string, unknown>) => {
    if (method === input.fail) return { ok: false as const, reason: "unavailable" };
    const result = method === "sessions.list"
      ? { sessions: (input.keys ?? []).map((sessionKey) => ({ key: sessionKey })), hasMore: input.incomplete ?? false }
      : method === "session.members.listEvidence"
        ? { members: input.members?.[String(params.sessionKey)] ?? [] }
        : { changed: true };
    return { ok: true as const, result };
  });
  return { rpc: { call: call as ChannelMembershipRpc["call"] }, call };
}

const member = { identityId: "member", addedBy: "service" };
const base = { profileId: "member", serviceProfileId: "service" };

describe("Mattermost native session membership projection", () => {
  it("revokes removed channel membership before granting a newly joined channel", async () => {
    const { rpc, call } = gateway({ keys: [key("a")], members: { [key("a")]: [member] } });
    await synchronizeChannelMemberships({ ...base, rpc, authorized: [{ key: key("b"), displayName: "Project" }] });
    expect(call.mock.calls.filter(([method]) => method === "sessions.channel.sync").map(([, params]) => params))
      .toEqual([
        { agentId: "octogee-alice-coach", channel: "mattermost", peerKind: "group", peerId: "a".repeat(26), profileId: "member", member: false },
        { agentId: "octogee-alice-coach", channel: "mattermost", peerKind: "group", peerId: "b".repeat(26), profileId: "member", member: true, displayName: "Project" },
      ]);
  });

  it("does not remove another authority's grants or another person's membership", async () => {
    const { rpc, call } = gateway({ keys: [key("a"), "agent:main:dashboard:private"], members: {
      [key("a")]: [{ ...member, addedBy: "owner" }, { ...member, identityId: "someone-else" }],
    } });
    await synchronizeChannelMemberships({ ...base, rpc, authorized: [] });
    expect(call.mock.calls.map(([method]) => method)).toEqual(["sessions.list", "session.members.listEvidence"]);
  });

  it.each([
    { incomplete: true },
    { fail: "sessions.list" },
    { keys: [key("a")], fail: "session.members.listEvidence" },
  ])("does not grant from an incomplete native directory: %j", async (input) => {
    const { rpc, call } = gateway(input);
    await expect(synchronizeChannelMemberships({ ...base, rpc, authorized: [{ key: key("b") }] })).rejects.toThrow();
    expect(call.mock.calls.some(([method]) => method === "sessions.channel.sync")).toBe(false);
  });

  it("stops before grants if revocation fails", async () => {
    const { rpc, call } = gateway({ keys: [key("a")], members: { [key("a")]: [member] }, fail: "sessions.channel.sync" });
    await expect(synchronizeChannelMemberships({ ...base, rpc, authorized: [{ key: key("b") }] })).rejects.toThrow();
    expect(call.mock.calls.filter(([method]) => method === "sessions.channel.sync")).toHaveLength(1);
    expect(call.mock.calls.at(-1)?.[1].member).toBe(false);
  });
});
