import { describe, expect, it, vi } from "vitest";
import { createBrokeredMattermostAccess } from "./mattermost-broker.js";
import type { OpenClawControlSession } from "./session.js";

const session = {
  sessionId: "7f9b8a1e-429d-4c43-9e1a-9f3bd49d9a70", uid: "owner", gatewayId: "builder", revisionId: "builder",
  workspaceSlug: "alice", brokerProfile: "native-owner", permissionSetIds: [], grantRevision: null,
  idleExpiresAt: 10000, absoluteExpiresAt: 20000,
} satisfies OpenClawControlSession;
const channelId = "a".repeat(26);
const env = { OPENCLAW_CONTROL_BROKER_URL: "https://broker.test", MM_INTERNAL_URL: "http://mattermost.octogee-test.svc.cluster.local:8065" };
const access = { forbidden: false, token: "personal-token-123456", callerMmUserId: "m".repeat(26), target: { ownerUid: "owner", workspaceSlug: "alice", agentId: "ws-alice-coach", agentMmUserId: "b".repeat(26) } };

describe("Mattermost Control UI credential broker", () => {
  it("uses the opaque control session to obtain directory and caller credentials without Firestore", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(Response.json([{ channelId }])).mockResolvedValueOnce(Response.json(access));
    const broker = createBrokeredMattermostAccess(session, { env, fetchImpl });
    expect(await broker.listWorkspaceChannels("alice")).toEqual([{ channelId }]);
    const result = await broker.authorize("owner", channelId, "alice", { requireActiveLedger: true });
    expect(result).toMatchObject({ forbidden: false, callerMmUserId: access.callerMmUserId, client: { getJson: expect.any(Function) } });
    expect(result).not.toHaveProperty("token");
    expect(JSON.parse(fetchImpl.mock.calls[1][1].body)).toEqual({
      gatewayId: "builder", revisionId: "builder", sessionId: session.sessionId, channelId, requireActiveLedger: true,
    });
  });
  it("rejects credentials for a different workspace", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(Response.json({ ...access, target: { ...access.target, workspaceSlug: "victim" } }));
    await expect(createBrokeredMattermostAccess(session, { env, fetchImpl }).authorize("owner", channelId, "alice"))
      .rejects.toThrow(/invalid/i);
  });
  it("retains forbidden channel and unavailable broker failures", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(new Response(null, { status: 403 })).mockResolvedValueOnce(new Response(null, { status: 503 }));
    const broker = createBrokeredMattermostAccess(session, { env, fetchImpl });
    expect(await broker.authorize("owner", channelId, "alice")).toEqual({ forbidden: true });
    await expect(broker.listWorkspaceChannels("alice")).rejects.toThrow(/503/);
  });
});
